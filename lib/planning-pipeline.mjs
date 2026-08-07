import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { cleanText } from "./security.mjs";
import { isSensitivePath, redactSecrets } from "./redaction.mjs";
import { readRepoState } from "./repo-state.mjs";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".data", ".codex-manager", "node_modules", "vendor", "dist", "build",
  ".next", ".nuxt", ".venv", "venv", "coverage", "target", "bin", "obj"
]);
const PRIORITY_FILES = new Set([
  "agents.md", "readme.md", "package.json", "package-lock.json", "pnpm-lock.yaml",
  "yarn.lock", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml", "tsconfig.json",
  "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs"
]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".scss", ".html", ".vue", ".svelte", ".py", ".go", ".rs",
  ".java", ".kt", ".cs", ".php", ".rb", ".sh", ".ps1", ".sql", ".toml",
  ".yaml", ".yml", ".xml", ".env.example"
]);

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function keywords(message) {
  return [...new Set(String(message || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 30))];
}

async function walkProject(root, limit = 700) {
  const files = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const directory = queue.shift();
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) queue.push(absolute);
      } else if (entry.isFile() && !isSensitivePath(relative)) {
        files.push(relative);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

function changedPaths(repoState) {
  if (!repoState?.available) return [];
  return String(repoState.workingTree || "")
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim().split(" -> ").at(-1))
    .filter(Boolean);
}

function chooseFiles(allFiles, message, repoState, limit = 18) {
  const terms = keywords(message);
  const changed = new Set(changedPaths(repoState).map((file) => file.replaceAll("\\", "/").toLowerCase()));
  return allFiles
    .map((file) => {
      const lower = file.toLowerCase();
      const base = path.basename(lower);
      let score = 0;
      if (changed.has(lower)) score += 100;
      if (PRIORITY_FILES.has(base)) score += 50;
      for (const term of terms) if (lower.includes(term)) score += 8;
      if (lower.startsWith("src/") || lower.startsWith("lib/") || lower.startsWith("app/")) score += 2;
      return { file, score };
    })
    .filter(({ file, score }) => score > 0 && (PRIORITY_FILES.has(path.basename(file).toLowerCase()) || TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file, "en"))
    .slice(0, limit)
    .map(({ file }) => file);
}

async function readSelectedFiles(root, files, characterBudget) {
  const sections = [];
  const includedFiles = [];
  const redactions = [];
  let used = 0;
  for (const file of files) {
    if (used >= characterBudget) break;
    try {
      const absolute = path.resolve(root, file);
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
      const info = await stat(absolute);
      if (!info.isFile() || info.size > 180_000) continue;
      const raw = await readFile(absolute, "utf8");
      if (raw.includes("\0")) continue;
      const remaining = characterBudget - used;
      const clipped = cleanText(raw, Math.min(remaining, 20_000));
      const safe = redactSecrets(clipped);
      sections.push(`### ${file}\n\n${safe.text}`);
      includedFiles.push(file);
      redactions.push(...safe.redactions);
      used += safe.text.length;
    } catch {}
  }
  return { text: sections.join("\n\n"), includedFiles, redactions: [...new Set(redactions)] };
}

function recentConversation(chat, currentMessage) {
  const messages = [...(chat?.messages || [])];
  if (messages.at(-1)?.role === "user" && messages.at(-1)?.content === currentMessage) messages.pop();
  return messages.slice(-12).map((item) => `${item.role === "user" ? "User" : "Codex"}: ${cleanText(item.content, 3000)}`).join("\n\n") || "Chưa có trao đổi trước đó.";
}

function repoSummary(repoState) {
  if (!repoState?.available) return `Không đọc được Git: ${repoState?.error || "unknown"}`;
  return [
    `Branch: ${repoState.branch}`,
    `Commit: ${repoState.commit}`,
    `Working tree:\n${repoState.workingTree}`,
    `Diff stat:\n${repoState.diffStat}`,
    `Staged stat:\n${repoState.stagedStat}`
  ].join("\n\n");
}

