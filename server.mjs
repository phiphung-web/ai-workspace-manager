import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Store } from "./lib/store.mjs";
import { cleanText, isAllowedOrigin, safeId } from "./lib/security.mjs";
import { readCodexAccountMetrics } from "./lib/app-server-client.mjs";
import { makeBridgePrompt } from "./lib/context-bridge.mjs";
import { buildHandoffCapsule, isQuotaInterruption, suggestHandoffAccount } from "./lib/handoff.mjs";
import { readRepoState } from "./lib/repo-state.mjs";
import { SecretVault } from "./lib/secret-vault.mjs";
import { askProvider, probeProvider } from "./lib/ai-provider-client.mjs";
import { buildAuxiliaryContext } from "./lib/auxiliary-context.mjs";
import { appendAIUsage, appendHistory, writeCurrentState } from "./lib/project-memory.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const dataRoot = path.resolve(process.env.CODEX_MANAGER_DATA_DIR || path.join(here, ".data"));
const profilesRoot = path.join(dataRoot, "profiles");
const archivedProfilesRoot = path.join(dataRoot, "archived-profiles");
const port = Math.max(1024, Math.min(65535, Number(process.env.CODEX_MANAGER_PORT) || 4320));
const host = "127.0.0.1";
const store = new Store(dataRoot);
const secretVault = new SecretVault(dataRoot);
const jobs = new Map();
const codexBin = await findCodexBinary();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function executableFile(file) {
  try {
    const info = await stat(file);
    await access(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findCodexBinary() {
  const configured = cleanText(process.env.CODEX_BIN, 2000);
  if (configured) {
    if (path.isAbsolute(configured) && await executableFile(configured)) return configured;
    if (!path.isAbsolute(configured)) return configured;
  }

  try {
    await execFileAsync("codex", ["--version"], { windowsHide: true, timeout: 5000 });
    return "codex";
  } catch {}

  if (process.platform !== "win32") return null;
  const userRoot = process.env.USERPROFILE || process.env.HOME;
  if (!userRoot) return null;
  const extensionRoots = [
    path.join(userRoot, ".vscode", "extensions"),
    path.join(userRoot, ".vscode-insiders", "extensions")
  ];
  const candidates = [];
  for (const root of extensionRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) continue;
        const file = path.join(root, entry.name, "bin", "windows-x86_64", "codex.exe");
        if (await executableFile(file)) {
          const info = await stat(file);
          candidates.push({ file, modifiedAt: info.mtimeMs });
        }
      }
    } catch {}
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return candidates[0]?.file || null;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  response.end(body);
}

async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Dữ liệu gửi lên quá lớn.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    chatId: job.chatId || null,
    accountId: job.accountId || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    events: job.events.slice(-160),
    error: job.error || null,
    handoff: job.handoff || null,
    approval: job.approval || null,
    auxiliaryReport: job.auxiliaryReport || null,
    approvalMode: job.approvalMode || null
  };
}

function hasRunningJob() {
  return [...jobs.values()].some((job) => ["queued", "running", "awaiting_approval"].includes(job.status));
}

function accountHome(accountId) {
  return path.join(profilesRoot, safeId(accountId));
}

function codexEnvironment(accountId) {
  return {
    ...process.env,
    CODEX_HOME: accountHome(accountId)
  };
}

async function ensureAccountHome(accountId) {
  const home = accountHome(accountId);
  await mkdir(home, { recursive: true });
  return home;
}

