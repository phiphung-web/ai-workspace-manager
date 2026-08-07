import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { SubscriptionTaskStore } from "./lib/subscription-task-store.mjs";
import { buildReviewPrompt } from "./lib/planning-pipeline.mjs";
import { cleanText } from "./lib/security.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.AI_WORKSPACE_DATA_DIR || process.env.CODEX_MANAGER_DATA_DIR || path.join(here, ".data"));
const tasks = new SubscriptionTaskStore(dataRoot);
await tasks.init();

const TOOLS = [
  {
    name: "workspace_get_next_planning_task",
    title: "Lấy task chờ GPT lập kế hoạch",
    description: "Dùng trong ChatGPT. Lấy task lâu nhất đang chờ GPT lập kế hoạch cùng context pack đã lọc secret. Sau khi lập kế hoạch, bắt buộc gọi workspace_save_gpt_plan.",
    inputSchema: { type: "object", additionalProperties: false }
  },
  {
    name: "workspace_save_gpt_plan",
    title: "Lưu kế hoạch GPT",
    description: "Lưu kế hoạch hoàn chỉnh do ChatGPT tạo. Task sẽ chuyển sang chờ Gemini review.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID trả về từ workspace_get_next_planning_task" },
        plan: { type: "string", description: "Kế hoạch có file, bước triển khai, rủi ro, test và điều kiện nghiệm thu" }
      },
      required: ["taskId", "plan"],
      additionalProperties: false
    }
  },
  {
    name: "workspace_get_next_review_task",
    title: "Lấy task chờ Gemini review",
    description: "Dùng trong Gemini/Antigravity. Lấy kế hoạch GPT và context dự án đầy đủ để kiểm tra. Sau khi review, bắt buộc gọi workspace_save_gemini_review.",
    inputSchema: { type: "object", additionalProperties: false }
  },
  {
    name: "workspace_save_gemini_review",
    title: "Lưu review Gemini",
    description: "Lưu review cùng kế hoạch cuối đã được Gemini sửa. Tool sẽ tự chuyển task sang Codex.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID trả về từ workspace_get_next_review_task" },
        review: { type: "string", description: "Review và mục KẾ HOẠCH CUỐI CHO CODEX hoàn chỉnh" }
      },
      required: ["taskId", "review"],
      additionalProperties: false
    }
  },
  {
    name: "workspace_get_task_status",
    title: "Xem trạng thái task",
    description: "Xem task đang chờ GPT, chờ Gemini, sẵn sàng cho Codex hay đã hoàn tất.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false
    }
  },
  {
    name: "workspace_get_task_result",
    title: "Lấy kết quả triển khai của Codex",
    description: "Dùng trong ChatGPT hoặc Gemini sau khi Codex hoàn thành. Trả về kết quả, kế hoạch, review, đường dẫn hồ sơ kế hoạch và trạng thái cuối của task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false
    }
  }
];

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    projectId: task.projectId,
    projectName: task.projectName,
    chatId: task.chatId,
    chatTitle: task.chatTitle,
    request: task.request,
    status: task.status,
    filesShared: task.filesShared,
    redactions: task.redactions,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}),
    isError: false
  };
}

async function callTool(name, args = {}) {
  if (name === "workspace_get_next_planning_task") {
    const task = await tasks.next("planner");
    if (!task) return toolResult({ found: false, message: "Không có task nào đang chờ GPT lập kế hoạch." });
    return toolResult({
      found: true,
      task: publicTask(task),
      instructions: "Lập kế hoạch theo prompt dưới đây. Không viết code. Sau đó gọi workspace_save_gpt_plan với đúng taskId.",
      planningPrompt: task.plannerPrompt
    });
  }
  if (name === "workspace_save_gpt_plan") {
    const task = await tasks.saveGptPlan(args.taskId, args.plan);
    return toolResult({ ok: true, task: publicTask(task), message: "Đã lưu kế hoạch GPT. Dashboard sẽ ưu tiên Gemini CLI review nền; nếu CLI chưa sẵn sàng, task sẽ chờ Gemini review qua MCP." });
  }
  if (name === "workspace_get_next_review_task") {
    const task = await tasks.next("reviewer");
    if (!task) return toolResult({ found: false, message: "Không có task nào đang chờ Gemini review." });
    const reviewPrompt = buildReviewPrompt({
      baseContext: task.baseContext,
      plan: task.gptPlan,
      planner: { label: "ChatGPT Plus", model: "ChatGPT" },
      reviewer: { label: "Gemini Pro", model: "Gemini" }
    });
    return toolResult({
      found: true,
      task: publicTask(task),
      instructions: "Review theo prompt dưới đây. Cuối câu trả lời phải có KẾ HOẠCH CUỐI CHO CODEX, sau đó gọi workspace_save_gemini_review.",
      reviewPrompt
    });
  }
  if (name === "workspace_save_gemini_review") {
    const task = await tasks.saveGeminiReview(args.taskId, args.review);
    return toolResult({ ok: true, task: publicTask(task), message: "Đã lưu review Gemini. Dashboard sẽ tự chuyển kế hoạch cuối sang Codex." });
  }
  if (name === "workspace_get_task_status") {
    const task = await tasks.read(args.taskId);
    if (!task) return toolResult({ found: false, message: "Không tìm thấy task." });
    return toolResult({ found: true, task: publicTask(task) });
  }
  if (name === "workspace_get_task_result") {
    const task = await tasks.read(args.taskId);
    if (!task) return toolResult({ found: false, message: "Không tìm thấy task." });
    return toolResult({
      found: true,
      task: publicTask(task),
      plan: task.gptPlan || null,
      review: task.geminiReview || null,
      result: task.result || null,
      artifact: task.artifact || null,
      codexJobId: task.codexJobId || null,
      completedAt: task.completedAt || null,
      note: task.status === "completed"
        ? "Đây là kết quả đã lưu của Codex. Hãy dùng làm checkpoint cho lượt tiếp theo."
        : "Task chưa hoàn tất; dùng workspace_get_task_status để theo dõi."
    });
  }
  throw new Error(`Tool không tồn tại: ${cleanText(name, 200)}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message: cleanText(message, 4000) } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Invalid JSON");
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") {
      const requestedVersion = cleanText(request.params?.protocolVersion, 40);
      respond(request.id, {
        protocolVersion: requestedVersion || "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ai-workspace-manager", title: "AI Workspace Manager", version: "0.2.0" },
        instructions: "ChatGPT lập kế hoạch trước, Gemini review sau. Luôn lưu kết quả bằng tool tương ứng để dashboard tiếp tục với Codex."
      });
      return;
    }
    if (request.method === "ping") {
      respond(request.id, {});
      return;
    }
    if (request.method === "tools/list") {
      respond(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === "tools/call") {
      try {
        respond(request.id, await callTool(request.params?.name, request.params?.arguments || {}));
      } catch (error) {
        respond(request.id, {
          content: [{ type: "text", text: cleanText(error.message, 4000) }],
          isError: true
        });
      }
      return;
    }
    respondError(request.id, -32601, "Method not found");
  } catch (error) {
    respondError(request.id, -32603, error.message || "Internal error");
  }
});
