import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { cleanText, normalizeProjectPath, safeId } from "./security.mjs";

const EMPTY_STATE = {
  version: 1,
  activeAccountId: null,
  activeProjectId: null,
  accounts: [],
  projects: [],
  chats: [],
  providers: []
};

function normalizeState(value) {
  const parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const state = { ...structuredClone(EMPTY_STATE), ...parsed };
  for (const field of ["accounts", "projects", "chats", "providers"]) {
    if (!Array.isArray(state[field])) state[field] = [];
  }
  for (const project of state.projects) {
    project.auxiliaryPolicy ||= { autoApprovedProviderIds: [] };
    project.planningWorkflow ||= { mode: "subscription", plannerProviderId: null, reviewerProviderId: null };
    project.planningWorkflow.mode = ["subscription", "api", "none"].includes(project.planningWorkflow.mode)
      ? project.planningWorkflow.mode
      : "subscription";
  }
  for (const provider of state.providers) {
    provider.usage ||= {};
    provider.usage.thinkingTokens ||= 0;
  }
  return state;
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export class Store {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.file = path.join(dataRoot, "state.json");
    this.queue = Promise.resolve();
    this.recovery = null;
  }

  async init() {
    await mkdir(this.dataRoot, { recursive: true });
    try {
      await stat(this.file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.write(EMPTY_STATE);
    }
  }

  async read() {
    await this.init();
    try {
      return normalizeState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return this.recoverInvalidState();
    }
  }

  async recoverInvalidState() {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const raw = await readFile(this.file, "utf8");
      try {
        return normalizeState(JSON.parse(raw));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, backup);
        const cleanState = structuredClone(EMPTY_STATE);
        await this.write(cleanState);
        return cleanState;
      }
    })();
    try {
      return await this.recovery;
    } finally {
      this.recovery = null;
    }
  }

  async write(state) {
    await mkdir(this.dataRoot, { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
    return state;
  }

  mutate(fn) {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async publicState() {
    return this.read();
  }

  addAccount(input) {
    return this.mutate((state) => {
      const account = {
        id: id("account"),
        label: cleanText(input.label, 80) || "Tài khoản Codex",
        email: cleanText(input.email, 180),
        plan: cleanText(input.plan, 40) || "Đang xác định",
        remaining: Math.max(0, Math.min(100, Number(input.remaining) || 100)),
        remainingSource: "manual",
        resetAt: cleanText(input.resetAt, 80),
        status: "available",
        authenticated: false,
        rateLimits: null,
        usageSummary: null,
        dailyUsageBuckets: null,
        lastSyncedAt: null,
        syncError: null,
        expiresAt: cleanText(input.expiresAt, 40),
        note: cleanText(input.note, 1000),
        createdAt: now(),
        updatedAt: now()
      };
      state.accounts.push(account);
      if (!state.activeAccountId) state.activeAccountId = account.id;
      return account;
    });
  }

  updateAccount(accountId, input) {
    return this.mutate((state) => {
      const account = state.accounts.find((item) => item.id === safeId(accountId));
      if (!account) throw new Error("Không tìm thấy tài khoản.");
      if (input.label !== undefined) account.label = cleanText(input.label, 80) || account.label;
      if (input.email !== undefined) account.email = cleanText(input.email, 180);
      if (input.plan !== undefined) account.plan = cleanText(input.plan, 40) || account.plan;
      if (input.remaining !== undefined) {
        account.remaining = Math.max(0, Math.min(100, Number(input.remaining) || 0));
      }
      if (input.resetAt !== undefined) account.resetAt = cleanText(input.resetAt, 80);
      if (input.status !== undefined && ["available", "cooldown", "disabled"].includes(input.status)) {
        account.status = input.status;
      }
      if (input.authenticated !== undefined) account.authenticated = Boolean(input.authenticated);
      if (input.remainingSource !== undefined) {
        account.remainingSource = input.remainingSource === "automatic" ? "automatic" : "manual";
      }
      if (input.rateLimits !== undefined) account.rateLimits = input.rateLimits;
      if (input.usageSummary !== undefined) account.usageSummary = input.usageSummary;
      if (input.dailyUsageBuckets !== undefined) account.dailyUsageBuckets = input.dailyUsageBuckets;
      if (input.lastSyncedAt !== undefined) account.lastSyncedAt = input.lastSyncedAt;
      if (input.syncError !== undefined) account.syncError = cleanText(input.syncError, 2000);
      if (input.expiresAt !== undefined) account.expiresAt = cleanText(input.expiresAt, 40);
      if (input.note !== undefined) account.note = cleanText(input.note, 1000);
      account.updatedAt = now();
      return account;
    });
  }

  deleteAccount(accountId) {
    return this.mutate((state) => {
      const targetId = safeId(accountId);
      const index = state.accounts.findIndex((item) => item.id === targetId);
      if (index < 0) throw new Error("Không tìm thấy tài khoản.");
      const [account] = state.accounts.splice(index, 1);
      if (state.activeAccountId === targetId) {
        state.activeAccountId = state.accounts.find((item) => item.status !== "disabled")?.id || null;
      }
      for (const chat of state.chats) {
        if (chat.accountId === targetId) {
          chat.accountId = null;
          chat.needsBridge = Boolean(chat.threadId || chat.messages?.length);
          chat.updatedAt = now();
        }
        if (chat.handoff?.suggestedAccountId === targetId) {
          chat.handoff.suggestedAccountId = null;
        }
      }
      return account;
    });
  }

  selectAccount(accountId) {
    return this.mutate((state) => {
      const selected = state.accounts.find((item) => item.id === safeId(accountId));
      if (!selected) throw new Error("Không tìm thấy tài khoản.");
      state.activeAccountId = selected.id;
      for (const chat of state.chats) {
        if (chat.accountId && chat.accountId !== selected.id) chat.needsBridge = true;
      }
      return selected;
    });
  }

  ensureGeneralProject(projectPath) {
    return this.mutate((state) => {
      let project = state.projects.find((item) => item.kind === "general" || item.id === "project-general");
      if (!project) {
        project = {
          id: "project-general",
          kind: "general",
          name: "Trò chuyện chung",
          path: projectPath,
          summary: "",
          nextStep: "",
          contextConfig: {
            historyBudget: 48000,
            maxHistoryMessages: 80,
            longChatThreshold: 120,
            strategy: "goal-recent"
          },
          auxiliaryPolicy: {
            autoApprovedProviderIds: []
          },
          planningWorkflow: {
            mode: "subscription",
            plannerProviderId: null,
            reviewerProviderId: null
          },
          createdAt: now(),
          updatedAt: now()
        };
        state.projects.unshift(project);
      } else {
        project.kind = "general";
        project.name = "Trò chuyện chung";
        project.path = projectPath;
      }
      if (!state.activeProjectId || !state.projects.some((item) => item.id === state.activeProjectId)) {
        state.activeProjectId = project.id;
      }
      return project;
    });
  }

  async addProject(input) {
    const projectPath = normalizeProjectPath(input.path);
    const info = await stat(projectPath);
    if (!info.isDirectory()) throw new Error("Đường dẫn dự án không phải thư mục.");
    return this.mutate((state) => {
      const project = {
        id: id("project"),
        name: cleanText(input.name, 100) || path.basename(projectPath),
        path: projectPath,
        summary: cleanText(input.summary, 12000),
        nextStep: cleanText(input.nextStep, 6000),
        contextConfig: {
          historyBudget: 48000,
          maxHistoryMessages: 80,
          longChatThreshold: 120,
          strategy: "goal-recent"
        },
        auxiliaryPolicy: {
          autoApprovedProviderIds: []
        },
        planningWorkflow: {
          mode: "subscription",
          plannerProviderId: null,
          reviewerProviderId: null
        },
        createdAt: now(),
        updatedAt: now()
      };
      state.projects.push(project);
      state.activeProjectId = project.id;
      return project;
    });
  }

  updateProject(projectId, input) {
    return this.mutate((state) => {
      const project = state.projects.find((item) => item.id === safeId(projectId));
      if (!project) throw new Error("Không tìm thấy dự án.");
      if (input.name !== undefined) project.name = cleanText(input.name, 100) || project.name;
      if (input.summary !== undefined) project.summary = cleanText(input.summary, 12000);
      if (input.nextStep !== undefined) project.nextStep = cleanText(input.nextStep, 6000);
      if (input.contextConfig !== undefined) {
        const config = input.contextConfig || {};
        project.contextConfig = {
          historyBudget: Math.max(8000, Math.min(100000, Number(config.historyBudget) || 48000)),
          maxHistoryMessages: Math.max(10, Math.min(200, Number(config.maxHistoryMessages) || 80)),
          longChatThreshold: Math.max(40, Math.min(500, Number(config.longChatThreshold) || 120)),
          strategy: ["recent", "goal-recent"].includes(config.strategy) ? config.strategy : "goal-recent"
        };
      }
      if (input.auxiliaryPolicy !== undefined) {
        const ids = Array.isArray(input.auxiliaryPolicy?.autoApprovedProviderIds)
          ? input.auxiliaryPolicy.autoApprovedProviderIds.map(safeId).filter(Boolean)
          : [];
        project.auxiliaryPolicy = { autoApprovedProviderIds: [...new Set(ids)].slice(0, 50) };
      }
      if (input.planningWorkflow !== undefined) {
        project.planningWorkflow = {
          mode: ["subscription", "api", "none"].includes(input.planningWorkflow?.mode)
            ? input.planningWorkflow.mode
            : project.planningWorkflow?.mode || "subscription",
          plannerProviderId: safeId(input.planningWorkflow?.plannerProviderId) || null,
          reviewerProviderId: safeId(input.planningWorkflow?.reviewerProviderId) || null
        };
      }
      project.updatedAt = now();
      return project;
    });
  }

  selectProject(projectId) {
    return this.mutate((state) => {
      const selected = state.projects.find((item) => item.id === safeId(projectId));
      if (!selected) throw new Error("Không tìm thấy dự án.");
      state.activeProjectId = selected.id;
      return selected;
    });
  }

  createChat(input) {
    return this.mutate((state) => {
      const project = state.projects.find((item) => item.id === safeId(input.projectId));
      if (!project) throw new Error("Không tìm thấy dự án.");
      const chat = {
        id: id("chat"),
        projectId: project.id,
        title: cleanText(input.title, 120) || "Cuộc trò chuyện mới",
        accountId: state.activeAccountId,
        threadId: null,
        needsBridge: false,
        handoff: null,
        status: "ready",
        messages: [],
        upstreamSessions: [],
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        createdAt: now(),
        updatedAt: now()
      };
      state.chats.push(chat);
      return chat;
    });
  }

  appendMessage(chatId, role, content, extra = {}) {
    return this.mutate((state) => {
      const chat = state.chats.find((item) => item.id === safeId(chatId));
      if (!chat) throw new Error("Không tìm thấy cuộc trò chuyện.");
      chat.messages.push({
        id: id("message"),
        role,
        content: cleanText(content, 100000),
        createdAt: now(),
        ...extra
      });
      if (chat.messages.length > 500) chat.messages.splice(0, chat.messages.length - 500);
      chat.updatedAt = now();
      return chat;
    });
  }

  updateChat(chatId, patch) {
    return this.mutate((state) => {
      const chat = state.chats.find((item) => item.id === safeId(chatId));
      if (!chat) throw new Error("Không tìm thấy cuộc trò chuyện.");
      Object.assign(chat, patch, { id: chat.id, updatedAt: now() });
      return chat;
    });
  }

  addUsage(chatId, usage = {}) {
    return this.mutate((state) => {
      const chat = state.chats.find((item) => item.id === safeId(chatId));
      if (!chat) throw new Error("Không tìm thấy cuộc trò chuyện.");
      chat.usage.inputTokens += Number(usage.input_tokens || usage.inputTokens || 0);
      chat.usage.cachedInputTokens += Number(usage.cached_input_tokens || usage.cachedInputTokens || 0);
      chat.usage.outputTokens += Number(usage.output_tokens || usage.outputTokens || 0);
      chat.updatedAt = now();
      return chat.usage;
    });
  }

  addProvider(input) {
    return this.mutate((state) => {
      const type = ["anthropic", "google"].includes(input.type) ? input.type : "openai";
      const defaultLabel = type === "anthropic" ? "Claude API" : type === "google" ? "Gemini API" : "OpenAI API";
      const provider = {
        id: id("provider"),
        type,
        label: cleanText(input.label, 80) || defaultLabel,
        model: cleanText(input.model, 120),
        tokenBudget: Math.max(0, Math.floor(Number(input.tokenBudget) || 0)),
        maxOutputTokens: Math.max(256, Math.min(8192, Number(input.maxOutputTokens) || 2048)),
        enabled: true,
        keyConfigured: false,
        availability: "unknown",
        availableModels: [],
        selectedModelAvailable: null,
        lastCheckedAt: null,
        checkError: null,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
          calls: 0
        },
        createdAt: now(),
        updatedAt: now()
      };
      state.providers.push(provider);
      return provider;
    });
  }

  updateProvider(providerId, input) {
    return this.mutate((state) => {
      const provider = state.providers.find((item) => item.id === safeId(providerId));
      if (!provider) throw new Error("Không tìm thấy API provider.");
      if (input.label !== undefined) provider.label = cleanText(input.label, 80) || provider.label;
      if (input.model !== undefined) provider.model = cleanText(input.model, 120);
      if (input.tokenBudget !== undefined) provider.tokenBudget = Math.max(0, Math.floor(Number(input.tokenBudget) || 0));
      if (input.maxOutputTokens !== undefined) provider.maxOutputTokens = Math.max(256, Math.min(8192, Number(input.maxOutputTokens) || 2048));
      if (input.enabled !== undefined) provider.enabled = Boolean(input.enabled);
      for (const field of ["keyConfigured", "availability", "availableModels", "selectedModelAvailable", "lastCheckedAt", "checkError"]) {
        if (input[field] !== undefined) provider[field] = input[field];
      }
      provider.updatedAt = now();
      return provider;
    });
  }

  addProviderUsage(providerId, usage = {}) {
    return this.mutate((state) => {
      const provider = state.providers.find((item) => item.id === safeId(providerId));
      if (!provider) throw new Error("Không tìm thấy API provider.");
      provider.usage ||= { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, calls: 0 };
      for (const field of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "thinkingTokens", "totalTokens"]) {
        provider.usage[field] = Number(provider.usage[field] || 0) + Number(usage[field] || 0);
      }
      provider.usage.calls = Number(provider.usage.calls || 0) + 1;
      provider.updatedAt = now();
      return provider;
    });
  }
}
