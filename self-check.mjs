import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAccountMetrics, readCodexAccountMetrics } from "./lib/app-server-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-manager-check-"));
const dataRoot = path.join(tempRoot, "data");
const projectRoot = path.join(tempRoot, "sample-project");
const port = 4397;
await mkdir(projectRoot, { recursive: true });

const normalized = normalizeAccountMetrics(
  { account: { type: "chatgpt", planType: "plus" } },
  {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_900_100_000 }
    }
  },
  { summary: { lifetimeTokens: 1234 } }
);
if (
  normalized.remainingPercent !== 40 ||
  normalized.rateLimits.primary.remainingPercent !== 75 ||
  normalized.usageSummary.lifetimeTokens !== 1234
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
  if (!home.ok || !homeHtml.includes("Codex Workspace Manager")) {
    throw new Error("Dashboard tĩnh không tải được.");
  }
  if (!home.headers.get("content-security-policy")?.includes("default-src 'self'")) {
    throw new Error("Dashboard thiếu Content Security Policy.");
  }

  const accountData = await request("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ label: "Tài khoản kiểm tra", email: "qa@example.com", plan: "Plus" })
  });
  if (!accountData.account.id) throw new Error("Không tạo được tài khoản.");

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

  await request(`/api/projects/${projectData.project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ summary: "Đã hoàn thành bước A.", nextStep: "Làm bước B." })
  });

  const state = await request("/api/state");
  if (
    state.state.accounts.length !== 1 ||
    state.state.projects.length !== 1 ||
    state.state.chats.length !== 1 ||
    state.state.projects[0].nextStep !== "Làm bước B."
  ) {
    throw new Error("Dữ liệu lưu/đọc không nhất quán.");
  }

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
