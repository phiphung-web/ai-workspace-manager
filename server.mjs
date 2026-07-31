import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Store } from "./lib/store.mjs";
import { cleanText, isAllowedOrigin, safeId } from "./lib/security.mjs";
import { readCodexAccountMetrics } from "./lib/app-server-client.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const dataRoot = path.resolve(process.env.CODEX_MANAGER_DATA_DIR || path.join(here, ".data"));
const profilesRoot = path.join(dataRoot, "profiles");
const port = Math.max(1024, Math.min(65535, Number(process.env.CODEX_MANAGER_PORT) || 4320));
const host = "127.0.0.1";
const store = new Store(dataRoot);
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
    error: job.error || null
  };
}

function hasRunningJob() {
  return [...jobs.values()].some((job) => ["queued", "running"].includes(job.status));
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

function makeBridgePrompt(state, project, chat, message) {
  const recent = chat.messages
    .slice(-8)
    .map((item) => `${item.role === "user" ? "Người dùng" : "Codex"}: ${item.content}`)
    .join("\n\n");
  return [
    "Tiếp tục một cuộc trò chuyện Codex local sau khi người dùng đổi tài khoản.",
    "Đây vẫn là cùng một cuộc trò chuyện trên dashboard, nhưng là một upstream session mới.",
    "Trước khi sửa code, hãy đọc AGENTS.md nếu có, kiểm tra git status và git diff để xác nhận trạng thái thật.",
    "",
    `Dự án: ${project.name}`,
    `Thư mục: ${project.path}`,
    "",
    "Tóm tắt hiện tại:",
    project.summary || "Chưa có tóm tắt. Hãy suy ra trạng thái từ repository và các tin nhắn gần nhất.",
    "",
    "Việc tiếp theo:",
    project.nextStep || "Tiếp tục theo yêu cầu mới nhất của người dùng.",
    "",
    "Các tin nhắn gần nhất:",
    recent || "Chưa có.",
    "",
    "Yêu cầu mới:",
    message
  ].join("\n");
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

function runCodexChat({ state, project, chat, message, model, sandbox }) {
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
    process: null
  };
  jobs.set(job.id, job);

  queueMicrotask(async () => {
    const bridge = Boolean(chat.needsBridge);
    const prompt = bridge ? makeBridgePrompt(state, project, chat, message) : message;
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
        job.status = "error";
        job.error = cleanText(stderr, 12000) || `Codex kết thúc với mã ${code}.`;
        pushEvent(job, "error", job.error);
        await store.updateChat(chat.id, { status: "error" });
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
      sendJson(response, 200, {
        ok: true,
        localOnly: true,
        port,
        dataRoot,
        codex: await codexStatus(state.activeAccountId),
        running: hasRunningJob()
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, { state: await store.publicState() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/accounts") {
      sendJson(response, 201, { account: await store.addAccount(await readBody(request)) });
      return;
    }
    const accountMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)$/i);
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
        sandbox: body.sandbox
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
  console.log(`Codex Workspace Manager: http://${host}:${port}`);
  console.log(`Data: ${dataRoot}`);
});

function shutdown() {
  for (const job of jobs.values()) job.process?.kill();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
