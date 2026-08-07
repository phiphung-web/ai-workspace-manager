const app = {
  state: null,
  activeChatId: null,
  activeJobId: null,
  switchAccountId: null,
  editAccountId: null,
  editProviderId: null,
  pollTimer: null,
  toastTimer: null,
  usageRefreshTimer: null,
  usageRefreshing: false,
  lastUsageRefreshAt: 0,
  folderPath: "",
  folderParentPath: null,
  shownSubscriptionTaskId: null
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function compactNumber(value) {
  return new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatReset(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(minutes) {
  if (!Number.isFinite(Number(minutes))) return "cửa sổ";
  const value = Number(minutes);
  if (value % 1440 === 0) return `${value / 1440} ngày`;
  if (value % 60 === 0) return `${value / 60} giờ`;
  return `${value} phút`;
}

function quotaWindow(label, window) {
  if (!window) return null;
  const row = node("div", "quota-window");
  const remaining = Number.isFinite(Number(window.remainingPercent))
    ? Math.max(0, Math.min(100, Number(window.remainingPercent)))
    : null;
  const title = node("span", "", `${label} ${formatDuration(window.windowDurationMins)}`);
  const value = node("strong", "", remaining === null ? "—" : `${Math.round(remaining)}% còn`);
  const reset = node("small", "", window.resetsAtIso ? `đặt lại ${formatReset(window.resetsAtIso)}` : "chưa có thời điểm đặt lại");
  row.append(title, value, reset);
  return row;
}

function expiryMeta(expiresAt) {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt.includes("T") ? expiresAt : `${expiresAt}T23:59:59`);
  if (Number.isNaN(expiry.getTime())) return null;
  const days = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
  if (days < 0) return { text: `Đã hết hạn ${formatReset(expiry)}`, expired: true };
  if (days === 0) return { text: "Hết hạn hôm nay", expired: false };
  return { text: `Hết hạn ${formatReset(expiry)} · còn ${days} ngày`, expired: false };
}

function openAccountDialog(account = null) {
  app.editAccountId = account?.id || null;
  $("#account-dialog-eyebrow").textContent = account ? "Chỉnh sửa tài khoản" : "Tài khoản Codex";
  $("#account-dialog-title").textContent = account ? account.label : "Thêm tài khoản";
  $("#save-account").textContent = account ? "Lưu thay đổi" : "Lưu và đăng nhập";
  $("#delete-account").classList.toggle("hidden", !account);
  $("#account-label").value = account?.label || "";
  $("#account-email").value = account?.email || "";
  $("#account-expires-at").value = account?.expiresAt || "";
  $("#account-note").value = account?.note || "";
  $("#account-dialog").showModal();
}

function openProviderDialog(provider = null) {
  app.editProviderId = provider?.id || null;
  $("#provider-dialog-eyebrow").textContent = provider ? "Cấu hình trợ lý" : "Trợ lý chuyên biệt";
  $("#provider-dialog-title").textContent = provider ? provider.label : "Kết nối API nâng cao";
  $("#save-provider").textContent = provider ? "Lưu thay đổi" : "Lưu cấu hình";
  $("#provider-type").value = provider?.type || "openai";
  $("#provider-type").disabled = Boolean(provider);
  $("#provider-label").value = provider?.label || "";
  $("#provider-key").value = "";
  $("#provider-key").required = !provider;
  $("#provider-key").placeholder = provider ? "Để trống để giữ API key hiện tại" : "";
  $("#provider-model").value = provider?.model || "";
  $("#provider-budget").value = provider?.tokenBudget || "";
  $("#provider-max-output").value = provider?.maxOutputTokens || 2048;
  $("#provider-dialog").showModal();
}

function activeProject() {
  return app.state?.projects.find((item) => item.id === app.state.activeProjectId) || null;
}

function activeAccount() {
  return app.state?.accounts.find((item) => item.id === app.state.activeAccountId) || null;
}

function activeChat() {
  return app.state?.chats.find((item) => item.id === app.activeChatId) || null;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderAccounts() {
  const list = $("#account-list");
  list.replaceChildren();
  for (const account of app.state.accounts) {
    const card = node("div", `account-card${account.id === app.state.activeAccountId ? " active" : ""}`);
    card.role = "button";
    card.tabIndex = 0;
    card.title = account.id === app.state.activeAccountId ? "Tài khoản đang hoạt động" : "Chuyển sang tài khoản này";

    const expiry = expiryMeta(account.expiresAt);
    const exhausted = Number(account.remaining) <= 0 || Boolean(account.rateLimits?.rateLimitReachedType) || expiry?.expired;
    const dot = node("span", `status-dot ${account.status === "available" && !exhausted ? "online" : "warning"}`);
    const main = node("div", "account-main");
    const loginState = account.authenticated ? "đã kết nối" : "chưa kết nối";
    const resetText = account.resetAt ? ` · lại ${formatReset(account.resetAt)}` : "";
    main.append(
      node("strong", "", account.label),
      node("small", "", `${account.plan} · ${loginState}${resetText}`)
    );
    const quota = node("span", "account-quota", `${Math.round(account.remaining)}%`);
    const edit = node("button", "account-edit", "✎");
    edit.type = "button";
    edit.title = "Chỉnh sửa tài khoản";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openAccountDialog(account);
    });
    const syncState = account.syncError
      ? "Không đọc được hạn mức"
      : account.lastSyncedAt ? `Cập nhật ${formatTime(account.lastSyncedAt)}` : "Chưa đồng bộ hạn mức";
    card.title = [account.email, syncState, expiry?.text, account.note].filter(Boolean).join(" · ");
    card.append(dot, main, quota, edit);
    card.addEventListener("click", () => requestAccountSwitch(account));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") requestAccountSwitch(account);
    });
    list.append(card);
  }
  if (!app.state.accounts.length) {
    const empty = node("button", "account-card");
    empty.type = "button";
    empty.textContent = "＋ Thêm tài khoản Codex";
    empty.addEventListener("click", () => openAccountDialog());
    list.append(empty);
  }
}

