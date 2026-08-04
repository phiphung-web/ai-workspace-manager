import os from "node:os";
import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAccountMetrics, readCodexAccountMetrics } from "./lib/app-server-client.mjs";
import { makeBridgePrompt, selectBridgeHistory } from "./lib/context-bridge.mjs";
import { buildHandoffCapsule, isQuotaInterruption, suggestHandoffAccount } from "./lib/handoff.mjs";
import { askProvider, probeProvider } from "./lib/ai-provider-client.mjs";
import { buildAuxiliaryContext } from "./lib/auxiliary-context.mjs";
import { appendAIUsage, appendHistory, writeCurrentState } from "./lib/project-memory.mjs";
import { redactSecrets } from "./lib/redaction.mjs";
import { Store } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-manager-check-"));

const corruptStateRoot = path.join(tempRoot, "corrupt-state");
await mkdir(corruptStateRoot, { recursive: true });
await writeFile(path.join(corruptStateRoot, "state.json"), "", "utf8");
const recoveredState = await new Store(corruptStateRoot).read();
if (!Array.isArray(recoveredState.accounts) || !Array.isArray(recoveredState.projects)) {
  throw new Error("Store không tự phục hồi state.json rỗng.");
}

const providerMock = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "model-qa" }] }));
    return;
  }
  if (request.url === "/v1/messages") {
    response.end(JSON.stringify({
      content: [{ type: "text", text: "Claude review" }],
      usage: { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 20 }
    }));
    return;
  }
  response.end(JSON.stringify({
    output_text: "OpenAI review",
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20 }
  }));
});
await new Promise((resolve) => providerMock.listen(0, "127.0.0.1", resolve));
const providerMockUrl = `http://127.0.0.1:${providerMock.address().port}`;
const probe = await probeProvider({ type: "openai", model: "model-qa", baseUrl: providerMockUrl }, "fake");
const openAIResult = await askProvider({ type: "openai", model: "model-qa", baseUrl: providerMockUrl }, "fake", "review");
const claudeResult = await askProvider({ type: "anthropic", model: "model-qa", baseUrl: providerMockUrl }, "fake", "review");
await new Promise((resolve) => providerMock.close(resolve));
if (!probe.selectedModelAvailable || openAIResult.usage.totalTokens !== 120 || claudeResult.usage.totalTokens !== 160) {
  throw new Error("Chuẩn hóa availability/token usage của API provider không đúng.");
}

const bridgeHistory = selectBridgeHistory([
  { role: "user", content: "Quyết định A" },
  { role: "assistant", content: "Đã làm A" },
  { role: "user", content: "Làm B" }
], "Làm B");
if (!bridgeHistory.includes("Quyết định A") || bridgeHistory.includes("Làm B")) {
  throw new Error("Context bridge bị thiếu lịch sử hoặc lặp yêu cầu mới.");
}

const bridgePrompt = makeBridgePrompt(
  { name: "QA", path: "C:\\workspace\\qa", summary: "A xong", nextStep: "Làm B" },
  { messages: [{ role: "user", content: "Làm B" }] },
  "Làm B"
);
if ((bridgePrompt.match(/Làm B/g) || []).length !== 2 || !bridgePrompt.includes("Repository và Git")) {
  throw new Error("Context bridge không giữ đúng checkpoint hoặc yêu cầu mới.");
}

