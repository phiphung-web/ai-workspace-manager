import { spawn } from "node:child_process";
import readline from "node:readline";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWindow(window) {
  if (!window) return null;
  const usedPercent = finiteNumber(window.usedPercent);
  const resetsAt = finiteNumber(window.resetsAt);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins: finiteNumber(window.windowDurationMins),
    resetsAt,
    resetsAtIso: resetsAt ? new Date(resetsAt * 1000).toISOString() : null
  };
}

export function normalizeAccountMetrics(accountResult, limitsResult, usageResult) {
  const rateLimits = limitsResult?.rateLimitsByLimitId?.codex
    || limitsResult?.rateLimits
    || null;
  const primary = normalizeWindow(rateLimits?.primary);
  const secondary = normalizeWindow(rateLimits?.secondary);
  const remainingValues = [primary?.remainingPercent, secondary?.remainingPercent]
    .filter((value) => value !== null && value !== undefined);
  const tightest = [primary, secondary]
    .filter(Boolean)
    .sort((a, b) => (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101))[0] || null;

  return {
    authenticated: Boolean(accountResult?.account),
    planType: accountResult?.account?.planType || accountResult?.planType || null,
    email: accountResult?.account?.email || null,
    remainingPercent: remainingValues.length ? Math.min(...remainingValues) : null,
    resetsAt: tightest?.resetsAtIso || null,
    rateLimits: rateLimits ? {
      limitId: rateLimits.limitId || "codex",
      limitName: rateLimits.limitName || null,
      primary,
      secondary,
      rateLimitReachedType: rateLimits.rateLimitReachedType || null
    } : null,
    usageSummary: usageResult?.summary || null,
    dailyUsageBuckets: usageResult?.dailyUsageBuckets || null
  };
}

export async function readCodexAccountMetrics({ env, codexBin = "codex", timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server"], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = readline.createInterface({ input: child.stdout });
    const results = new Map();
    let stderr = "";
    let settled = false;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) {
        reject(error);
        return;
      }
      resolve(normalizeAccountMetrics(results.get(2), results.get(3), results.get(4)));
    };

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(() => {
      finish(new Error("Codex App Server không trả dữ liệu limit kịp thời."));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000);
    });
    child.on("close", (code) => {
      if (!settled && code !== 0) {
        finish(new Error(stderr.trim() || `Codex App Server kết thúc với mã ${code}.`));
      }
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message || "Không khởi tạo được Codex App Server."));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/read", id: 2, params: { refreshToken: false } });
        send({ method: "account/rateLimits/read", id: 3 });
        send({ method: "account/usage/read", id: 4 });
        return;
      }
      if ([2, 3, 4].includes(message.id)) {
        if (message.error) {
          if (message.id === 3) {
            finish(new Error(message.error.message || "Không đọc được rate limit."));
            return;
          }
          results.set(message.id, null);
        } else {
          results.set(message.id, message.result);
        }
        if ([2, 3, 4].every((id) => results.has(id))) finish();
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "codex_workspace_manager",
          title: "Codex Workspace Manager",
          version: "0.1.0"
        },
        capabilities: {
          optOutNotificationMethods: [
            "account/rateLimits/updated",
            "thread/tokenUsage/updated"
          ]
        }
      }
    });
  });
}
