const app = {
  state: null,
  activeChatId: null,
  activeJobId: null,
  switchAccountId: null,
  editAccountId: null,
  editProviderId: null,
  pollTimer: null,
  toastTimer: null
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
  const title = node("span", "", `${label} · ${formatDuration(window.windowDurationMins)}`);
  const value = node("strong", "", remaining === null ? "—" : `${Math.round(remaining)}%`);
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
  $("#account-label").value = account?.label || "";
  $("#account-email").value = account?.email || "";
  $("#account-plan").value = account?.plan || "Plus";
  $("#account-expires-at").value = account?.expiresAt || "";
  $("#account-note").value = account?.note || "";
  $("#account-dialog").showModal();
}

function openProviderDialog(provider = null) {
  app.editProviderId = provider?.id || null;
  $("#provider-dialog-eyebrow").textContent = provider ? "Cấu hình trợ lý" : "Trợ lý chuyên biệt";
  $("#provider-dialog-title").textContent = provider ? provider.label : "Kết nối AI phụ trợ";
  $("#save-provider").textContent = provider ? "Lưu thay đổi" : "Lưu cấu hình";
  $("#provider-type").value = provider?.type || "anthropic";
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

    const top = node("div", "account-top");
    const expiry = expiryMeta(account.expiresAt);
    const exhausted = Number(account.remaining) <= 0 || Boolean(account.rateLimits?.rateLimitReachedType) || expiry?.expired;
    const dot = node("span", `status-dot ${account.status === "available" && !exhausted ? "online" : "warning"}`);
    const title = node("strong", "", account.label);
    const plan = node("span", "plan-badge", account.plan);
    const edit = node("button", "account-edit", "✎");
    edit.type = "button";
    edit.title = "Chỉnh sửa hồ sơ";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openAccountDialog(account);
    });
    top.append(dot, title, plan, edit);

    const loginState = account.authenticated ? "đã kết nối" : "chưa kết nối";
    const email = node("small", "", `${account.email || "Chưa có email"} · ${loginState}`);
    const usage = node("div", "usage-row");
    const bar = node("span", "usage-bar");
    const fill = node("i");
    fill.style.width = `${account.remaining}%`;
    bar.append(fill);
    usage.append(bar, node("span", "", `${Math.round(account.remaining)}%`));
    const syncText = account.syncError
      ? "Không đọc được hạn mức · bấm ↻ để thử lại"
      : account.remainingSource === "automatic"
        ? `Đồng bộ tự động${account.resetAt ? ` · đặt lại ${formatReset(account.resetAt)}` : ""}`
        : account.authenticated
          ? "Đang chờ dữ liệu hạn mức"
          : "Kết nối để đồng bộ hạn mức";
    const syncMeta = node("small", `sync-meta${account.syncError ? " error" : ""}`, syncText);
    card.append(top, email, usage, syncMeta);
    if (expiry) card.append(node("small", `account-expiry${expiry.expired ? " expired" : ""}`, expiry.text));
    if (account.note) card.append(node("small", "account-note", account.note));
    const primary = quotaWindow("Cửa sổ ngắn", account.rateLimits?.primary);
    const secondary = quotaWindow("Cửa sổ dài", account.rateLimits?.secondary);
    if (primary || secondary) {
      const windows = node("div", "quota-windows");
      if (primary) windows.append(primary);
      if (secondary) windows.append(secondary);
      card.append(windows);
    }
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
  for (const project of app.state.projects) {
    const button = node("button", `project-item${project.id === app.state.activeProjectId ? " active" : ""}`);
    button.type = "button";
    button.append(node("strong", "", project.name), node("span", "", project.path));
    button.addEventListener("click", async () => {
      try {
        await api(`/api/projects/${project.id}/select`, { method: "POST", body: "{}" });
        app.activeChatId = null;
        await loadState();
      } catch (error) {
        toast(error.message);
      }
    });
    list.append(button);
  }
  if (!app.state.projects.length) {
    const empty = node("button", "project-item");
    empty.type = "button";
    empty.textContent = "＋ Kết nối thư mục dự án";
    empty.addEventListener("click", () => $("#project-dialog").showModal());
    list.append(empty);
  }
}