async function archiveAccountHome(accountId) {
  const source = accountHome(accountId);
  try {
    const info = await stat(source);
    if (!info.isDirectory()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await mkdir(archivedProfilesRoot, { recursive: true });
  const target = path.join(archivedProfilesRoot, `${safeId(accountId)}-${Date.now()}`);
  await rename(source, target);
  return { source, target };
}

async function refreshAccountMetrics(accountId) {
  await ensureAccountHome(accountId);
  try {
    const metrics = await readCodexAccountMetrics({
      env: codexEnvironment(accountId),
      codexBin
    });
    const plan = metrics.planType
      ? `${metrics.planType.charAt(0).toUpperCase()}${metrics.planType.slice(1)}`
      : undefined;
    return store.updateAccount(accountId, {
      authenticated: metrics.authenticated,
      ...(metrics.email ? { email: metrics.email } : {}),
      ...(plan ? { plan } : {}),
      ...(metrics.remainingPercent !== null ? {
        remaining: metrics.remainingPercent,
        remainingSource: "automatic"
      } : {}),
      resetAt: metrics.resetsAt || "",
      rateLimits: metrics.rateLimits,
      usageSummary: metrics.usageSummary,
      dailyUsageBuckets: metrics.dailyUsageBuckets,
      lastSyncedAt: new Date().toISOString(),
      syncError: ""
    });
  } catch (error) {
    await store.updateAccount(accountId, {
      syncError: cleanText(error.message, 2000),
      lastSyncedAt: new Date().toISOString()
    });
    throw error;
  }
}

async function refreshProvider(providerId) {
  const state = await store.read();
  const provider = state.providers?.find((item) => item.id === safeId(providerId));
  if (!provider) throw new Error("Không tìm thấy API provider.");
  try {
    const result = await probeProvider(provider, await secretVault.get(provider.id));
    return store.updateProvider(provider.id, {
      availability: "available",
      availableModels: result.models,
      selectedModelAvailable: result.selectedModelAvailable,
      lastCheckedAt: new Date().toISOString(),
      checkError: ""
    });
  } catch (error) {
    await store.updateProvider(provider.id, {
      availability: "error",
      lastCheckedAt: new Date().toISOString(),
      checkError: cleanText(error.message, 2000)
    });
    throw error;
  }
}

function pushEvent(job, type, message, extra = {}) {
  job.events.push({
    id: randomUUID(),
    type,
    message: cleanText(message, 10000),
    createdAt: new Date().toISOString(),
    ...extra
  });
  if (job.events.length > 300) job.events.splice(0, job.events.length - 300);
  job.updatedAt = new Date().toISOString();
}

function codexArgs({ threadId, project, message, model, sandbox }) {
  const modelArgs = model ? ["--model", model] : [];
  const sandboxValue = ["read-only", "workspace-write"].includes(sandbox) ? sandbox : "workspace-write";
  if (threadId) {
    return [
      "exec",
      "resume",
      threadId,
      message,
      "--json",
      "--sandbox",
      sandboxValue,
      ...modelArgs
    ];
  }
  return [
    "exec",
    "--json",
    "--sandbox",
    sandboxValue,
    "--cd",
    project.path,
    ...modelArgs,
    message
  ];
}

function runCodexChat({ state, project, chat, message, model, sandbox, auxiliaryProviderId = null, approvalGranted = false, approvalMode = null }) {
  const job = {
    id: randomUUID(),
    type: "chat",
    status: "queued",
    chatId: chat.id,
    accountId: state.activeAccountId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    error: null,
    message,
    model: cleanText(model, 100),
    sandbox: ["read-only", "workspace-write"].includes(sandbox) ? sandbox : "workspace-write",
    handoff: null,
    auxiliaryProviderId: safeId(auxiliaryProviderId),
    process: null
  };
  const requestedAuxiliary = state.providers?.find((item) => item.id === job.auxiliaryProviderId);
  const autoApproved = Boolean(requestedAuxiliary && project.auxiliaryPolicy?.autoApprovedProviderIds?.includes(requestedAuxiliary.id));
  job.approvalMode = requestedAuxiliary ? (approvalMode || (autoApproved ? "auto" : approvalGranted ? "once" : null)) : null;
  if (requestedAuxiliary?.enabled && requestedAuxiliary.keyConfigured && !approvalGranted && !autoApproved) {
    const context = buildAuxiliaryContext({ provider: requestedAuxiliary, project, message });
    const remainingTokens = requestedAuxiliary.tokenBudget > 0
      ? Math.max(0, Number(requestedAuxiliary.tokenBudget) - Number(requestedAuxiliary.usage?.totalTokens || 0))
      : null;
    job.status = "awaiting_approval";
    job.approval = {
      ...context.preview,
      remainingTokens,
      paidApi: true
    };
    job.pendingRun = { state, project, chat, message, model, sandbox, auxiliaryProviderId };
    jobs.set(job.id, job);
    queueMicrotask(() => store.updateChat(chat.id, { status: "awaiting_approval" }).catch(() => {}));
    return job;
  }
  jobs.set(job.id, job);

  queueMicrotask(async () => {
    const bridge = Boolean(chat.needsBridge);
    let prompt = bridge ? makeBridgePrompt(project, chat, message, {
      capsule: chat.handoff?.capsule,
      ...project.contextConfig
    }) : message;
    const auxiliary = state.providers?.find((item) => item.id === job.auxiliaryProviderId);
    if (auxiliary?.enabled && auxiliary.keyConfigured) {
      if (job.approvalMode === "auto") {
        pushEvent(job, "notice", `Tự động cho phép ${auxiliary.label} theo cấu hình project.`, {
          providerId: auxiliary.id,
          model: auxiliary.model
        });
      }
      const remaining = Number(auxiliary.tokenBudget || 0) - Number(auxiliary.usage?.totalTokens || 0);
      if (auxiliary.tokenBudget > 0 && remaining <= 0) {
        pushEvent(job, "warning", `${auxiliary.label} đã hết ngân sách token do tool theo dõi; Codex tiếp tục một mình.`);
      } else {
        try {
          pushEvent(job, "status", `Đang lấy phân tích phụ trợ từ ${auxiliary.label}…`);
          const auxiliaryContext = buildAuxiliaryContext({ provider: auxiliary, project, message });
          const advice = await askProvider(auxiliary, await secretVault.get(auxiliary.id), auxiliaryContext.prompt);
          const updatedProvider = await store.addProviderUsage(auxiliary.id, advice.usage);
          job.auxiliaryReport = {
            providerLabel: auxiliary.label,
            model: auxiliary.model,
            usage: advice.usage,
            remainingTokens: updatedProvider.tokenBudget > 0
              ? Math.max(0, updatedProvider.tokenBudget - updatedProvider.usage.totalTokens)
              : null
          };
          await appendAIUsage({
            project,
            record: {
              chatId: chat.id,
              providerId: auxiliary.id,
              provider: auxiliary.label,
              type: auxiliary.type,
              model: auxiliary.model,
              reason: auxiliaryContext.preview.reason,
              dataItems: auxiliaryContext.preview.dataItems,
              files: auxiliaryContext.preview.files,
              redactions: auxiliaryContext.preview.redactions,
              approved: true,
              usage: advice.usage,
              appliedByCodex: "pending-verification"
            }
          });
          pushEvent(job, "provider", `${auxiliary.label}: ${advice.usage.totalTokens} tokens`, { usage: advice.usage });
          prompt = [
            prompt,
            "",
            `PHÂN TÍCH TỪ AI PHỤ TRỢ (${auxiliary.label} / ${auxiliary.model}):`,
            advice.text,
            "",
            "Hãy tự kiểm tra phân tích trên với repository. Codex vẫn chịu trách nhiệm quyết định, sửa code và chạy test."
          ].join("\n");
        } catch (error) {
          pushEvent(job, "warning", `Không gọi được ${auxiliary.label}: ${error.message}. Codex tiếp tục một mình.`);
          await store.updateProvider(auxiliary.id, {
            availability: "error",
            checkError: cleanText(error.message, 2000),
            lastCheckedAt: new Date().toISOString()
          });
        }
      }
    }
    const accountThread = chat.threadByAccount?.[state.activeAccountId]
      || (chat.accountId === state.activeAccountId ? chat.threadId : null);
    const args = codexArgs({
      threadId: accountThread,
      project,
      message: prompt,
      model,
      sandbox
    });
    job.status = "running";
    pushEvent(job, "status", bridge ? "Đang nối ngữ cảnh sang tài khoản mới…" : "Codex đang làm việc…");
    await store.updateChat(chat.id, { status: "running" });

    await ensureAccountHome(state.activeAccountId);
    if (!codexBin) throw new Error("Không tìm thấy Codex CLI trên máy.");
    const child = spawn(codexBin, args, {
      cwd: project.path,
      env: codexEnvironment(state.activeAccountId),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    job.process = child;
    let stdoutBuffer = "";
    let stderr = "";
    let lastAssistant = "";
    let threadId = null;
    let usage = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          lastAssistant = cleanText(event.item.text, 100000);
          pushEvent(job, "message", lastAssistant);
        } else if (event.type === "item.started" || event.type === "item.completed") {
          const label = event.item?.type?.replaceAll("_", " ") || event.type;
          pushEvent(job, "activity", label);
        } else if (event.type === "turn.completed") {
          usage = event.usage || null;
          pushEvent(job, "status", "Đã hoàn tất lượt.");
        } else if (event.type === "error") {
          pushEvent(job, "error", event.message || "Codex báo lỗi.");
        }
      } catch {
        pushEvent(job, "output", line);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20000);
    });

    child.on("error", async (error) => {
      job.status = "error";
      job.error = error.code === "ENOENT"
        ? "Không tìm thấy Codex CLI. Hãy cài Codex và khởi động lại dashboard."
        : error.message;
      pushEvent(job, "error", job.error);
      await store.updateChat(chat.id, { status: "error" });
    });

    child.on("close", async (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (job.status === "cancelled" || job.status === "error") return;
      if (code !== 0) {
        job.error = cleanText(stderr, 12000) || `Codex kết thúc với mã ${code}.`;
        pushEvent(job, "error", job.error);
        let refreshedAccount = null;
        try {
          refreshedAccount = await refreshAccountMetrics(state.activeAccountId);
        } catch {}
        const quotaInterrupted = isQuotaInterruption({
          error: job.error,
          events: job.events,
          rateLimits: refreshedAccount?.rateLimits
        });
        if (!quotaInterrupted) {
          job.status = "error";
          await store.updateChat(chat.id, { status: "error" });
          return;
        }

        if (lastAssistant) {
          await store.appendMessage(chat.id, "assistant", lastAssistant, { interrupted: true });
        }
        const repoState = await readRepoState(project.path);
        const latestState = await store.read();
        const latestChat = latestState.chats.find((item) => item.id === chat.id) || chat;
        const suggested = suggestHandoffAccount(latestState.accounts, state.activeAccountId);
        const capsule = buildHandoffCapsule({
          project,
          chat: latestChat,
          job,
          repoState,
          reason: job.error
        });
        const handoff = {
          status: "pending",
          sourceAccountId: state.activeAccountId,
          suggestedAccountId: suggested?.id || null,
          pendingMessage: message,
          model: job.model,
          sandbox: job.sandbox,
          auxiliaryProviderId: job.auxiliaryProviderId || null,
          capsule,
          createdAt: new Date().toISOString()
        };
        await store.updateChat(chat.id, {
          status: "needs_handoff",
          needsBridge: true,
          handoff
        });
        try {
          const account = latestState.accounts.find((item) => item.id === state.activeAccountId);
          await writeCurrentState({ project, chat: latestChat, account, repoState, status: "needs_handoff", nextAction: message });
          await appendHistory({ project, chat: latestChat, account, event: "Quota handoff created", detail: `Pending request: ${message}` });
        } catch (error) {
          pushEvent(job, "warning", `Không cập nhật được project memory: ${error.message}`);
        }
        job.status = "needs_handoff";
        job.handoff = handoff;
        pushEvent(job, "warning", suggested
          ? `Limit đã chạm. Có thể tiếp tục bằng ${suggested.label}.`
          : "Limit đã chạm. Chưa có tài khoản đã đăng nhập còn hạn mức.");
        return;
      }
      if (lastAssistant) await store.appendMessage(chat.id, "assistant", lastAssistant);
      const nextSessions = [...(chat.upstreamSessions || [])];
      if (threadId && !nextSessions.some((item) => item.threadId === threadId)) {
        nextSessions.push({
          threadId,
          accountId: state.activeAccountId,
          startedAt: new Date().toISOString()
        });
      }
      const threadByAccount = {
        ...(chat.threadByAccount || {}),
        ...(chat.accountId && chat.threadId ? { [chat.accountId]: chat.threadId } : {}),
        ...(threadId ? { [state.activeAccountId]: threadId } : {})
      };
      await store.updateChat(chat.id, {
        status: "ready",
        accountId: state.activeAccountId,
        threadId: threadId || chat.threadId,
        needsBridge: false,
        handoff: null,
        upstreamSessions: nextSessions,
        threadByAccount
      });
      if (usage) await store.addUsage(chat.id, usage);
      try {
        pushEvent(job, "status", "Đang cập nhật limit tài khoản…");
        await refreshAccountMetrics(state.activeAccountId);
      } catch (error) {
        pushEvent(job, "warning", `Không cập nhật được limit: ${error.message}`);
      }
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      try {
        const completedState = await store.read();
        const completedChat = completedState.chats.find((item) => item.id === chat.id) || chat;
        const account = completedState.accounts.find((item) => item.id === state.activeAccountId);
        const repoState = await readRepoState(project.path);
        await writeCurrentState({ project, chat: completedChat, account, repoState, status: "ready", nextAction: project.nextStep });
        await appendHistory({ project, chat: completedChat, account, event: "Codex turn completed", detail: lastAssistant || "Turn completed without a final message." });
      } catch (error) {
        pushEvent(job, "warning", `Không cập nhật được project memory: ${error.message}`);
      }
    });
  });
  return job;
}