function renderProjects() {
  const list = $("#project-list");
  list.replaceChildren();
  $("#project-count").textContent = String(app.state.projects.length);
  for (const project of app.state.projects) {
    const button = node("button", `project-item${project.kind === "general" ? " general-project" : ""}${project.id === app.state.activeProjectId ? " active" : ""}`);
    button.type = "button";
    button.append(
      node("strong", "", project.name),
      node("span", "", project.kind === "general" ? "Chat không gắn thư mục dự án" : project.path)
    );
    button.addEventListener("click", async () => {
      try {
        await api(`/api/projects/${project.id}/select`, { method: "POST", body: "{}" });
        app.activeChatId = null;
        await loadState();
        document.body.classList.remove("sidebar-open");
      } catch (error) {
        toast(error.message);
      }
    });
    list.append(button);
  }
  if (!app.state.projects.some((project) => project.kind !== "general")) {
    const empty = node("button", "project-item");
    empty.type = "button";
    empty.textContent = "＋ Thêm thư mục dự án";
    empty.addEventListener("click", () => $("#project-dialog").showModal());
    list.append(empty);
  }
}

async function loadFolder(path = "") {
  const list = $("#folder-list");
  const errorElement = $("#folder-error");
  list.replaceChildren(node("div", "folder-loading", "Đang đọc thư mục…"));
  errorElement.classList.add("hidden");
  try {
    const result = await api("/api/folders/list", { method: "POST", body: JSON.stringify({ path }) });
    app.folderPath = result.currentPath;
    app.folderParentPath = result.parentPath;
    $("#folder-current-path").textContent = result.currentPath;
    $("#folder-up").disabled = !result.parentPath;
    list.replaceChildren();
    for (const directory of result.directories) {
      const button = node("button", "folder-item");
      button.type = "button";
      button.append(node("span", "folder-icon", "▰"), node("span", "", directory.name));
      button.addEventListener("click", () => loadFolder(directory.path));
      list.append(button);
    }
    if (!result.directories.length) list.append(node("div", "folder-empty", "Thư mục này không có thư mục con."));
  } catch (error) {
    list.replaceChildren();
    errorElement.textContent = `Không đọc được thư mục: ${error.message}`;
    errorElement.classList.remove("hidden");
  }
}

function browseProjectPath() {
  $("#folder-dialog").showModal();
  loadFolder($("#project-path").value.trim());
}

function confirmProjectFolder() {
  if (!app.folderPath) return;
  $("#project-path").value = app.folderPath;
  if (!$("#project-name").value.trim()) {
    $("#project-name").value = app.folderPath.split(/[\\/]/).filter(Boolean).at(-1) || "Dự án mới";
  }
  $("#folder-dialog").close();
}

function applyProjectPath(selectedPath) {
  $("#project-path").value = selectedPath;
  if (!$("#project-name").value.trim()) {
    $("#project-name").value = selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || "Dự án mới";
  }
}

async function browseProjectPathNative() {
  const button = $("#browse-project-path");
  button.disabled = true;
  button.textContent = "Đang chờ Windows…";
  try {
    const result = await api("/api/folders/pick", { method: "POST", body: "{}" });
    if (result.path) applyProjectPath(result.path);
  } catch (error) {
    toast(`Windows không mở được hộp chọn thư mục. Đang chuyển sang trình duyệt trong ứng dụng.`);
    browseProjectPath();
  } finally {
    button.disabled = false;
    button.textContent = "Chọn thư mục";
  }
}

function updatePlanningModeUi() {
  const mode = $("#planning-mode").value;
  $("#api-planning-options").classList.toggle("hidden", mode !== "api");
  $("#planning-mode-help").textContent = mode === "subscription"
    ? "ChatGPT Plus lập kế hoạch qua MCP; Gemini CLI sẽ review nền bằng đăng nhập Google khi đã cài. Không cần API key."
    : mode === "none"
      ? "Bỏ qua bước lập kế hoạch phụ trợ và gửi yêu cầu thẳng cho Codex."
      : "Chỉ dùng khi bạn chủ động cấu hình API key riêng; nhà cung cấp có thể tính phí API.";
}

