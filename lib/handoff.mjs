import { cleanText } from "./security.mjs";

const QUOTA_PATTERNS = [
  /rate.?limit(?:ed| reached| exceeded)?/i,
  /usage.?limit(?: reached| exceeded)?/i,
  /quota(?: reached| exceeded| exhausted)?/i,
  /too many requests/i,
  /limit resets?/i,
  /insufficient_quota/i
];

export function isQuotaInterruption({ error = "", events = [], rateLimits = null } = {}) {
  if (rateLimits?.rateLimitReachedType) return true;
  const remaining = [rateLimits?.primary?.remainingPercent, rateLimits?.secondary?.remainingPercent]
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number);
  if (remaining.some((value) => value <= 0)) return true;
  const text = [error, ...events.map((event) => event?.message || "")].join("\n");
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

export function accountRemaining(account) {
  const windows = [
    account?.rateLimits?.primary?.remainingPercent,
    account?.rateLimits?.secondary?.remainingPercent
  ].filter((value) => Number.isFinite(Number(value))).map(Number);
  if (windows.length) return Math.min(...windows);
  return Number.isFinite(Number(account?.remaining)) ? Number(account.remaining) : 0;
}

export function isAccountExpired(account, at = Date.now()) {
  if (!account?.expiresAt) return false;
  const expiry = new Date(account.expiresAt.includes("T") ? account.expiresAt : `${account.expiresAt}T23:59:59`);
  return !Number.isNaN(expiry.getTime()) && expiry.getTime() < at;
}

export function suggestHandoffAccount(accounts = [], currentAccountId = null) {
  return accounts
    .filter((account) => account.id !== currentAccountId)
    .filter((account) => account.authenticated && account.status !== "disabled")
    .filter((account) => !isAccountExpired(account))
    .filter((account) => !account.rateLimits?.rateLimitReachedType)
    .map((account) => ({ account, remaining: accountRemaining(account) }))
    .filter((candidate) => candidate.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || String(a.account.label).localeCompare(String(b.account.label)))[0]
    ?.account || null;
}

export function buildHandoffCapsule({ project, chat, job, repoState, reason }) {
  const recentActivity = (job?.events || [])
    .filter((event) => ["activity", "status", "warning", "error"].includes(event.type))
    .slice(-12)
    .map((event) => cleanText(event.message, 500));
  const lastAssistant = [...(chat?.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant")?.content || "";
  return {
    goal: cleanText(project?.summary || chat?.title, 12000),
    currentRequest: cleanText(job?.message, 60000),
    progress: cleanText(lastAssistant, 12000),
    currentState: recentActivity,
    pendingActions: cleanText(project?.nextStep || job?.message, 12000),
    reason: cleanText(reason, 4000),
    repoState: repoState || null,
    createdAt: new Date().toISOString()
  };
}
