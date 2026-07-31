const app = {
  state: null,
  activeChatId: null,
  activeJobId: null,
  switchAccountId: null,
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
    const card = node("button", `account-card${account.id === app.state.activeAccountId ? " active" : ""}`);
    card.type = "button";
    card.title = account.id === app.state.activeAccountId ? "Tài khoản đang chọn" : "Đăng nhập tài khoản này";

    const top = node("div", "account-top");
    const dot = node("span", `status-dot ${account.status === "available" ? "online" : "warning"}`);
    const title = node("strong", "", account.label);
    const plan = node("span", "plan-badge", account.plan);
    top.append(dot, title, plan);

    const loginState = account.authenticated ? "đã đăng nhập" : "chưa đăng nhập";
    const email = node("small", "", `${account.email || "Chưa ghi email"} · ${loginState}`);
    const usage = node("div", "usage-row");
    const bar = node("span", "usage-bar");
    const fill = node("i");
    fill.style.width = `${account.remaining}%`;
    bar.append(fill);
    usage.append(bar, node("span", "", `${Math.round(account.remaining)}%`));
    const syncText = account.syncError
      ? "Không đọc được limit · bấm ↻ để thử lại"
      : account.remainingSource === "automatic"
        ? `Tự động${account.resetAt ? ` · reset ${formatReset(account.resetAt)}` : ""}`
        : account.authenticated
          ? "Chờ đồng bộ limit"
          : "Đăng nhập để tự đọc limit";
    const syncMeta = node("small", `sync-meta${account.syncError ? " error" : ""}`, syncText);
    card.append(top, email, usage, syncMeta);
    card.addEventListener("click", () => requestAccountSwitch(account));
    list.append(card);
  }
  if (!app.state.accounts.length) {
    const empty = node("button", "account-card");
    empty.type = "button";
    empty.textContent = "＋ Thêm tài khoản đầu tiên";
    empty.addEventListener("click", () => $("#account-dialog").showModal());
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
    empty.textContent = "＋ Thêm thư mục dự án";
    empty.addEventListener("click", () => $("#project-dialog").showModal());
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
  $("#chat-count").textContent = `${chats.length} chat`;
  for (const chat of chats) {
    const button = node("button", `chat-item${chat.id === app.activeChatId ? " active" : ""}`);
    button.type = "button";
    const title = node("strong", "", chat.title);
    const meta = node("span", chat.needsBridge ? "bridge-label" : "", chat.needsBridge ? "Sẽ nối tài khoản mới" : formatTime(chat.updatedAt));
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
  $("#project-title").textContent = project?.name || "Chọn một dự án";
  $("#new-chat").disabled = !project;
  const pill = $("#active-account-pill");
  pill.replaceChildren();
  const dot = node("span", `status-dot${account ? " online" : ""}`);
  pill.append(dot, node(
    "span",
    "",
    account
      ? `${account.label} · ${account.authenticated ? "sẵn sàng" : "chưa đăng nhập"}`
      : "Chưa có tài khoản"
  ));
}

function renderContext() {
  const project = activeProject();
  $("#context-empty").classList.toggle("hidden", Boolean(project));
  $("#context-form").classList.toggle("hidden", !project);
  if (project) {
    $("#summary-input").value = project.summary || "";
    $("#next-step-input").value = project.nextStep || "";
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
    ? "Chờ nối sang tài khoản mới"
    : chat.threadId
      ? `Session ${chat.threadId.slice(0, 8)}…`
      : "Chưa tạo Codex session";
  const totalTokens = chat.usage.inputTokens + chat.usage.outputTokens;
  $("#usage-status").textContent = `${compactNumber(totalTokens)} tokens`;
  $("#bridge-note").textContent = chat.needsBridge
    ? "Lượt tiếp theo sẽ dùng tóm tắt + 8 tin gần nhất"
    : "Lịch sử được lưu local";

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
      ? "Codex đã đăng nhập"
      : data.codex.installed
        ? "Codex chưa đăng nhập"
        : "Chưa tìm thấy Codex CLI";
  } catch {
    $("#codex-status").textContent = "Không kết nối được server";
    $("#codex-dot").className = "status-dot warning";
  }
}

function requestAccountSwitch(account) {
  if (account.id === app.state.activeAccountId && account.authenticated) {
    toast(`${account.label} đang là tài khoản được chọn.`);
    return;
  }
  app.switchAccountId = account.id;
  $("#switch-title").textContent = account.authenticated
    ? `Chuyển sang ${account.label}?`
    : `Đăng nhập ${account.label}?`;
  $("#confirm-switch").textContent = account.authenticated ? "Chuyển ngay" : "Mở đăng nhập một lần";
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
      ? "Đã chuyển sang profile đăng nhập có sẵn."
      : "Đang mở luồng đăng nhập Codex chính thức…");
  } catch (error) {
    toast(error.message);
  }
}

async function refreshUsage() {
  const accounts = app.state.accounts.filter((account) => account.authenticated);
  if (!accounts.length) {
    toast("Chưa có tài khoản nào đã đăng nhập.");
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
    ? `Đã cập nhật ${accounts.length - failures}/${accounts.length} tài khoản.`
    : "Đã tự động cập nhật limit tất cả tài khoản.");
}

function setJob(job) {
  app.activeJobId = job?.id || null;
  const running = job && ["queued", "running"].includes(job.status);
  $("#job-strip").classList.toggle("hidden", !running);
  $("#send-message").disabled = Boolean(running);
  $("#message-input").disabled = Boolean(running);
  if (running) {
    $("#job-label").textContent = job.type === "login" ? "Đang đổi tài khoản…" : "Codex đang làm việc…";
    const lastEvent = job.events.at(-1);
    $("#job-event").textContent = lastEvent?.message || "Đang chuẩn bị";
  }
}

function startPolling(job) {
  setJob(job);
  clearTimeout(app.pollTimer);
  app.pollTimer = setTimeout(pollJob, 600);
}

async function pollJob() {
  if (!app.activeJobId) return;
  try {
    const data = await api(`/api/jobs/${app.activeJobId}`);
    const job = data.job;
    setJob(job);
    if (["completed", "error", "cancelled"].includes(job.status)) {
      clearTimeout(app.pollTimer);
      setJob(null);
      await Promise.all([loadState(), loadStatus()]);
      if (job.status === "completed") {
        toast(job.type === "login" ? "Đã đổi tài khoản. Chat cũ sẵn sàng tiếp tục." : "Codex đã hoàn tất lượt.");
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
        sandbox: $("#sandbox-input").value
      })
    });
    await loadState();
    startPolling(data.job);
  } catch (error) {
    toast(error.message);
  }
}

$("#add-account").addEventListener("click", () => $("#account-dialog").showModal());
$("#refresh-usage").addEventListener("click", refreshUsage);
$("#add-project").addEventListener("click", () => $("#project-dialog").showModal());
$("#new-chat").addEventListener("click", () => $("#chat-dialog").showModal());
for (const button of document.querySelectorAll(".dialog-cancel")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
$("#cancel-switch").addEventListener("click", () => $("#switch-dialog").close());
$("#confirm-switch").addEventListener("click", confirmAccountSwitch);

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        label: $("#account-label").value,
        email: $("#account-email").value,
        plan: $("#account-plan").value,
        remaining: 100
      })
    });
    event.currentTarget.reset();
    $("#account-dialog").close();
    await loadState();
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
        nextStep: $("#next-step-input").value
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
  } catch (error) {
    toast(error.message);
  }
});

Promise.all([loadState(), loadStatus()]).catch((error) => toast(error.message));