async function savePlanningWorkflow() {
  const project = activeProject();
  if (!project) return;
  const planningWorkflow = {
    mode: $("#planning-mode").value,
    plannerProviderId: $("#planner-provider").value,
    reviewerProviderId: $("#reviewer-provider").value
  };
  await api(`/api/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ planningWorkflow })
  });
  const stateProject = app.state.projects.find((item) => item.id === project.id);
  if (stateProject) {
    stateProject.planningWorkflow = {
      mode: planningWorkflow.mode,
      plannerProviderId: planningWorkflow.plannerProviderId || null,
      reviewerProviderId: planningWorkflow.reviewerProviderId || null
    };
  }
}

function renderProviders() {
  const list = $("#provider-list");
  const plannerSelector = $("#planner-provider");
  const reviewerSelector = $("#reviewer-provider");
  const project = activeProject();
  const selectedMode = project?.planningWorkflow?.mode || "subscription";
  const selectedPlanner = project?.planningWorkflow?.plannerProviderId || "";
  const selectedReviewer = project?.planningWorkflow?.reviewerProviderId || "";
  list.replaceChildren();
  $("#planning-mode").value = selectedMode;
  updatePlanningModeUi();
  plannerSelector.replaceChildren(new Option("Không lập kế hoạch", ""));
  reviewerSelector.replaceChildren(new Option("Không review", ""));
  for (const provider of app.state.providers || []) {
    const used = Number(provider.usage?.totalTokens || 0);
    const budget = Number(provider.tokenBudget || 0);
    const remaining = Math.max(0, budget - used);
    const percent = budget > 0 ? Math.max(0, Math.min(100, remaining / budget * 100)) : null;
    const budgetExhausted = budget > 0 && remaining <= 0;
    const budgetLow = budget > 0 && percent <= 20;
    const autoApproved = Boolean(project?.auxiliaryPolicy?.autoApprovedProviderIds?.includes(provider.id));
    const card = node("div", "provider-card");
    const top = node("div", "provider-top");
    const dotClass = provider.availability === "available" && !budgetExhausted && !budgetLow
      ? "online"
      : provider.availability === "error" || budgetExhausted || budgetLow ? "warning" : "";
    top.append(
      node("span", `status-dot ${dotClass}`),
      node("strong", "", provider.label),
      node("span", "plan-badge", provider.type === "anthropic" ? "CLAUDE" : provider.type === "google" ? "GEMINI" : "OPENAI")
    );
    const modelState = provider.selectedModelAvailable === false ? " · mô hình không khả dụng với key này" : "";
    card.append(top, node("small", "", `${provider.model || "Chưa chọn mô hình"}${modelState}${autoApproved ? " · TỰ ĐỘNG TRONG DỰ ÁN" : ""}`));
    const usage = node("div", "usage-row");
    const bar = node("span", "usage-bar");
    const fill = node("i");
    fill.style.width = `${percent ?? 0}%`;
    bar.append(fill);
    usage.append(bar, node("span", "", percent === null ? "—" : `${Math.round(percent)}%`));
    card.append(usage);
    card.append(node("small", "", budget > 0
      ? `${budgetExhausted ? "Đã hết ngân sách" : `Còn ${compactNumber(remaining)}`} / ${compactNumber(budget)} token · ${provider.usage?.calls || 0} lượt`
      : `Đã dùng ${compactNumber(used)} token · chưa đặt ngân sách`));
    card.append(node("small", "", `In ${compactNumber(provider.usage?.inputTokens)} · Cache ${compactNumber(provider.usage?.cachedInputTokens)} · Out ${compactNumber(provider.usage?.outputTokens)}`));
    if (provider.checkError) card.append(node("small", "provider-error", provider.checkError));
    const actions = node("div", "provider-actions");
    const status = node("span", "", provider.lastCheckedAt ? `Đã kiểm tra ${formatTime(provider.lastCheckedAt)}` : "Chưa kiểm tra kết nối");
    const buttons = node("div", "", "");
    const edit = node("button", "", "Cấu hình");
    edit.type = "button";
    edit.addEventListener("click", () => openProviderDialog(provider));
    const check = node("button", "", "Kiểm tra");
    check.type = "button";
    check.addEventListener("click", async () => {
      check.disabled = true;
      check.textContent = "…";
      try {
        await api(`/api/providers/${provider.id}/check`, { method: "POST", body: "{}" });
        toast(`${provider.label} đang khả dụng.`);
      } catch (error) {
        toast(error.message);
      }
      await loadState();
    });
    buttons.append(edit, check);
    if (autoApproved) {
      const disableAuto = node("button", "", "Tắt tự động");
      disableAuto.type = "button";
      disableAuto.addEventListener("click", async () => {
        const ids = (project.auxiliaryPolicy?.autoApprovedProviderIds || []).filter((id) => id !== provider.id);
        try {
          await api(`/api/projects/${project.id}`, {
            method: "PATCH",
            body: JSON.stringify({ auxiliaryPolicy: { autoApprovedProviderIds: ids } })
          });
          await loadState();
          toast(`Đã tắt quyền tự động của ${provider.label} trong dự án này.`);
        } catch (error) {
          toast(error.message);
        }
      });
      buttons.prepend(disableAuto);
    }
    actions.append(status, buttons);
    card.append(actions);
    list.append(card);

    if (provider.enabled && provider.keyConfigured && !budgetExhausted) {
      const option = new Option(`${provider.label} · ${provider.model || "chưa chọn mô hình"}`, provider.id);
      if (provider.type === "openai") plannerSelector.append(option);
      if (provider.type === "google") reviewerSelector.append(option);
    }
  }
  plannerSelector.value = [...plannerSelector.options].some((option) => option.value === selectedPlanner) ? selectedPlanner : "";
  reviewerSelector.value = [...reviewerSelector.options].some((option) => option.value === selectedReviewer) ? selectedReviewer : "";
  if (!(app.state.providers || []).length) {
    const empty = node("small", "sync-meta", "Chưa cấu hình API (không bắt buộc).");
    list.append(empty);
  }
}

function renderChats() {
  const project = activeProject();
  const chats = project
    ? app.state.chats.filter((chat) => chat.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];
  const list = $("#chat-list");
  list.replaceChildren();
  $("#chat-count").textContent = String(chats.length);
  for (const chat of chats) {
    const button = node("button", `chat-item${chat.id === app.activeChatId ? " active" : ""}`);
    button.type = "button";
    const title = node("strong", "", chat.title);
    const meta = node("span", chat.needsBridge ? "bridge-label" : "", chat.needsBridge ? "Đang chờ bàn giao" : formatTime(chat.updatedAt));
    button.append(title, meta);
    button.addEventListener("click", () => {
      app.activeChatId = chat.id;
      render();
      document.body.classList.remove("sidebar-open");
    });
    list.append(button);
  }
  if (!chats.length) list.append(node("div", "sidebar-empty", "Chưa có đoạn chat"));
}

function renderTopbar() {
  const project = activeProject();
  const account = activeAccount();
  $("#project-title").textContent = project?.name || "Trò chuyện chung";
  $("#project-path-label").textContent = project?.kind === "general"
    ? "Không gắn thư mục dự án"
    : project?.path || "Chưa chọn thư mục";
  $("#empty-project-label").textContent = project?.kind === "general" ? "Trò chuyện chung" : project?.name || "Chọn dự án";
  $("#new-chat").disabled = !project;
  const pill = $("#active-account-pill");
  pill.replaceChildren();
  const dot = node("span", `status-dot${account ? " online" : ""}`);
  pill.append(dot, node(
    "span",
    "",
    account
      ? `${account.label} · ${Math.round(account.remaining)}%`
      : "Chưa chọn tài khoản"
  ));
}

function renderContext() {
  const project = activeProject();
  $("#context-empty").classList.toggle("hidden", Boolean(project));
  $("#context-form").classList.toggle("hidden", !project);
  if (project) {
    $("#summary-input").value = project.summary || "";
    $("#next-step-input").value = project.nextStep || "";
    const config = project.contextConfig || {};
    $("#context-strategy").value = config.strategy || "goal-recent";
    $("#context-max-messages").value = config.maxHistoryMessages || 80;
    $("#context-budget").value = config.historyBudget || 48000;
    $("#long-chat-threshold").value = config.longChatThreshold || 120;
  }
}

function messageElement(message) {
  const article = node("article", `message ${message.role}`);
  const avatar = node("div", "message-avatar", message.role === "user" ? "B" : "C");
  const body = node("div", "message-body");
  body.append(document.createTextNode(message.content));
  body.append(node("span", "message-time", formatTime(message.createdAt)));
  article.append(avatar, body);
  return article;
}

function renderConversation() {
  const chat = activeChat();
  $("#empty-state").classList.toggle("hidden", Boolean(chat));
  $("#chat-view").classList.toggle("hidden", !chat);
  if (!chat) return;

  $("#chat-title").textContent = chat.title;
  const chatAccount = app.state.accounts.find((account) => account.id === chat.accountId);
  $("#thread-status").textContent = chat.needsBridge
    ? "Đang chờ chuyển tài khoản"
    : chat.threadId
      ? `${chatAccount?.label || "Codex"} · đang hoạt động`
      : "Sẵn sàng bắt đầu";
  const totalTokens = chat.usage.inputTokens + chat.usage.outputTokens;
  $("#usage-status").textContent = totalTokens > 0 ? `${compactNumber(totalTokens)} token đã dùng` : "Tự động lưu tiến độ";
  const longThreshold = activeProject()?.contextConfig?.longChatThreshold || 120;
  $("#bridge-note").textContent = chat.needsBridge
    ? "Lượt tiếp theo sử dụng gói bàn giao đã tối ưu"
    : chat.messages.length >= longThreshold
      ? `Cuộc trò chuyện dài (${chat.messages.length} lượt) · ngữ cảnh sẽ được rút gọn khi bàn giao`
      : "Lịch sử được lưu cục bộ";

  const handoff = chat.handoff?.status === "pending" ? chat.handoff : null;
  const banner = $("#handoff-banner");
  banner.classList.toggle("hidden", !handoff);
  if (handoff) {
    const source = app.state.accounts.find((account) => account.id === handoff.sourceAccountId);
    $("#handoff-reason").textContent = `${source?.label || "Tài khoản trước"} đã chạm hạn mức. Chọn một tài khoản khả dụng để tiếp quản đúng công việc này.`;
    const select = $("#handoff-account");
    select.replaceChildren();
    const candidates = app.state.accounts.filter((account) =>
      account.id !== handoff.sourceAccountId && account.authenticated && account.status !== "disabled"
      && Number(account.remaining) > 0 && !account.rateLimits?.rateLimitReachedType
      && !expiryMeta(account.expiresAt)?.expired
    );
    for (const account of candidates) {
      const option = node("option", "", `${account.label} · ${Math.round(account.remaining)}%`);
      option.value = account.id;
      option.selected = account.id === handoff.suggestedAccountId;
      select.append(option);
    }
    $("#continue-handoff").disabled = !candidates.length;
    const repo = handoff.capsule?.repoState;
    $("#handoff-git").textContent = repo?.available
      ? `Git snapshot · ${repo.branch} · ${repo.commit.slice(0, 8)} · ${repo.workingTree === "clean" ? "working tree sạch" : "có thay đổi chưa commit"}.`
      : "Chưa đọc được Git snapshot; tài khoản mới sẽ kiểm tra lại thư mục trước khi tiếp tục.";
  }

  const messages = $("#messages");
  messages.replaceChildren();
  for (const message of chat.messages) messages.append(messageElement(message));
  requestAnimationFrame(() => {
    messages.scrollTop = messages.scrollHeight;
  });
}

function render() {
  renderAccounts();
  renderProjects();
  renderProviders();
  renderChats();
  renderTopbar();
  renderContext();
  renderConversation();
}

async function loadState() {
  const data = await api("/api/state");
  app.state = data.state;
  const project = activeProject();
  const availableChats = project ? app.state.chats.filter((item) => item.projectId === project.id) : [];
  if (app.activeChatId && !availableChats.some((item) => item.id === app.activeChatId)) {
    app.activeChatId = null;
  }
  if (!app.activeChatId && availableChats.length) {
    app.activeChatId = availableChats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
  }
  render();
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    const dot = $("#codex-dot");
    dot.className = `status-dot ${data.codex.authenticated ? "online" : "warning"}`;
    $("#codex-status").textContent = data.codex.authenticated
      ? "Codex đã sẵn sàng"
      : data.codex.installed
        ? "Codex đang chờ đăng nhập"
        : "Chưa tìm thấy Codex CLI";
    if (!app.activeJobId && data.activeJob) startPolling(data.activeJob);
  } catch {
    $("#codex-status").textContent = "Không kết nối được máy chủ cục bộ";
    $("#codex-dot").className = "status-dot warning";
  }
}

function requestAccountSwitch(account) {
  if (account.id === app.state.activeAccountId && account.authenticated) {
    toast(`${account.label} đang là tài khoản hoạt động.`);
    return;
  }
  app.switchAccountId = account.id;
  $("#switch-title").textContent = account.authenticated
    ? `Chuyển sang ${account.label}?`
    : `Kết nối ${account.label}?`;
  $("#confirm-switch").textContent = account.authenticated ? "Chuyển tài khoản" : "Mở luồng đăng nhập";
  $("#switch-dialog").showModal();
}

async function confirmAccountSwitch() {
  if (!app.switchAccountId) return;
  $("#switch-dialog").close();
  try {
    const data = await api(`/api/accounts/${app.switchAccountId}/login`, {
      method: "POST",
      body: "{}"
    });
    startPolling(data.job);
    toast(data.job.status === "completed"
      ? "Đã chuyển sang tài khoản Codex đã kết nối."
      : "Đang mở luồng đăng nhập Codex chính thức…");
  } catch (error) {
    toast(error.message);
  }
}

async function deleteAccount() {
  const accountId = app.editAccountId;
  const account = app.state?.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const confirmed = window.confirm(
    `Xóa tài khoản "${account.label}" khỏi workspace?\n\nDữ liệu đăng nhập cục bộ sẽ được chuyển vào thư mục lưu trữ để có thể khôi phục.`
  );
  if (!confirmed) return;
  const button = $("#delete-account");
  button.disabled = true;
  try {
    await api(`/api/accounts/${accountId}`, { method: "DELETE", body: "{}" });
    app.editAccountId = null;
    $("#account-dialog").close();
    await loadState();
    toast(`Đã xóa ${account.label} khỏi workspace.`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshUsage({ silent = false } = {}) {
  if (app.usageRefreshing || app.activeJobId) return;
  app.usageRefreshing = true;
  const button = $("#refresh-usage");
  if (!silent) {
    button.disabled = true;
    button.textContent = "…";
  }
  if (!app.state) {
    try {
      await loadState();
    } catch (error) {
      if (!silent) toast(`Chưa tải được dữ liệu: ${error.message}`);
      app.usageRefreshing = false;
      if (!silent) {
        button.disabled = false;
        button.textContent = "↻";
      }
      return;
    }
  }
  const accounts = app.state.accounts.filter((account) => account.authenticated);
  if (!accounts.length) {
    if (!silent) toast("Chưa có tài khoản Codex nào được kết nối.");
    app.usageRefreshing = false;
    if (!silent) {
      button.disabled = false;
      button.textContent = "↻";
    }
    return;
  }
  let failures = 0;
  try {
    for (const account of accounts) {
      try {
        await api(`/api/accounts/${account.id}/refresh`, { method: "POST", body: "{}" });
      } catch {
        failures += 1;
      }
    }
    await loadState();
    app.lastUsageRefreshAt = Date.now();
    if (!silent) {
      toast(failures
        ? `Đã cập nhật hạn mức cho ${accounts.length - failures}/${accounts.length} tài khoản.`
        : "Đã cập nhật hạn mức cho tất cả tài khoản Codex.");
    }
  } finally {
    app.usageRefreshing = false;
    if (!silent) {
      button.disabled = false;
      button.textContent = "↻";
    }
  }
}

function startUsageAutoRefresh() {
  clearInterval(app.usageRefreshTimer);
  app.usageRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshUsage({ silent: true });
  }, 120000);
  setTimeout(() => refreshUsage({ silent: true }), 1500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - app.lastUsageRefreshAt > 60000) {
      refreshUsage({ silent: true });
    }
  });
}

function toggleContextPanel() {
  const grid = $("#workspace-grid");
  const button = $("#toggle-context");
  const opening = grid.classList.contains("context-collapsed");
  grid.classList.toggle("context-collapsed", !opening);
  button.setAttribute("aria-expanded", String(opening));
  button.textContent = opening ? "Đóng bộ nhớ" : "Bộ nhớ";
}

function setJob(job) {
  app.activeJobId = job?.id || null;
  const running = job && ["queued", "running", "awaiting_approval", "awaiting_gpt", "awaiting_gemini", "reviewing_gemini", "ready_for_codex"].includes(job.status);
  $("#job-strip").classList.toggle("hidden", !running);
  $("#send-message").disabled = Boolean(running);
  $("#message-input").disabled = Boolean(running);
  if (running) {
    const labels = {
      awaiting_approval: "Đang chờ xác nhận API nâng cao…",
      awaiting_gpt: "Đang chờ ChatGPT Plus lập kế hoạch…",
      awaiting_gemini: "Đang chờ Gemini Pro review…",
      reviewing_gemini: "Gemini CLI đang review nền…",
      ready_for_codex: "Đang chuyển kế hoạch cuối sang Codex…"
    };
    $("#job-label").textContent = labels[job.status]
      || (job.type === "login" ? "Đang chuyển tài khoản Codex…" : "Codex đang xử lý…");
    const lastEvent = job.events.at(-1);
    $("#job-event").textContent = lastEvent?.message || "Đang khởi tạo phiên";
  }
}

function showApproval(job) {
  const approval = job.approval;
  if (!approval) return;
  $("#approval-title").textContent = "GPT lập kế hoạch → Gemini review → Codex thực hiện";
  $("#approval-reason").textContent = approval.reason;
  $("#approval-provider").textContent = (approval.providers || [])
    .map((provider) => `${provider.role === "planner" ? "GPT" : "Gemini"}: ${provider.label} / ${provider.model}`)
    .join(" · ") || `${approval.providerType} / ${approval.model}`;
  $("#approval-tokens").textContent = `~${compactNumber(approval.estimatedMaximumTokens)} token`;
  $("#approval-remaining").textContent = approval.remainingTokens === null
    ? "Chưa đặt ngân sách"
    : `${compactNumber(approval.remainingTokens)} token`;
  $("#approval-cost").textContent = approval.paidApi ? "API có thể phát sinh phí" : "Trong hạn mức gói/free";
  const data = $("#approval-data");
  data.replaceChildren();
  for (const provider of approval.providers || []) {
    const remaining = provider.remainingTokens === null ? "chưa đặt ngân sách" : `còn ${compactNumber(provider.remainingTokens)} token`;
    data.append(node("li", "", `${provider.role === "planner" ? "GPT lập kế hoạch" : "Gemini review"}: ${provider.label} · ${remaining}`));
  }
  for (const item of approval.dataItems || []) data.append(node("li", "", item));
  for (const file of approval.files || []) data.append(node("li", "", `Tệp: ${file}`));
  $("#approval-redactions").textContent = approval.redactions?.length
    ? `Đã che: ${approval.redactions.join(", ")}`
    : "Không phát hiện dữ liệu bí mật trong ngữ cảnh chuẩn bị gửi.";
  if (!$("#approval-dialog").open) $("#approval-dialog").showModal();
}

function startPolling(job) {
  setJob(job);
  clearTimeout(app.pollTimer);
  if (job.type === "subscription-planning" && job.subscriptionTask?.id && app.shownSubscriptionTaskId !== job.subscriptionTask.id) {
    app.shownSubscriptionTaskId = job.subscriptionTask.id;
    if (!$("#subscription-dialog").open) $("#subscription-dialog").showModal();
  }
  if (job.status === "awaiting_approval") {
    showApproval(job);
    return;
  }
  if (job.approvalMode === "auto" && job.type === "chat") {
    toast("Dự án đang tự động cho phép GPT lập kế hoạch và Gemini review; mức sử dụng vẫn được báo sau lượt này.");
  }
  app.pollTimer = setTimeout(pollJob, 600);
}

async function pollJob() {
  if (!app.activeJobId) return;
  try {
    const data = await api(`/api/jobs/${app.activeJobId}`);
    const job = data.job;
    setJob(job);
    if (job.status === "awaiting_approval") {
      showApproval(job);
      return;
    }
    if (["completed", "error", "failed", "cancelled", "needs_handoff"].includes(job.status)) {
      clearTimeout(app.pollTimer);
      setJob(null);
      await Promise.all([loadState(), loadStatus()]);
      if (job.status === "completed") {
        toast(job.type === "login"
          ? "Đã chuyển tài khoản. Cuộc trò chuyện hiện tại sẵn sàng tiếp tục."
          : job.auxiliaryReport
            ? `${job.auxiliaryReport.providerLabel} đã dùng ${compactNumber(job.auxiliaryReport.usage.totalTokens)} token để lập và review kế hoạch; Codex đã hoàn tất yêu cầu.`
            : "Codex đã hoàn tất yêu cầu.");
      } else if (job.status === "needs_handoff") {
        toast("Tài khoản đã chạm hạn mức. Chọn tài khoản tiếp quản để tiếp tục công việc.");
      } else {
        toast(job.error || "Tác vụ đã dừng.");
      }
      return;
    }
    app.pollTimer = setTimeout(pollJob, 1100);
  } catch {
    app.pollTimer = setTimeout(pollJob, 2200);
  }
}

async function sendMessage() {
  const chat = activeChat();
  const message = $("#message-input").value.trim();
  if (!chat || !message || app.activeJobId) return;
  const planningMode = $("#planning-mode").value;
  const plannerProviderId = planningMode === "api" ? $("#planner-provider").value : "";
  const reviewerProviderId = planningMode === "api" ? $("#reviewer-provider").value : "";
  if (planningMode === "api" && Boolean(plannerProviderId) !== Boolean(reviewerProviderId)) {
    toast("Hãy chọn cả GPT Planner và Gemini Reviewer, hoặc tắt cả hai.");
    return;
  }
  $("#message-input").value = "";
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        chatId: chat.id,
        message,
        model: $("#model-input").value.trim(),
        sandbox: $("#sandbox-input").value,
        planningMode,
        plannerProviderId,
        reviewerProviderId
      })
    });
    await loadState();
    startPolling(data.job);
  } catch (error) {
    toast(error.message);
  }
}

function startNewConversation() {
  if (!activeProject()) {
    $("#project-dialog").showModal();
    return;
  }
  app.activeChatId = null;
  render();
  document.body.classList.remove("sidebar-open");
  requestAnimationFrame(() => $("#empty-message-input").focus());
}

async function startChatFromPrompt() {
  const project = activeProject();
  const input = $("#empty-message-input");
  const message = input.value.trim();
  if (!project) {
    $("#project-dialog").showModal();
    return;
  }
  if (!message || app.activeJobId) return;

  const button = $("#empty-send-message");
  button.disabled = true;
  try {
    const normalizedTitle = message.replace(/\s+/g, " ");
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        title: normalizedTitle.length > 72 ? `${normalizedTitle.slice(0, 69)}…` : normalizedTitle
      })
    });
    app.activeChatId = data.chat.id;
    input.value = "";
    await loadState();
    $("#message-input").value = message;
    await sendMessage();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function continueHandoff() {
  const chat = activeChat();
  const accountId = $("#handoff-account").value;
  if (!chat?.handoff || !accountId || app.activeJobId) return;
  try {
    const data = await api(`/api/chats/${chat.id}/handoff/continue`, {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
    await loadState();
    startPolling(data.job);
    toast("Đã chuyển gói bàn giao và tiếp tục công việc bằng tài khoản mới.");
  } catch (error) {
    toast(error.message);
  }
}

async function resolveAuxiliaryApproval(mode) {
  if (!app.activeJobId) return;
  const dialog = $("#approval-dialog");
  const approveButton = $("#approve-auxiliary");
  const denyButton = $("#deny-auxiliary");
  const autoButton = $("#auto-approve-auxiliary");
  approveButton.disabled = true;
  denyButton.disabled = true;
  autoButton.disabled = true;
  try {
    const approved = mode !== "deny";
    const data = await api(`/api/jobs/${app.activeJobId}/${approved ? "approve" : "deny"}`, {
      method: "POST",
      body: JSON.stringify(approved ? { scope: mode === "project" ? "project" : "once" } : {})
    });
    dialog.close();
    startPolling(data.job);
    toast(mode === "project"
      ? "Đã tự động cho phép GPT Planner và Gemini Reviewer trong dự án; mỗi lần sử dụng vẫn được thông báo."
      : approved ? "Đã cho phép workflow lập kế hoạch trong lượt này." : "Đã bỏ qua GPT/Gemini; Codex sẽ tự tiếp tục.");
  } catch (error) {
    toast(error.message);
  } finally {
    approveButton.disabled = false;
    denyButton.disabled = false;
    autoButton.disabled = false;
  }
}

$("#add-account").addEventListener("click", () => openAccountDialog());
$("#refresh-usage").addEventListener("click", () => refreshUsage());
$("#add-project").addEventListener("click", () => $("#project-dialog").showModal());
$("#browse-project-path").addEventListener("click", browseProjectPathNative);
$("#browse-project-path-fallback").addEventListener("click", browseProjectPath);
$("#folder-up").addEventListener("click", () => app.folderParentPath && loadFolder(app.folderParentPath));
$("#cancel-folder").addEventListener("click", () => $("#folder-dialog").close());
$("#confirm-folder").addEventListener("click", confirmProjectFolder);
$("#add-provider").addEventListener("click", () => openProviderDialog());
$("#new-chat").addEventListener("click", startNewConversation);
$("#empty-add-project").addEventListener("click", () => $("#project-dialog").showModal());
$("#toggle-context").addEventListener("click", toggleContextPanel);
$("#close-context").addEventListener("click", () => {
  if (!$("#workspace-grid").classList.contains("context-collapsed")) toggleContextPanel();
});
$("#sidebar-toggle").addEventListener("click", () => document.body.classList.add("sidebar-open"));
$("#sidebar-backdrop").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
$("#empty-send-message").addEventListener("click", startChatFromPrompt);
$("#empty-message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    startChatFromPrompt();
  }
});
for (const card of document.querySelectorAll(".prompt-card")) {
  card.addEventListener("click", () => {
    $("#empty-message-input").value = card.dataset.prompt || "";
    $("#empty-message-input").focus();
  });
}
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    startNewConversation();
  }
});
for (const button of document.querySelectorAll(".dialog-cancel")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
$("#cancel-switch").addEventListener("click", () => $("#switch-dialog").close());
$("#confirm-switch").addEventListener("click", confirmAccountSwitch);
$("#delete-account").addEventListener("click", deleteAccount);
$("#continue-handoff").addEventListener("click", continueHandoff);
$("#approve-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("once"));
$("#auto-approve-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("project"));
$("#deny-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("deny"));
$("#close-subscription-dialog").addEventListener("click", () => $("#subscription-dialog").close());
$("#copy-gpt-instruction").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("Dùng AI Workspace, lấy task đang chờ GPT lập kế hoạch, lập kế hoạch đầy đủ rồi lưu lại bằng tool tương ứng.");
    toast("Đã sao chép câu lệnh cho ChatGPT Plus.");
  } catch {
    toast("Trình duyệt không cho sao chép. Hãy chọn và sao chép câu lệnh hiển thị phía trên.");
  }
});
$("#copy-gemini-instruction").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("Dùng AI Workspace, lấy task đang chờ Gemini review, kiểm tra kỹ kế hoạch rồi lưu review và kế hoạch cuối bằng tool tương ứng.");
    toast("Đã sao chép câu lệnh cho Gemini Pro.");
  } catch {
    toast("Trình duyệt không cho sao chép. Hãy chọn và sao chép câu lệnh hiển thị phía trên.");
  }
});
$("#planning-mode").addEventListener("change", async () => {
  updatePlanningModeUi();
  try {
    await savePlanningWorkflow();
  } catch (error) {
    toast(`Không lưu được chế độ chuẩn bị: ${error.message}`);
  }
});
for (const selectorId of ["#planner-provider", "#reviewer-provider"]) {
  $(selectorId).addEventListener("change", async () => {
    try {
      await savePlanningWorkflow();
    } catch (error) {
      toast(`Không lưu được workflow: ${error.message}`);
    }
  });
}

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = $("#save-account");
  submitButton.disabled = true;
  try {
    const editing = app.editAccountId;
    const accountInput = {
      label: $("#account-label").value.trim(),
      email: $("#account-email").value.trim(),
      expiresAt: $("#account-expires-at").value,
      note: $("#account-note").value,
      ...(editing ? {} : { remaining: 100 })
    };
    const duplicate = !editing
      ? app.state?.accounts.find((account) =>
        account.label.trim().toLowerCase() === accountInput.label.toLowerCase()
        && (account.email || "").trim().toLowerCase() === accountInput.email.toLowerCase()
      )
      : null;
    const result = duplicate
      ? { account: duplicate }
      : await api(editing ? `/api/accounts/${editing}` : "/api/accounts", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(accountInput)
      });
    app.editAccountId = null;
    form.reset();
    $("#account-dialog").close();
    await loadState();
    if (!editing && result.account?.id) {
      const login = await api(`/api/accounts/${result.account.id}/login`, {
        method: "POST",
        body: "{}"
      });
      startPolling(login.job);
      toast(login.job.status === "completed"
        ? "Tài khoản đã sẵn sàng sử dụng."
        : duplicate
          ? "Tài khoản đã tồn tại. Đang mở đăng nhập Codex…"
          : "Đã lưu tài khoản. Đang mở đăng nhập Codex…");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

$("#provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const editing = app.editProviderId;
    const apiKey = $("#provider-key").value;
    await api(editing ? `/api/providers/${editing}` : "/api/providers", {
      method: editing ? "PATCH" : "POST",
      body: JSON.stringify({
        type: $("#provider-type").value,
        label: $("#provider-label").value,
        ...(apiKey ? { apiKey } : {}),
        model: $("#provider-model").value,
        tokenBudget: Number($("#provider-budget").value),
        maxOutputTokens: Number($("#provider-max-output").value)
      })
    });
    app.editProviderId = null;
    form.reset();
    $("#provider-type").disabled = false;
    $("#provider-max-output").value = 2048;
    $("#provider-dialog").close();
    await loadState();
    toast("Đã lưu API key an toàn. Chọn Kiểm tra để xác nhận kết nối.");
  } catch (error) {
    toast(error.message);
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("#project-name").value,
        path: $("#project-path").value
      })
    });
    form.reset();
    $("#project-dialog").close();
    app.activeChatId = null;
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const project = activeProject();
  if (!project) return;
  try {
    const data = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        title: $("#new-chat-title").value
      })
    });
    form.reset();
    $("#chat-dialog").close();
    app.activeChatId = data.chat.id;
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

$("#save-context").addEventListener("click", async () => {
  const project = activeProject();
  if (!project) return;
  $("#save-indicator").textContent = "Đang lưu…";
  try {
    await api(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        summary: $("#summary-input").value,
        nextStep: $("#next-step-input").value,
        contextConfig: {
          strategy: $("#context-strategy").value,
          maxHistoryMessages: Number($("#context-max-messages").value),
          historyBudget: Number($("#context-budget").value),
          longChatThreshold: Number($("#long-chat-threshold").value)
        }
      })
    });
    $("#save-indicator").textContent = "Đã lưu";
    await loadState();
  } catch (error) {
    $("#save-indicator").textContent = "Lỗi";
    toast(error.message);
  }
});

$("#send-message").addEventListener("click", sendMessage);
$("#message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
$("#cancel-job").addEventListener("click", async () => {
  if (!app.activeJobId) return;
  try {
    await api(`/api/jobs/${app.activeJobId}/cancel`, { method: "POST", body: "{}" });
    if ($("#approval-dialog").open) $("#approval-dialog").close();
  } catch (error) {
    toast(error.message);
  }
});

Promise.all([loadState(), loadStatus()])
  .then(startUsageAutoRefresh)
  .catch((error) => toast(error.message));