export async function buildPlanningContext({ planner, reviewer, project, chat, message }) {
  const repoState = await readRepoState(project.path);
  const allFiles = await walkProject(project.path);
  const selected = chooseFiles(allFiles, message, repoState);
  const fileContext = await readSelectedFiles(project.path, selected, 72_000);
  const common = redactSecrets([
    `# Dự án\nTên: ${project.name}\nĐường dẫn chỉ để định vị cục bộ: ${project.path}`,
    `# Mục tiêu/checkpoint\n${project.summary || "Chưa ghi"}`,
    `# Việc tiếp theo đã lưu\n${project.nextStep || "Chưa ghi"}`,
    `# Yêu cầu hiện tại\n${message}`,
    `# Trao đổi gần nhất\n${recentConversation(chat, message)}`,
    `# Trạng thái Git\n${repoSummary(repoState)}`,
    `# Cây file (${allFiles.length}${allFiles.length >= 700 ? "+" : ""} file)\n${allFiles.join("\n")}`,
    `# Nội dung file được chọn\n${fileContext.text || "Không có file văn bản phù hợp để đính kèm."}`
  ].join("\n\n"));
  const baseContext = cleanText(common.text, 115_000);
  const redactions = [...new Set([...common.redactions, ...fileContext.redactions])];
  const plannerPrompt = cleanText([
    "Bạn là GPT Planner. Hãy lập kế hoạch triển khai để Codex thực hiện, chưa viết code và không tuyên bố đã chạy lệnh.",
    "Chỉ dựa trên ngữ cảnh được cung cấp. Nêu rõ giả định nào cần Codex xác minh với repository.",
    "Trả về đúng các mục: Hiểu yêu cầu; Giả định; File cần kiểm tra/sửa; Các bước triển khai; Rủi ro và edge cases; Test; Điều kiện nghiệm thu.",
    "Kế hoạch phải cụ thể, có thứ tự và tránh yêu cầu Codex khảo sát lại toàn bộ dự án.",
    baseContext.slice(0, 62_000)
  ].join("\n\n"), 70_000);
  return {
    baseContext,
    plannerPrompt,
    repoState,
    preview: {
      providerId: planner?.id || null,
      providerLabel: [planner?.label, reviewer?.label].filter(Boolean).join(" → "),
      providerType: "planning-pipeline",
      model: [planner?.model, reviewer?.model].filter(Boolean).join(" → "),
      reason: "GPT lập kế hoạch, Gemini kiểm tra bằng ngữ cảnh dự án rồi Codex mới triển khai.",
      dataItems: ["Tên và đường dẫn project cục bộ", "Yêu cầu hiện tại", "Checkpoint", "Trao đổi gần nhất", "Cây file", "Git status/diff stat", "Nội dung file liên quan"],
      files: fileContext.includedFiles,
      estimatedInputTokens: Math.ceil((plannerPrompt.length + baseContext.length) / 4),
      maxOutputTokens: Number(planner?.maxOutputTokens || 0) + Number(reviewer?.maxOutputTokens || 0),
      estimatedMaximumTokens: Math.ceil((plannerPrompt.length + baseContext.length) / 4)
        + Number(planner?.maxOutputTokens || 0) + Number(reviewer?.maxOutputTokens || 0),
      redactions,
      providers: [planner, reviewer].filter(Boolean).map((provider) => ({
        id: provider.id,
        label: provider.label,
        type: provider.type,
        model: provider.model,
        role: provider.id === planner?.id ? "planner" : "reviewer"
      }))
    }
  };
}

export function buildReviewPrompt({ baseContext, plan, planner, reviewer }) {
  return cleanText([
    "Bạn là Gemini Reviewer. GPT đã lập kế hoạch; nhiệm vụ của bạn là kiểm tra kế hoạch với toàn bộ ngữ cảnh dự án bên dưới.",
    "Tìm giả định sai, file bị bỏ sót, rủi ro, edge case, bước test và điều kiện nghiệm thu còn thiếu.",
    "Không viết code và không tuyên bố đã chạy lệnh. Không tranh luận dài dòng.",
    "Cuối câu trả lời phải có mục `KẾ HOẠCH CUỐI CHO CODEX` chứa một kế hoạch hoàn chỉnh, tự đủ thông tin để Codex thực hiện.",
    `Planner: ${planner.label} / ${planner.model}`,
    `Reviewer: ${reviewer.label} / ${reviewer.model}`,
    `# Kế hoạch GPT\n${plan}`,
    `# Ngữ cảnh dự án để kiểm tra\n${baseContext}`
  ].join("\n\n"), 180_000);
}

export function buildCodexExecutionPrompt({ request, planner, reviewer, plan, review }) {
  return cleanText([
    request,
    "",
    "QUY TRÌNH LẬP KẾ HOẠCH ĐÃ HOÀN TẤT:",
    `- GPT Planner: ${planner.label} / ${planner.model}`,
    `- Gemini Reviewer: ${reviewer.label} / ${reviewer.model}`,
    "",
    "KẾ HOẠCH GPT BAN ĐẦU:",
    plan,
    "",
    "REVIEW VÀ KẾ HOẠCH CUỐI CỦA GEMINI:",
    review,
    "",
    "Hãy kiểm tra nhanh các giả định quan trọng với repository. Nếu đúng, triển khai ngay theo kế hoạch cuối; không lập lại kế hoạch từ đầu. Nếu có điểm sai, điều chỉnh tối thiểu và báo rõ. Codex chịu trách nhiệm sửa code, chạy test và báo kết quả thực tế."
  ].join("\n"), 240_000);
}