function startAccountLogin(accountId) {
  const job = {
    id: randomUUID(),
    type: "login",
    status: "queued",
    accountId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    error: null,
    process: null
  };
  jobs.set(job.id, job);
  queueMicrotask(async () => {
    job.status = "running";
    pushEvent(job, "status", "Đang mở profile đăng nhập riêng cho tài khoản này…");
    try {
      await ensureAccountHome(accountId);
      pushEvent(job, "status", "Trình duyệt sẽ mở để đăng nhập. Việc này chỉ cần làm một lần.");
      if (!codexBin) throw new Error("Không tìm thấy Codex CLI trên máy.");
      const child = spawn(codexBin, ["login"], {
        env: codexEnvironment(accountId),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      job.process = child;
      child.stdout.on("data", (chunk) => pushEvent(job, "output", chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => pushEvent(job, "output", chunk.toString("utf8")));
      child.on("error", (error) => {
        job.status = "error";
        job.error = error.message;
        pushEvent(job, "error", error.message);
      });
      child.on("close", async (code) => {
        if (job.status === "error" || job.status === "cancelled") return;
        if (code !== 0) {
          await store.updateAccount(accountId, { authenticated: false });
          job.status = "error";
          job.error = `Đăng nhập Codex không hoàn tất (mã ${code}).`;
          pushEvent(job, "error", job.error);
          return;
        }
        await store.updateAccount(accountId, { authenticated: true });
        await store.selectAccount(accountId);
        try {
          await refreshAccountMetrics(accountId);
        } catch (error) {
          pushEvent(job, "warning", `Đã đăng nhập nhưng chưa đọc được limit: ${error.message}`);
        }
        job.status = "completed";
        pushEvent(job, "status", "Đã đăng nhập. Các chat cũ sẽ nối ngữ cảnh ở lượt tiếp theo.");
      });
    } catch (error) {
      job.status = "error";
      job.error = cleanText(error.stderr || error.message, 12000);
      pushEvent(job, "error", job.error);
    }
  });
  return job;
}

async function codexStatus(accountId = null) {
  if (!codexBin) {
    return { installed: false, authenticated: false, text: "Không tìm thấy Codex CLI." };
  }
  try {
    if (!accountId) {
      const { stdout, stderr } = await execFileAsync(codexBin, ["--version"], {
        windowsHide: true,
        timeout: 8000
      });
      return { installed: true, authenticated: false, text: cleanText(stdout || stderr, 2000) };
    }
    await ensureAccountHome(accountId);
    const { stdout, stderr } = await execFileAsync(codexBin, ["login", "status"], {
      env: codexEnvironment(accountId),
      windowsHide: true,
      timeout: 8000
    });
    return { installed: true, authenticated: true, text: cleanText(stdout || stderr, 2000) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { installed: false, authenticated: false, text: "Không tìm thấy Codex CLI." };
    }
    return {
      installed: true,
      authenticated: false,
      text: cleanText(error.stdout || error.stderr || error.message, 2000)
    };
  }
}

async function serveStatic(response, pathname) {
  const requestPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(publicRoot, requestPath);
  if (!file.startsWith(`${publicRoot}${path.sep}`) && file !== path.join(publicRoot, "index.html")) {
    sendJson(response, 403, { error: "Không được phép." });
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(file)] || "application/octet-stream",
      "content-length": content.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    response.end(content);
  } catch (error) {
    sendJson(response, error?.code === "ENOENT" ? 404 : 500, { error: "Không tìm thấy file." });
  }
}

await store.init();
await mkdir(profilesRoot, { recursive: true });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (request.method !== "GET" && !isAllowedOrigin(request.headers.origin, port)) {
      sendJson(response, 403, { error: "Origin không hợp lệ." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const state = await store.read();
      const activeJob = [...jobs.values()].find((job) => ["queued", "running", "awaiting_approval"].includes(job.status));
      sendJson(response, 200, {
        ok: true,
        localOnly: true,
        port,
        dataRoot,
        codex: await codexStatus(state.activeAccountId),
        running: hasRunningJob(),
        activeJob: activeJob ? publicJob(activeJob) : null
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, { state: await store.publicState() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/providers") {
      const body = await readBody(request);
      const apiKey = cleanText(body.apiKey, 4000);
      if (!apiKey) throw new Error("API key không được để trống.");
      const provider = await store.addProvider(body);
      await secretVault.set(provider.id, apiKey);
      sendJson(response, 201, {
        provider: await store.updateProvider(provider.id, { keyConfigured: true })
      });
      return;
    }
    const providerMatch = url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)$/i);
    if (request.method === "PATCH" && providerMatch) {
      const body = await readBody(request);
      const providerId = safeId(providerMatch[1]);
      if (body.apiKey) {
        await secretVault.set(providerId, cleanText(body.apiKey, 4000));
        body.keyConfigured = true;
      }
      delete body.apiKey;
      sendJson(response, 200, { provider: await store.updateProvider(providerId, body) });
      return;
    }
    const providerCheckMatch = url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)\/check$/i);
    if (request.method === "POST" && providerCheckMatch) {
      sendJson(response, 200, { provider: await refreshProvider(providerCheckMatch[1]) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/accounts") {
      sendJson(response, 201, { account: await store.addAccount(await readBody(request)) });
      return;
    }
    const accountMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)$/i);
    if (request.method === "DELETE" && accountMatch) {
      if (hasRunningJob()) {
        sendJson(response, 409, { error: "Hãy đợi tác vụ hiện tại kết thúc trước khi xóa tài khoản." });
        return;
      }
      const accountId = safeId(accountMatch[1]);
      const state = await store.read();
      if (!state.accounts.some((item) => item.id === accountId)) throw new Error("Không tìm thấy tài khoản.");
      const archived = await archiveAccountHome(accountId);
      try {
        const account = await store.deleteAccount(accountId);
        sendJson(response, 200, { account, profileArchived: Boolean(archived) });
      } catch (error) {
        if (archived) await rename(archived.target, archived.source);
        throw error;
      }
      return;
    }
    if (request.method === "PATCH" && accountMatch) {
      sendJson(response, 200, {
        account: await store.updateAccount(accountMatch[1], await readBody(request))
      });
      return;
    }
    const accountLoginMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/login$/i);
    if (request.method === "POST" && accountLoginMatch) {
      if (hasRunningJob()) {
        sendJson(response, 409, { error: "Hãy đợi tác vụ hiện tại kết thúc trước khi đổi tài khoản." });
        return;
      }
      const accountId = safeId(accountLoginMatch[1]);
      const state = await store.read();
      if (!state.accounts.some((item) => item.id === accountId)) throw new Error("Không tìm thấy tài khoản.");
      const status = await codexStatus(accountId);
      if (status.authenticated) {
        await store.updateAccount(accountId, { authenticated: true });
        await store.selectAccount(accountId);
        try {
          await refreshAccountMetrics(accountId);
        } catch {}
        const timestamp = new Date().toISOString();
        const job = {
          id: randomUUID(),
          type: "login",
          status: "completed",
          accountId,
          createdAt: timestamp,
          updatedAt: timestamp,
          events: [{
            id: randomUUID(),
            type: "status",
            message: "Đã chuyển sang profile đăng nhập có sẵn.",
            createdAt: timestamp
          }],
          error: null,
          process: null
        };
        jobs.set(job.id, job);
        sendJson(response, 200, { job: publicJob(job) });
      } else {
        await store.updateAccount(accountId, { authenticated: false });
        sendJson(response, 202, { job: publicJob(startAccountLogin(accountId)) });
      }
      return;
    }
    const accountRefreshMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/refresh$/i);
    if (request.method === "POST" && accountRefreshMatch) {
      if (hasRunningJob()) {
        sendJson(response, 409, { error: "Hãy đợi tác vụ hiện tại kết thúc trước khi làm mới limit." });
        return;
      }
      const accountId = safeId(accountRefreshMatch[1]);
      const state = await store.read();
      if (!state.accounts.some((item) => item.id === accountId)) throw new Error("Không tìm thấy tài khoản.");
      sendJson(response, 200, { account: await refreshAccountMetrics(accountId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      sendJson(response, 201, { project: await store.addProject(await readBody(request)) });
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/i);
    if (request.method === "PATCH" && projectMatch) {
      sendJson(response, 200, {
        project: await store.updateProject(projectMatch[1], await readBody(request))
      });
      return;
    }
    const projectSelectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/select$/i);
    if (request.method === "POST" && projectSelectMatch) {
      sendJson(response, 200, { project: await store.selectProject(projectSelectMatch[1]) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chats") {
      sendJson(response, 201, { chat: await store.createChat(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (hasRunningJob()) {
        sendJson(response, 409, { error: "Đang có một tác vụ chạy. Hãy đợi hoặc dừng tác vụ đó." });
        return;
      }
      const body = await readBody(request);
      const message = cleanText(body.message, 60000);
      if (!message) throw new Error("Tin nhắn không được để trống.");
      const state = await store.read();
      const chat = state.chats.find((item) => item.id === safeId(body.chatId));
      if (!chat) throw new Error("Không tìm thấy cuộc trò chuyện.");
      const project = state.projects.find((item) => item.id === chat.projectId);
      if (!project) throw new Error("Không tìm thấy dự án của cuộc trò chuyện.");
      if (!state.activeAccountId) throw new Error("Hãy thêm và chọn một tài khoản trước.");
      await store.appendMessage(chat.id, "user", message);
      const latestState = await store.read();
      const latestChat = latestState.chats.find((item) => item.id === chat.id);
      const job = runCodexChat({
        state: latestState,
        project,
        chat: latestChat,
        message,
        model: cleanText(body.model, 100),
        sandbox: body.sandbox,
        auxiliaryProviderId: body.auxiliaryProviderId
      });
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }
    const handoffContinueMatch = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/handoff\/continue$/i);
    if (request.method === "POST" && handoffContinueMatch) {
      if (hasRunningJob()) {
        sendJson(response, 409, { error: "Đang có một tác vụ chạy. Hãy đợi hoặc dừng tác vụ đó." });
        return;
      }
      const body = await readBody(request);
      const targetAccountId = safeId(body.accountId);
      const state = await store.read();
      const chat = state.chats.find((item) => item.id === safeId(handoffContinueMatch[1]));
      if (!chat?.handoff || chat.handoff.status !== "pending") {
        throw new Error("Cuộc trò chuyện này không có task đang chờ bàn giao.");
      }
      const target = state.accounts.find((account) => account.id === targetAccountId);
      if (!target || !target.authenticated) throw new Error("Tài khoản đích chưa đăng nhập.");
      if (target.id === chat.handoff.sourceAccountId) throw new Error("Hãy chọn tài khoản khác để tiếp tục.");
      if (target.status === "disabled" || target.rateLimits?.rateLimitReachedType) {
        throw new Error("Tài khoản đích hiện không sẵn sàng.");
      }
      const project = state.projects.find((item) => item.id === chat.projectId);
      if (!project) throw new Error("Không tìm thấy dự án của cuộc trò chuyện.");
      await store.selectAccount(target.id);
      await store.updateChat(chat.id, {
        status: "ready",
        needsBridge: true,
        handoff: { ...chat.handoff, selectedAccountId: target.id }
      });
      const latestState = await store.read();
      const latestChat = latestState.chats.find((item) => item.id === chat.id);
      const job = runCodexChat({
        state: latestState,
        project,
        chat: latestChat,
        message: chat.handoff.pendingMessage,
        model: chat.handoff.model,
        sandbox: chat.handoff.sandbox,
        auxiliaryProviderId: chat.handoff.auxiliaryProviderId
      });
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Không tìm thấy tác vụ." });
        return;
      }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }
    const approveMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/approve$/i);
    if (request.method === "POST" && approveMatch) {
      const approvalJob = jobs.get(approveMatch[1]);
      if (!approvalJob || approvalJob.status !== "awaiting_approval" || !approvalJob.pendingRun) {
        throw new Error("Yêu cầu phê duyệt không còn khả dụng.");
      }
      const approvalBody = await readBody(request);
      const scope = approvalBody.scope === "project" ? "project" : "once";
      if (scope === "project") {
        const pendingProject = approvalJob.pendingRun.project;
        const ids = new Set(pendingProject.auxiliaryPolicy?.autoApprovedProviderIds || []);
        ids.add(approvalJob.approval.providerId);
        const updatedProject = await store.updateProject(pendingProject.id, {
          auxiliaryPolicy: { autoApprovedProviderIds: [...ids] }
        });
        approvalJob.pendingRun.project = updatedProject;
      }
      approvalJob.status = "approved";
      approvalJob.updatedAt = new Date().toISOString();
      const nextJob = runCodexChat({ ...approvalJob.pendingRun, approvalGranted: true, approvalMode: scope === "project" ? "auto" : "once" });
      approvalJob.pendingRun = null;
      sendJson(response, 202, { job: publicJob(nextJob) });
      return;
    }
    const denyMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/deny$/i);
    if (request.method === "POST" && denyMatch) {
      const approvalJob = jobs.get(denyMatch[1]);
      if (!approvalJob || approvalJob.status !== "awaiting_approval" || !approvalJob.pendingRun) {
        throw new Error("Yêu cầu phê duyệt không còn khả dụng.");
      }
      const pending = approvalJob.pendingRun;
      approvalJob.status = "denied";
      approvalJob.updatedAt = new Date().toISOString();
      try {
        await appendAIUsage({
          project: pending.project,
          record: {
            chatId: pending.chat.id,
            providerId: approvalJob.approval?.providerId,
            provider: approvalJob.approval?.providerLabel,
            type: approvalJob.approval?.providerType,
            model: approvalJob.approval?.model,
            reason: approvalJob.approval?.reason,
            dataItems: approvalJob.approval?.dataItems,
            files: approvalJob.approval?.files,
            approved: false,
            usage: null,
            appliedByCodex: false
          }
        });
      } catch {}
      const nextJob = runCodexChat({ ...pending, auxiliaryProviderId: null, approvalGranted: true });
      approvalJob.pendingRun = null;
      sendJson(response, 202, { job: publicJob(nextJob) });
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/i);
    if (request.method === "POST" && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Không tìm thấy tác vụ." });
        return;
      }
      job.status = "cancelled";
      job.process?.kill();
      pushEvent(job, "status", "Đã yêu cầu dừng.");
      if (job.chatId) await store.updateChat(job.chatId, { status: "ready" });
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }
    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: "Không tìm thấy API." });
  } catch (error) {
    sendJson(response, 400, { error: cleanText(error.message, 12000) || "Yêu cầu không hợp lệ." });
  }
});

server.listen(port, host, () => {
  console.log(`AI Workspace Manager: http://${host}:${port}`);
  console.log(`Data: ${dataRoot}`);
});

function shutdown() {
  for (const job of jobs.values()) job.process?.kill();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