if (!isQuotaInterruption({ error: "Usage limit reached. Limit resets tomorrow." })) {
  throw new Error("Không nhận diện được lỗi hết hạn mức.");
}
if (isQuotaInterruption({ error: "Compilation failed: syntax error" })) {
  throw new Error("Lỗi code bị nhận nhầm thành lỗi hạn mức.");
}
const suggested = suggestHandoffAccount([
  { id: "a1", authenticated: true, remaining: 0, status: "available" },
  { id: "a2", authenticated: true, remaining: 35, status: "available" },
  { id: "a3", authenticated: true, remaining: 80, status: "available" },
  { id: "expired", authenticated: true, remaining: 99, status: "available", expiresAt: "2000-01-01T00:00" }
], "a1");
if (suggested?.id !== "a3") throw new Error("Không chọn đúng tài khoản bàn giao tốt nhất.");
const capsule = buildHandoffCapsule({
  project: { summary: "Hoàn tất A", nextStep: "Làm B" },
  chat: { title: "QA", messages: [{ role: "assistant", content: "Đã sửa file A" }] },
  job: { message: "Làm B", events: [{ type: "activity", message: "command execution" }] },
  repoState: { available: true, branch: "main", workingTree: " M file.js" },
  reason: "usage limit reached"
});
if (capsule.currentRequest !== "Làm B" || capsule.repoState.branch !== "main") {
  throw new Error("Handoff capsule không giữ đúng task hoặc Git snapshot.");
}
const longHistory = Array.from({ length: 30 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: index === 0 ? "Mục tiêu gốc quan trọng" : `Lượt ${index}`
}));
const optimizedHistory = selectBridgeHistory(longHistory, "Yêu cầu mới", 8000, {
  maxMessages: 10,
  strategy: "goal-recent"
});
if (!optimizedHistory.includes("Mục tiêu gốc quan trọng") || !optimizedHistory.includes("Lượt 29")) {
  throw new Error("Tối ưu chat dài không giữ mục tiêu gốc và lượt gần nhất.");
}
const dataRoot = path.join(tempRoot, "data");
const projectRoot = path.join(tempRoot, "sample-project");
const port = 4397;
await mkdir(projectRoot, { recursive: true });

const redacted = redactSecrets("API_KEY=super-secret-value Bearer abc.def.ghi");
if (redacted.text.includes("super-secret-value") || !redacted.redactions.length) {
  throw new Error("Bộ lọc secret không che dữ liệu nhạy cảm.");
}
const auxiliaryContext = buildAuxiliaryContext({
  provider: { id: "p1", label: "Claude QA", type: "anthropic", model: "model-qa", maxOutputTokens: 1000 },
  project: { name: "QA", summary: "TOKEN=hidden-value", nextStep: "Review" },
  message: "Kiểm tra kiến trúc"
});
if (auxiliaryContext.prompt.includes("hidden-value") || auxiliaryContext.preview.estimatedMaximumTokens <= 1000) {
  throw new Error("Approval preview không lọc secret hoặc ước tính token sai.");
}
const memoryProject = { name: "QA", path: projectRoot, summary: "Mục tiêu QA", nextStep: "Bước tiếp" };
const memoryChat = { id: "chat-qa", title: "Chat QA", messages: [{ role: "assistant", content: "Đã xong A" }] };
await writeCurrentState({
  project: memoryProject,
  chat: memoryChat,
  account: { label: "Codex A1" },
  repoState: { available: true, branch: "main", commit: "abc", workingTree: "clean" },
  status: "ready",
  nextAction: "Làm B"
});
await appendHistory({ project: memoryProject, chat: memoryChat, account: { label: "Codex A1" }, event: "QA", detail: "Hoàn tất A" });
await appendAIUsage({ project: memoryProject, record: { provider: "Claude QA", approved: true, usage: { totalTokens: 123 } } });
for (const file of ["CURRENT.md", "HISTORY.md", "AI_USAGE.json"]) {
  await readFile(path.join(projectRoot, ".codex-manager", file), "utf8");
}

const normalized = normalizeAccountMetrics(
  { account: { type: "chatgpt", planType: "plus" } },
  {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_900_100_000 }
    }
  },
  { summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [{ date: "2030-01-01" }] }
);
if (
  normalized.remainingPercent !== 40 ||
  normalized.rateLimits.primary.remainingPercent !== 75 ||
  normalized.usageSummary.lifetimeTokens !== 1234 ||
  normalized.dailyUsageBuckets.length !== 1
) {
  throw new Error("Chuẩn hóa dữ liệu rate limit không đúng.");
}

