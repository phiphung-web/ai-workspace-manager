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
import { buildCodexExecutionPrompt, buildPlanningContext, buildReviewPrompt } from "./lib/planning-pipeline.mjs";
import { appendAIUsage, appendHistory, writeCurrentState, writePlanningRun } from "./lib/project-memory.mjs";
import { redactSecrets } from "./lib/redaction.mjs";
import { Store } from "./lib/store.mjs";
import { SubscriptionTaskStore } from "./lib/subscription-task-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-manager-check-"));

const subscriptionStore = new SubscriptionTaskStore(path.join(tempRoot, "subscription-store"));
const subscriptionTask = await subscriptionStore.create({
  projectId: "project-qa",
  projectName: "Project QA",
  chatId: "chat-qa-1",
  chatTitle: "Chat QA",
  request: "Làm tính năng QA",
  plannerPrompt: "Lập kế hoạch QA",
  baseContext: "Context QA",
  filesShared: ["server.mjs"],
  redactions: ["api-key"]
});
if ((await subscriptionStore.next("planner"))?.id !== subscriptionTask.id) {
  throw new Error("Kho task subscription không trả đúng task chờ GPT.");
}
await subscriptionStore.saveGptPlan(subscriptionTask.id, "Kế hoạch GPT QA");
if ((await subscriptionStore.next("reviewer"))?.id !== subscriptionTask.id) {
  throw new Error("Kho task subscription không chuyển đúng sang Gemini review.");
}
await subscriptionStore.saveGeminiReview(subscriptionTask.id, "Review và kế hoạch cuối QA");
if ((await subscriptionStore.read(subscriptionTask.id))?.status !== "ready_for_codex") {
  throw new Error("Kho task subscription không chuyển đúng sang Codex.");
}

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
  if (request.url === "/v1beta/models?pageSize=1000") {
    response.end(JSON.stringify({ models: [{ name: "models/gemini-qa", baseModelId: "gemini-qa", supportedGenerationMethods: ["generateContent"] }] }));
    return;
  }
  if (request.url === "/v1beta/models/gemini-qa:generateContent") {
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Gemini review" }] } }],
      usageMetadata: { promptTokenCount: 300, cachedContentTokenCount: 50, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 350 }
    }));
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
const googleProbe = await probeProvider({ type: "google", model: "gemini-qa", baseUrl: providerMockUrl }, "fake");
const openAIResult = await askProvider({ type: "openai", model: "model-qa", baseUrl: providerMockUrl }, "fake", "review");
const claudeResult = await askProvider({ type: "anthropic", model: "model-qa", baseUrl: providerMockUrl }, "fake", "review");
const googleResult = await askProvider({ type: "google", model: "gemini-qa", baseUrl: providerMockUrl }, "fake", "review");
await new Promise((resolve) => providerMock.close(resolve));
if (!probe.selectedModelAvailable || !googleProbe.selectedModelAvailable || openAIResult.usage.totalTokens !== 120 || claudeResult.usage.totalTokens !== 160 || googleResult.usage.totalTokens !== 350) {
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
await writeFile(path.join(projectRoot, "README.md"), "# QA project\nTOKEN=secret-value\n", "utf8");
await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }), "utf8");

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
const planningContext = await buildPlanningContext({
  planner: { id: "openai", label: "GPT QA", type: "openai", model: "model-qa", maxOutputTokens: 1000 },
  reviewer: { id: "google", label: "Gemini QA", type: "google", model: "gemini-qa", maxOutputTokens: 1000 },
  project: { name: "QA", path: projectRoot, summary: "Kiểm tra pipeline", nextStep: "Review" },
  chat: { messages: [{ role: "assistant", content: "Đã xem cấu trúc" }] },
  message: "Lập kế hoạch sửa package"
});
const reviewPrompt = buildReviewPrompt({
  baseContext: planningContext.baseContext,
  plan: "1. Sửa package.json",
  planner: { label: "GPT QA", model: "model-qa" },
  reviewer: { label: "Gemini QA", model: "gemini-qa" }
});
const codexPrompt = buildCodexExecutionPrompt({
  request: "Sửa package",
  planner: { label: "GPT QA", model: "model-qa" },
  reviewer: { label: "Gemini QA", model: "gemini-qa" },
  plan: "1. Sửa package.json",
  review: "KẾ HOẠCH CUỐI CHO CODEX: kiểm tra test"
});
if (
  !planningContext.preview.files.includes("package.json")
  || planningContext.baseContext.includes("secret-value")
  || !reviewPrompt.includes("KẾ HOẠCH CUỐI CHO CODEX")
  || !codexPrompt.includes("không lập lại kế hoạch từ đầu")
) {
  throw new Error("Pipeline GPT Planner → Gemini Reviewer không chuẩn bị đúng ngữ cảnh.");
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
await writePlanningRun({
  project: memoryProject,
  runId: "planning-qa",
  chat: memoryChat,
  request: "Sửa package",
  planner: { label: "GPT QA", model: "model-qa" },
  reviewer: { label: "Gemini QA", model: "gemini-qa" },
  plan: "Kế hoạch GPT",
  review: "Kế hoạch cuối Gemini",
  status: "completed",
  result: "Codex đã xong",
  repoState: { available: true, branch: "main", commit: "abc", workingTree: "clean", diffStat: "none" }
});
for (const file of ["CURRENT.md", "HISTORY.md", "AI_USAGE.json", "PLAN_CURRENT.md", path.join("PLANS", "planning-qa.md")]) {
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
  const appScript = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  if (appScript.includes("event.currentTarget.reset()")) {
    throw new Error("Submit handler còn đọc event.currentTarget sau await.");
  }
  if (!appScript.includes("/api/folders/pick") || !homeHtml.includes("browse-project-path-fallback")) {
    throw new Error("Thiếu hộp chọn thư mục Windows hoặc phương án duyệt dự phòng.");
  }
  if (!homeHtml.includes("empty-message-input") || !appScript.includes("startChatFromPrompt")) {
    throw new Error("Luồng tạo chat trực tiếp kiểu Codex chưa được tải.");
  }
  if (!homeHtml.includes("planning-mode") || !homeHtml.includes("ChatGPT Plus lập kế hoạch") || !homeHtml.includes("không phát sinh phí API")) {
    throw new Error("Giao diện chưa đặt workflow subscription không API làm mặc định.");
  }
  if (!homeHtml.includes("planner-provider") || !homeHtml.includes("reviewer-provider") || !homeHtml.includes("Google Gemini")) {
    throw new Error("Giao diện chưa có workflow GPT Planner → Gemini Reviewer.");
  }
  const folderData = await request("/api/folders/list", {
    method: "POST",
    body: JSON.stringify({ path: tempRoot })
  });
  if (folderData.currentPath !== path.resolve(tempRoot) || !folderData.directories.some((item) => item.name === "sample-project")) {
    throw new Error("Trình chọn thư mục trong ứng dụng không đọc đúng thư mục cục bộ.");
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

  const stateWithGeneral = await request("/api/state");
  const generalProject = stateWithGeneral.state.projects.find((project) => project.kind === "general");
  if (!generalProject) throw new Error("Không tự tạo workspace trò chuyện chung.");
  const generalChatData = await request("/api/chats", {
    method: "POST",
    body: JSON.stringify({ projectId: generalProject.id, title: "Chat chung kiểm tra" })
  });
  if (!generalChatData.chat.id) throw new Error("Không tạo được chat khi chưa thêm dự án người dùng.");

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
  const geminiProviderData = await request("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      type: "google",
      label: "Gemini QA",
      apiKey: "AIza_test-secret-must-not-appear",
      model: "gemini-qa",
      tokenBudget: 20_000_000,
      maxOutputTokens: 2048
    })
  });
  if (geminiProviderData.provider.type !== "google" || !geminiProviderData.provider.keyConfigured) {
    throw new Error("Không lưu đúng provider Google Gemini.");
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

  const subscriptionData = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      chatId: chatData.chat.id,
      message: "Kiểm tra workflow subscription",
      planningMode: "subscription",
      sandbox: "read-only"
    })
  });
  if (subscriptionData.job.status !== "awaiting_gpt" || !subscriptionData.job.subscriptionTask?.id) {
    throw new Error("Workflow subscription không tạo đúng task chờ ChatGPT Plus.");
  }
  await request(`/api/jobs/${subscriptionData.job.id}/cancel`, { method: "POST", body: "{}" });

  const approvalData = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      chatId: chatData.chat.id,
      message: "Kiểm tra approval gate",
      planningMode: "api",
      plannerProviderId: providerData.provider.id,
      reviewerProviderId: geminiProviderData.provider.id,
      sandbox: "read-only"
    })
  });
  if (
    approvalData.job.status !== "awaiting_approval" ||
    approvalData.job.approval.providerLabel !== "OpenAI QA → Gemini QA" ||
    approvalData.job.approval.providers.length !== 2 ||
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
      auxiliaryPolicy: { autoApprovedProviderIds: [providerData.provider.id, geminiProviderData.provider.id] },
      planningWorkflow: {
        plannerProviderId: providerData.provider.id,
        reviewerProviderId: geminiProviderData.provider.id
      }
    })
  });

  const state = await request("/api/state");
  const savedProject = state.state.projects.find((project) => project.id === projectData.project.id);
  if (
    state.state.accounts.length !== 1 ||
    state.state.projects.length !== 2 ||
    state.state.chats.length !== 2 ||
    savedProject?.nextStep !== "Làm bước B." ||
    savedProject?.contextConfig.historyBudget !== 32000 ||
    savedProject?.auxiliaryPolicy.autoApprovedProviderIds[0] !== providerData.provider.id ||
    savedProject?.planningWorkflow.mode !== "subscription" ||
    savedProject?.planningWorkflow.plannerProviderId !== providerData.provider.id ||
    savedProject?.planningWorkflow.reviewerProviderId !== geminiProviderData.provider.id ||
    state.state.accounts[0].expiresAt !== "2030-12-31T23:59" ||
    state.state.accounts[0].note !== "Gia hạn cuối năm" ||
    state.state.providers.length !== 2 ||
    JSON.stringify(state.state).includes(fakeProviderKey)
  ) {
    throw new Error("Dữ liệu lưu/đọc không nhất quán.");
  }
  const encryptedSecrets = await readFile(path.join(dataRoot, "secrets.json"), "utf8");
  if (encryptedSecrets.includes(fakeProviderKey)) throw new Error("API key bị lưu dạng plaintext.");

  const deletedAccount = await request(`/api/accounts/${accountData.account.id}`, { method: "DELETE" });
  const stateAfterDelete = await request("/api/state");
  if (deletedAccount.account.id !== accountData.account.id || stateAfterDelete.state.accounts.length !== 0) {
    throw new Error("Không xóa đúng tài khoản khỏi workspace.");
  }
  if (stateAfterDelete.state.chats.some((chat) => chat.accountId !== null)) {
    throw new Error("Chat còn tham chiếu tới tài khoản đã xóa.");
  }

  const rejected = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ label: "Không được phép" })
  });
  if (rejected.status !== 403) throw new Error("Kiểm tra origin không chặn request ngoài.");

console.log("OK: server local, folder picker, account, project, chat, context và origin protection.");
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rm(tempRoot, { recursive: true, force: true });
}