function renderProviders() {
  const list = $("#provider-list");
  const selector = $("#auxiliary-provider");
  const selected = selector.value;
  list.replaceChildren();
  selector.replaceChildren(new Option("Không dùng", ""));
  for (const provider of app.state.providers || []) {
    const used = Number(provider.usage?.totalTokens || 0);
    const budget = Number(provider.tokenBudget || 0);
    const remaining = Math.max(0, budget - used);
    const percent = budget > 0 ? Math.max(0, Math.min(100, remaining / budget * 100)) : null;
    const budgetExhausted = budget > 0 && remaining <= 0;
    const budgetLow = budget > 0 && percent <= 20;
    const project = activeProject();
    const autoApproved = Boolean(project?.auxiliaryPolicy?.autoApprovedProviderIds?.includes(provider.id));
    const card = node("div", "provider-card");
    const top = node("div", "provider-top");
    const dotClass = provider.availability === "available" && !budgetExhausted && !budgetLow
      ? "online"
      : provider.availability === "error" || budgetExhausted || budgetLow ? "warning" : "";
    top.append(
      node("span", `status-dot ${dotClass}`),
      node("strong", "", provider.label),
      node("span", "plan-badge", provider.type === "anthropic" ? "CLAUDE" : "OPENAI")
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
      selector.append(option);
    }
  }
  selector.value = [...selector.options].some((option) => option.value === selected) ? selected : "";
  if (!(app.state.providers || []).length) {
    const empty = node("small", "sync-meta", "Chưa kết nối AI phụ trợ.");
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
  $("#chat-count").textContent = `${chats.length} cuộc trò chuyện`;
  for (const chat of chats) {
    const button = node("button", `chat-item${chat.id === app.activeChatId ? " active" : ""}`);
    button.type = "button";
    const title = node("strong", "", chat.title);
    const meta = node("span", chat.needsBridge ? "bridge-label" : "", chat.needsBridge ? "Đang chờ bàn giao" : formatTime(chat.updatedAt));
    button.append(title, meta);
    button.addEventListener("click", () => {
      app.activeChatId = chat.id;
      render();
    });
    list.append(button);
  }
}

function renderTopbar() {
  const project = activeProject();
  const account = activeAccount();
  $("#project-title").textContent = project?.name || "Chọn dự án để bắt đầu";
  $("#new-chat").disabled = !project;
  const pill = $("#active-account-pill");
  pill.replaceChildren();
  const dot = node("span", `status-dot${account ? " online" : ""}`);
  pill.append(dot, node(
    "span",
    "",
    account
      ? `${account.label} · ${account.authenticated ? "sẵn sàng" : "chưa kết nối"}`
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
  $("#thread-status").textContent = chat.needsBridge
    ? "Đang chờ tài khoản mới tiếp quản"
    : chat.threadId
      ? `Phiên Codex · ${chat.threadId.slice(0, 8)}…`
      : "Chưa khởi tạo phiên Codex";
  const totalTokens = chat.usage.inputTokens + chat.usage.outputTokens;
  $("#usage-status").textContent = `${compactNumber(totalTokens)} token đã dùng`;
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

async function refreshUsage() {
  if (!app.state) {
    try {
      await loadState();
    } catch (error) {
      toast(`Chưa tải được dữ liệu: ${error.message}`);
      return;
    }
  }
  const accounts = app.state.accounts.filter((account) => account.authenticated);
  if (!accounts.length) {
    toast("Chưa có tài khoản Codex nào được kết nối.");
    return;
  }
  const button = $("#refresh-usage");
  button.disabled = true;
  button.textContent = "…";
  let failures = 0;
  for (const account of accounts) {
    try {
      await api(`/api/accounts/${account.id}/refresh`, { method: "POST", body: "{}" });
    } catch {
      failures += 1;
    }
  }
  await loadState();
  button.disabled = false;
  button.textContent = "↻";
  toast(failures
    ? `Đã cập nhật hạn mức cho ${accounts.length - failures}/${accounts.length} tài khoản.`
    : "Đã cập nhật hạn mức cho tất cả tài khoản Codex.");
}

function setJob(job) {
  app.activeJobId = job?.id || null;
  const running = job && ["queued", "running", "awaiting_approval"].includes(job.status);
  $("#job-strip").classList.toggle("hidden", !running);
  $("#send-message").disabled = Boolean(running);
  $("#message-input").disabled = Boolean(running);
  if (running) {
    $("#job-label").textContent = job.status === "awaiting_approval"
      ? "Đang chờ xác nhận AI phụ trợ…"
      : job.type === "login" ? "Đang chuyển tài khoản Codex…" : "Codex đang xử lý…";
    const lastEvent = job.events.at(-1);
    $("#job-event").textContent = lastEvent?.message || "Đang khởi tạo phiên";
  }
}

function showApproval(job) {
  const approval = job.approval;
  if (!approval) return;
  $("#approval-title").textContent = `Codex đề xuất dùng ${approval.providerLabel}`;
  $("#approval-reason").textContent = approval.reason;
  $("#approval-provider").textContent = `${approval.providerType} / ${approval.model}`;
  $("#approval-tokens").textContent = `~${compactNumber(approval.estimatedMaximumTokens)} token`;
  $("#approval-remaining").textContent = approval.remainingTokens === null
    ? "Chưa đặt ngân sách"
    : `${compactNumber(approval.remainingTokens)} token`;
  $("#approval-cost").textContent = approval.paidApi ? "API có thể phát sinh phí" : "Trong hạn mức gói/free";
  const data = $("#approval-data");
  data.replaceChildren();
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
  if (job.status === "awaiting_approval") {
    showApproval(job);
    return;
  }
  if (job.approvalMode === "auto" && job.type === "chat") {
    toast("Dự án đang cho phép tự động AI phụ trợ; mức sử dụng sẽ được báo sau lượt này.");
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
    if (["completed", "error", "cancelled", "needs_handoff"].includes(job.status)) {
      clearTimeout(app.pollTimer);
      setJob(null);
      await Promise.all([loadState(), loadStatus()]);
      if (job.status === "completed") {
        toast(job.type === "login"
          ? "Đã chuyển tài khoản. Cuộc trò chuyện hiện tại sẵn sàng tiếp tục."
          : job.auxiliaryReport
            ? `${job.auxiliaryReport.providerLabel} đã dùng ${compactNumber(job.auxiliaryReport.usage.totalTokens)} token; Codex đã hoàn tất yêu cầu.`
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
  $("#message-input").value = "";
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        chatId: chat.id,
        message,
        model: $("#model-input").value.trim(),
        sandbox: $("#sandbox-input").value,
        auxiliaryProviderId: $("#auxiliary-provider").value
      })
    });
    await loadState();
    startPolling(data.job);
  } catch (error) {
    toast(error.message);
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
      ? "Đã cho phép tự động trợ lý này trong dự án; mỗi lần sử dụng vẫn được thông báo."
      : approved ? "Đã cho phép AI phụ trợ trong lượt này." : "Đã từ chối AI phụ trợ; Codex sẽ tự tiếp tục.");
  } catch (error) {
    toast(error.message);
  } finally {
    approveButton.disabled = false;
    denyButton.disabled = false;
    autoButton.disabled = false;
  }
}

$("#add-account").addEventListener("click", () => openAccountDialog());
$("#refresh-usage").addEventListener("click", refreshUsage);
$("#add-project").addEventListener("click", () => $("#project-dialog").showModal());
$("#add-provider").addEventListener("click", () => openProviderDialog());
$("#new-chat").addEventListener("click", () => $("#chat-dialog").showModal());
for (const button of document.querySelectorAll(".dialog-cancel")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
$("#cancel-switch").addEventListener("click", () => $("#switch-dialog").close());
$("#confirm-switch").addEventListener("click", confirmAccountSwitch);
$("#continue-handoff").addEventListener("click", continueHandoff);
$("#approve-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("once"));
$("#auto-approve-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("project"));
$("#deny-auxiliary").addEventListener("click", () => resolveAuxiliaryApproval("deny"));

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const editing = app.editAccountId;
    const result = await api(editing ? `/api/accounts/${editing}` : "/api/accounts", {
      method: editing ? "PATCH" : "POST",
      body: JSON.stringify({
        label: $("#account-label").value,
        email: $("#account-email").value,
        plan: $("#account-plan").value,
        expiresAt: $("#account-expires-at").value,
        note: $("#account-note").value,
        ...(editing ? {} : { remaining: 100 })
      })
    });
    app.editAccountId = null;
    event.currentTarget.reset();
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
        : "Đã lưu tài khoản. Đang mở đăng nhập Codex…");
    }
  } catch (error) {
    toast(error.message);
  }
});

$("#provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
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
    event.currentTarget.reset();
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
  try {
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("#project-name").value,
        path: $("#project-path").value
      })
    });
    event.currentTarget.reset();
    $("#project-dialog").close();
    app.activeChatId = null;
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
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
    event.currentTarget.reset();
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

Promise.all([loadState(), loadStatus()]).catch((error) => toast(error.message));