if (process.env.CODEX_MANAGER_LIVE_USAGE_CHECK === "1") {
  const liveMetrics = await readCodexAccountMetrics({ env: process.env });
  if (!liveMetrics.authenticated || !liveMetrics.rateLimits) {
    throw new Error("Codex App Server không trả dữ liệu limit cho tài khoản hiện tại.");
  }
  console.log(`OK live usage: ${liveMetrics.planType || "unknown plan"}, remaining ${liveMetrics.remainingPercent ?? "unknown"}%.`);
}

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: here,
  env: {
    ...process.env,
    ...(process.env.CODEX_MANAGER_TEST_PATH ? { PATH: process.env.CODEX_MANAGER_TEST_PATH } : {}),
    CODEX_MANAGER_PORT: String(port),
    CODEX_MANAGER_DATA_DIR: dataRoot
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
server.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server không khởi động.\n${output}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${port}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${pathname}: HTTP ${response.status}`);
  return data;
}

try {
  await waitForServer();
  const status = await request("/api/status");
  if (!status.localOnly || status.port !== port) throw new Error("Cấu hình local-only không đúng.");
  if (!status.codex.installed) throw new Error("Không phát hiện được Codex CLI trên máy.");

  const home = await fetch(`http://127.0.0.1:${port}/`);
  const homeHtml = await home.text();
  if (!home.ok || !homeHtml.includes("AI Workspace Manager")) {
    throw new Error("Dashboard tĩnh không tải được.");
  }
  if (!home.headers.get("content-security-policy")?.includes("default-src 'self'")) {
    throw new Error("Dashboard thiếu Content Security Policy.");
  }

  const accountData = await request("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      label: "Tài khoản kiểm tra",
      email: "qa@example.com",
      plan: "Plus",
      expiresAt: "2030-12-31T23:59",
      note: "Gia hạn cuối năm"
    })
  });
  if (!accountData.account.id) throw new Error("Không tạo được tài khoản.");

  const fakeProviderKey = "sk-test-secret-must-not-appear-in-state";
  const providerData = await request("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      type: "openai",
      label: "OpenAI QA",
      apiKey: fakeProviderKey,
      model: "model-qa",
      tokenBudget: 10_000_000,
      maxOutputTokens: 1024
    })
  });
  if (!providerData.provider.keyConfigured || providerData.provider.tokenBudget !== 10_000_000) {
    throw new Error("Không lưu đúng metadata API provider.");
  }

  const projectData = await request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Dự án kiểm tra", path: projectRoot })
  });
  if (projectData.project.path !== path.resolve(projectRoot)) throw new Error("Đường dẫn dự án sai.");

  const chatData = await request("/api/chats", {
    method: "POST",
    body: JSON.stringify({ projectId: projectData.project.id, title: "Chat kiểm tra" })
  });
  if (!chatData.chat.id) throw new Error("Không tạo được chat.");

  const approvalData = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      chatId: chatData.chat.id,
      message: "Kiểm tra approval gate",
      auxiliaryProviderId: providerData.provider.id,
      sandbox: "read-only"
    })
  });
  if (
    approvalData.job.status !== "awaiting_approval" ||
    approvalData.job.approval.providerLabel !== "OpenAI QA" ||
    approvalData.job.approval.estimatedMaximumTokens <= 1024
  ) {
    throw new Error("Approval gate không trả đúng bản xem trước AI phụ trợ.");
  }
  await request(`/api/jobs/${approvalData.job.id}/cancel`, { method: "POST", body: "{}" });

  await request(`/api/projects/${projectData.project.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      summary: "Đã hoàn thành bước A.",
      nextStep: "Làm bước B.",
      contextConfig: {
        strategy: "goal-recent",
        maxHistoryMessages: 60,
        historyBudget: 32000,
        longChatThreshold: 100
      },
      auxiliaryPolicy: { autoApprovedProviderIds: [providerData.provider.id] }
    })
  });

  const state = await request("/api/state");
  if (
    state.state.accounts.length !== 1 ||
    state.state.projects.length !== 1 ||
    state.state.chats.length !== 1 ||
    state.state.projects[0].nextStep !== "Làm bước B." ||
    state.state.projects[0].contextConfig.historyBudget !== 32000 ||
    state.state.projects[0].auxiliaryPolicy.autoApprovedProviderIds[0] !== providerData.provider.id ||
    state.state.accounts[0].expiresAt !== "2030-12-31T23:59" ||
    state.state.accounts[0].note !== "Gia hạn cuối năm" ||
    state.state.providers.length !== 1 ||
    JSON.stringify(state.state).includes(fakeProviderKey)
  ) {
    throw new Error("Dữ liệu lưu/đọc không nhất quán.");
  }
  const encryptedSecrets = await readFile(path.join(dataRoot, "secrets.json"), "utf8");
  if (encryptedSecrets.includes(fakeProviderKey)) throw new Error("API key bị lưu dạng plaintext.");

  const rejected = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ label: "Không được phép" })
  });
  if (rejected.status !== 403) throw new Error("Kiểm tra origin không chặn request ngoài.");

  console.log("OK: server local, account, project, chat, context và origin protection.");
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rm(tempRoot, { recursive: true, force: true });
}
