import path from "node:path";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { cleanText, safeId } from "./security.mjs";

const ACTIVE_STATUSES = new Set(["awaiting_gpt", "awaiting_gemini", "reviewing_gemini", "ready_for_codex", "running"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SubscriptionTaskStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, "subscription-tasks");
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  file(taskId) {
    return path.join(this.root, `${safeId(taskId)}.json`);
  }

  async withLock(taskId, operation) {
    await this.init();
    const lock = path.join(this.root, `${safeId(taskId)}.lock`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(lock);
        try {
          return await operation();
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await wait(25);
      }
    }
    throw new Error("Task đang được tiến trình khác cập nhật; hãy thử lại.");
  }

  async create(input) {
    const task = {
      id: `subscription-${randomUUID()}`,
      projectId: safeId(input.projectId),
      projectName: cleanText(input.projectName, 200),
      chatId: safeId(input.chatId),
      chatTitle: cleanText(input.chatTitle, 200),
      request: cleanText(input.request, 60000),
      plannerPrompt: cleanText(input.plannerPrompt, 80000),
      baseContext: cleanText(input.baseContext, 140000),
      filesShared: Array.isArray(input.filesShared) ? input.filesShared.map((file) => cleanText(file, 2000)).slice(0, 100) : [],
      redactions: Array.isArray(input.redactions) ? input.redactions.map((item) => cleanText(item, 100)).slice(0, 100) : [],
      gptPlan: "",
      geminiReview: "",
      status: "awaiting_gpt",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.withLock(task.id, () => this.write(task));
    return task;
  }

  async write(task) {
    await this.init();
    const file = this.file(task.id);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temp, file);
    return task;
  }

  async read(taskId) {
    await this.init();
    try {
      return JSON.parse(await readFile(this.file(taskId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async list({ status = null } = {}) {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const task = await this.read(entry.name.slice(0, -5));
      if (task && (!status || task.status === status)) tasks.push(task);
    }
    return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async update(taskId, updater) {
    return this.withLock(taskId, async () => {
      const task = await this.read(taskId);
      if (!task) throw new Error("Không tìm thấy task subscription.");
      const updated = await updater(structuredClone(task));
      updated.updatedAt = new Date().toISOString();
      return this.write(updated);
    });
  }

  saveGptPlan(taskId, plan) {
    return this.update(taskId, (task) => {
      if (task.status !== "awaiting_gpt") throw new Error(`Task không chờ GPT lập kế hoạch (trạng thái: ${task.status}).`);
      task.gptPlan = cleanText(plan, 100000);
      if (!task.gptPlan) throw new Error("Kế hoạch GPT không được để trống.");
      task.status = "awaiting_gemini";
      return task;
    });
  }

  saveGeminiReview(taskId, review) {
    return this.update(taskId, (task) => {
      if (!["awaiting_gemini", "reviewing_gemini"].includes(task.status)) {
        throw new Error(`Task không chờ Gemini review (trạng thái: ${task.status}).`);
      }
      task.geminiReview = cleanText(review, 120000);
      if (!task.geminiReview) throw new Error("Review Gemini không được để trống.");
      task.status = "ready_for_codex";
      return task;
    });
  }

  setStatus(taskId, status, extra = {}) {
    return this.update(taskId, (task) => ({ ...task, ...extra, status: cleanText(status, 80) }));
  }

  async next(role) {
    const target = role === "reviewer" ? "awaiting_gemini" : "awaiting_gpt";
    return (await this.list({ status: target }))[0] || null;
  }

  static isActive(task) {
    return Boolean(task && ACTIVE_STATUSES.has(task.status));
  }
}
