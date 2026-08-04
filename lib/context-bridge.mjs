import { cleanText } from "./security.mjs";

const DEFAULT_HISTORY_BUDGET = 48_000;
const MAX_HISTORY_MESSAGES = 80;

function messageLabel(role) {
  return role === "user" ? "Người dùng" : "Codex";
}

function historyBeforeCurrentRequest(messages, currentMessage) {
  const history = [...(messages || [])];
  const last = history.at(-1);
  if (last?.role === "user" && cleanText(last.content, 100_000) === currentMessage) {
    history.pop();
  }
  return history;
}

export function selectBridgeHistory(messages, currentMessage, budget = DEFAULT_HISTORY_BUDGET, options = {}) {
  const maxMessages = Math.max(10, Math.min(200, Number(options.maxMessages) || MAX_HISTORY_MESSAGES));
  const allHistory = historyBeforeCurrentRequest(messages, currentMessage);
  const preserveGoal = options.strategy === "goal-recent" && allHistory.length > maxMessages;
  const goal = preserveGoal ? allHistory.find((item) => item.role === "user") : null;
  const goalBlock = goal ? `Mục tiêu ban đầu: ${cleanText(goal.content, 100_000)}` : "";
  const recentBudget = Math.max(1000, budget - (goalBlock ? goalBlock.length + 2 : 0));
  const history = allHistory.slice(-(maxMessages - (goal ? 1 : 0)));
  const selected = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    const block = `${messageLabel(item.role)}: ${cleanText(item.content, 100_000)}`;
    if (selected.length && used + block.length + 2 > recentBudget) break;
    selected.unshift(block.slice(0, Math.max(0, recentBudget - used)));
    used += block.length + 2;
    if (used >= recentBudget) break;
  }
  return [goalBlock, ...selected].filter(Boolean).join("\n\n");
}

export function makeBridgePrompt(project, chat, message, options = {}) {
  const currentMessage = cleanText(message, 60_000);
  const history = selectBridgeHistory(
    chat.messages,
    currentMessage,
    options.historyBudget || project.contextConfig?.historyBudget || DEFAULT_HISTORY_BUDGET,
    {
      maxMessages: options.maxHistoryMessages || project.contextConfig?.maxHistoryMessages,
      strategy: options.strategy || project.contextConfig?.strategy
    }
  );
  const capsule = options.capsule || chat.handoff?.capsule || null;
  const repo = capsule?.repoState;
  const capsuleBlock = capsule ? [
    `Mục tiêu: ${capsule.goal || "Chưa ghi"}`,
    `Tiến độ gần nhất: ${capsule.progress || "Chưa có phản hồi hoàn chỉnh"}`,
    `Trạng thái agent: ${(capsule.currentState || []).join(" → ") || "Không có"}`,
    `Việc đang chờ: ${capsule.pendingActions || currentMessage}`,
    `Lý do bàn giao: ${capsule.reason || "Đổi tài khoản"}`,
    repo?.available
      ? `Git: branch ${repo.branch}; commit ${repo.commit}; working tree:\n${repo.workingTree}\nDiff: ${repo.diffStat}; staged: ${repo.stagedStat}`
      : "Git snapshot không khả dụng; phải tự kiểm tra repository."
  ].join("\n") : "Không có capsule tự động; dùng checkpoint và repository.";

  return [
    "Tiếp tục cùng một công việc Codex sau khi người dùng chuyển sang tài khoản khác.",
    "Đây là upstream session khác, nhưng dashboard, project và chuỗi quyết định vẫn là một.",
    "Trước khi sửa code: đọc AGENTS.md nếu có, kiểm tra git status và git diff, rồi đối chiếu với checkpoint bên dưới.",
    "Repository và Git là nguồn sự thật cho trạng thái file; lịch sử bên dưới là nguồn cho ý định và quyết định.",
    "Không lặp lại công việc đã hoàn thành. Nếu checkpoint mâu thuẫn với repo, nêu rõ mâu thuẫn trước khi tiếp tục.",
    "",
    `Dự án: ${project.name}`,
    `Thư mục: ${project.path}`,
    "",
    "CHECKPOINT - trạng thái hiện tại:",
    project.summary || "Chưa có checkpoint thủ công; hãy suy ra trạng thái từ repository và lịch sử.",
    "",
    "CHECKPOINT - việc tiếp theo:",
    project.nextStep || "Tiếp tục theo yêu cầu mới nhất của người dùng.",
    "",
    "HANDOFF CAPSULE TỰ ĐỘNG:",
    capsuleBlock,
    "",
    "LỊCH SỬ HỘI THOẠI TRƯỚC KHI CHUYỂN TÀI KHOẢN:",
    history || "Chưa có lượt trước.",
    "",
    "YÊU CẦU MỚI (chỉ xử lý một lần):",
    currentMessage
  ].join("\n");
}
