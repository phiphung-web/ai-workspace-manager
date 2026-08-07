import path from "node:path";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { cleanText } from "./security.mjs";
import { redactSecrets } from "./redaction.mjs";

function memoryRoot(projectPath) {
  return path.join(projectPath, ".codex-manager");
}

async function atomicWrite(file, content) {
  const temp = `${file}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

function safe(value, limit = 12000) {
  return redactSecrets(cleanText(value, limit)).text;
}

export async function writeCurrentState({ project, chat, account, repoState, status, nextAction }) {
  const root = memoryRoot(project.path);
  await mkdir(root, { recursive: true });
  const lastAssistant = [...(chat.messages || [])].reverse().find((item) => item.role === "assistant")?.content || "";
  const content = [
    "# Current project state",
    "",
    `Updated: ${new Date().toISOString()}`,
    `Project: ${safe(project.name, 200)}`,
    `Chat: ${safe(chat.title, 200)}`,
    `Primary Codex account: ${safe(account?.label || "unknown", 200)}`,
    `Status: ${safe(status, 200)}`,
    "",
    "## Goal and checkpoint",
    safe(project.summary || chat.title),
    "",
    "## Latest completed work",
    safe(lastAssistant || "No completed assistant response recorded."),
    "",
    "## Next action",
    safe(nextAction || project.nextStep || "Continue the latest task."),
    "",
    "## Git state",
    repoState?.available
      ? `Branch: ${safe(repoState.branch, 200)}\nCommit: ${safe(repoState.commit, 200)}\nWorking tree:\n${safe(repoState.workingTree)}`
      : "Git snapshot unavailable.",
    ""
  ].join("\n");
  await atomicWrite(path.join(root, "CURRENT.md"), content);
}

export async function appendHistory({ project, chat, account, event, detail }) {
  const root = memoryRoot(project.path);
  await mkdir(root, { recursive: true });
  const entry = [
    `## ${new Date().toISOString()} — ${safe(event, 200)}`,
    "",
    `- Chat: ${safe(chat.title, 200)}`,
    `- Codex account: ${safe(account?.label || "unknown", 200)}`,
    `- Detail: ${safe(detail, 6000)}`,
    ""
  ].join("\n");
  await appendFile(path.join(root, "HISTORY.md"), entry, "utf8");
}

export async function appendAIUsage({ project, record }) {
  const root = memoryRoot(project.path);
  const file = path.join(root, "AI_USAGE.json");
  await mkdir(root, { recursive: true });
  let records = [];
  try {
    records = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(records)) records = [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  records.push({ ...record, createdAt: new Date().toISOString() });
  if (records.length > 2000) records = records.slice(-2000);
  await atomicWrite(file, `${JSON.stringify(records, null, 2)}\n`);
}

function planningDocument({ runId, chat, request, planner, reviewer, plan, review, status, result, repoState }) {
  return [
    "# Planning run",
    "",
    `Run: ${safe(runId, 200)}`,
    `Updated: ${new Date().toISOString()}`,
    `Chat: ${safe(chat?.title || "unknown", 200)}`,
    `Status: ${safe(status || "planned", 100)}`,
    "",
    "## Request",
    safe(request, 12000),
    "",
    "## GPT plan",
    `Provider: ${safe(planner?.label || "not available", 200)} / ${safe(planner?.model || "unknown", 200)}`,
    "",
    safe(plan || "GPT planner was not available.", 100000),
    "",
    "## Gemini review and final plan",
    `Provider: ${safe(reviewer?.label || "not available", 200)} / ${safe(reviewer?.model || "unknown", 200)}`,
    "",
    safe(review || "Gemini review was not available.", 100000),
    "",
    "## Codex execution result",
    safe(result || "Pending Codex execution.", 100000),
    "",
    "## Git state after execution",
    repoState?.available
      ? `Branch: ${safe(repoState.branch, 200)}\nCommit: ${safe(repoState.commit, 200)}\nWorking tree:\n${safe(repoState.workingTree)}\n\nDiff stat:\n${safe(repoState.diffStat)}`
      : "Not captured yet.",
    ""
  ].join("\n");
}

export async function writePlanningRun({ project, runId, chat, request, planner, reviewer, plan, review, status = "planned", result = "", repoState = null }) {
  const root = memoryRoot(project.path);
  const plansRoot = path.join(root, "PLANS");
  await mkdir(plansRoot, { recursive: true });
  const content = planningDocument({ runId, chat, request, planner, reviewer, plan, review, status, result, repoState });
  const file = path.join(plansRoot, `${safe(runId, 120).replace(/[^a-z0-9-]/gi, "-")}.md`);
  await atomicWrite(file, content);
  await atomicWrite(path.join(root, "PLAN_CURRENT.md"), content);
  return relativeMemoryFile(project.path, file);
}

function relativeMemoryFile(projectPath, file) {
  return path.relative(projectPath, file).replaceAll("\\", "/");
}
