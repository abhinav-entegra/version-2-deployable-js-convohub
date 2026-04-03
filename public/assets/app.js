const TOKEN_KEY = "convohub_token";
const USER_KEY = "convohub_user";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function setUser(u) {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

function getUserStored() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.body && typeof opts.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`/api${path}`, { ...opts, headers, credentials: "include" });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const err = (data && data.error) || (data && data.detail) || r.statusText;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  return data;
}

function showAuthError(msg) {
  const box = el("auth-error");
  if (!box) return;
  if (!msg) {
    box.textContent = "";
    box.classList.add("hidden");
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

async function auth(path, body) {
  const r = await fetch(`/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    const msg =
      typeof d === "string"
        ? d
        : d && typeof d === "object"
          ? d.message || JSON.stringify(d)
          : data.error || data.message || `Auth failed (${r.status})`;
    throw new Error(msg);
  }
  return data;
}

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  channels: [],
  members: [],
  ecosystems: [],
  activeChannel: null,
  activeDm: null,
  ws: null,
};

function showAuth() {
  el("view-auth").classList.remove("hidden");
  el("view-app").classList.add("hidden");
}

function showApp() {
  el("view-auth").classList.add("hidden");
  el("view-app").classList.remove("hidden");
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;
  el("conn-pill").textContent = "…";
  el("conn-pill").classList.remove("online", "offline");
  ws.onopen = async () => {
    try {
      const { token } = await api("/socket_token");
      ws.send(JSON.stringify({ type: "auth", token }));
    } catch {
      el("conn-pill").textContent = "err";
    }
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "auth_ok") {
        el("conn-pill").textContent = "live";
        el("conn-pill").classList.add("online");
        el("conn-pill").classList.remove("offline");
      }
      if (msg.type === "new_message") {
        refreshThread();
        loadUnread();
      }
      if (msg.type === "workspace_roster_changed") {
        loadMembers();
        loadEcosystems();
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    el("conn-pill").textContent = "off";
    el("conn-pill").classList.add("offline");
    el("conn-pill").classList.remove("online");
    setTimeout(connectWs, 2500);
  };
}

async function loadChannels() {
  state.channels = await api("/get_channels");
  const ul = el("channel-list");
  ul.innerHTML = "";
  for (const c of state.channels) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.chName = c.name;
    b.textContent = `# ${c.display_name || c.name}`;
    b.addEventListener("click", () => openChannel(c));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

async function loadMembers() {
  state.members = await api("/get_workspace_members");
  renderPeople(state.members);
  renderDmList(state.members);
}

function renderPeople(list) {
  const ul = el("people-list");
  ul.innerHTML = "";
  const q = (el("member-search").value || "").toLowerCase();
  for (const m of list) {
    if (q && !(`${m.name} ${m.email}`.toLowerCase().includes(q))) continue;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `${m.name} · ${m.email}`;
    b.addEventListener("click", () => openDm(m));
    ul.appendChild(li);
    li.appendChild(b);
  }
}

function renderDmList(list) {
  const ul = el("dm-list");
  ul.innerHTML = "";
  for (const m of list) {
    if (m.id === state.user?.id) continue;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = m.name;
    b.addEventListener("click", () => openDm(m));
    ul.appendChild(li);
    li.appendChild(b);
  }
}

async function loadEcosystems() {
  state.ecosystems = await api("/get_ecosystems");
  const sel = el("ecosystem-select");
  sel.innerHTML = "";
  const cur = state.user?.workspace_id;
  for (const w of state.ecosystems) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.name;
    if (Number(w.id) === Number(cur)) o.selected = true;
    sel.appendChild(o);
  }
  const ul = el("ecosystem-list");
  ul.innerHTML = "";
  for (const w of state.ecosystems) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `${w.name}${w.is_private ? " · private" : " · public"}`;
    b.addEventListener("click", async () => {
      await api("/switch_workspace", {
        method: "POST",
        body: JSON.stringify({ workspace_id: w.id }),
      });
      await bootData();
    });
    ul.appendChild(li);
    li.appendChild(b);
  }
}

function openChannel(c) {
  state.activeChannel = c;
  state.activeDm = null;
  el("thread-title").textContent = `# ${c.display_name || c.name}`;
  document.querySelectorAll("#channel-list button").forEach((b) => {
    b.classList.toggle("active", b.dataset.chName === c.name);
  });
  refreshThread();
}

function openDm(m) {
  state.activeDm = m;
  state.activeChannel = null;
  el("thread-title").textContent = m.name;
  refreshThread();
}

async function refreshThread() {
  const box = el("messages");
  box.innerHTML = "";
  let rows = [];
  if (state.activeChannel) {
    const q = new URLSearchParams({ channel_name: state.activeChannel.name });
    rows = await api(`/get_messages?${q}`);
  } else if (state.activeDm) {
    const q = new URLSearchParams({ receiver_id: String(state.activeDm.id) });
    rows = await api(`/get_messages?${q}`);
  }
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "msg" + (r.is_me ? " me" : "");
    div.innerHTML = `<div class="msg-meta">${r.sender_name} · ${r.timestamp}</div><div class="msg-body"></div>`;
    div.querySelector(".msg-body").textContent = r.content || "";
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function sendCurrent() {
  const text = el("composer-input").value.trim();
  if (!text) return;
  const body = { content: text, type: "text" };
  if (state.activeChannel) body.channel_name = state.activeChannel.name;
  else if (state.activeDm) body.receiver_id = state.activeDm.id;
  else return;
  await api("/send_message", { method: "POST", body: JSON.stringify(body) });
  el("composer-input").value = "";
  await refreshThread();
  await loadUnread();
}

async function loadUnread() {
  try {
    const ch = await api("/get_channel_unread");
    await api("/get_unread_counts");
    document.querySelectorAll("#channel-list button").forEach((b) => {
      const name = b.dataset.chName;
      const c = state.channels.find((x) => x.name === name);
      if (!c) return;
      const n = ch[c.name] || 0;
      b.textContent = `# ${c.display_name || c.name}${n ? ` (${n})` : ""}`;
    });
  } catch {
    /* ignore */
  }
}

async function bootData() {
  const payload = parseJwtPayload(getToken());
  const stored = getUserStored();
  state.user = stored || {
    id: payload ? Number(payload.sub) : null,
    email: payload?.email,
  };
  await loadChannels();
  await loadMembers();
  await loadEcosystems();
  await loadUnread();
}

function parseJwtPayload(token) {
  if (!token) return null;
  try {
    const p = token.split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function openModal(html) {
  el("modal-body").innerHTML = html;
  el("modal").classList.remove("hidden");
}

function closeModal() {
  el("modal").classList.add("hidden");
}

function redirectAfterLogin(user) {
  const r = (user?.role || "").toLowerCase();
  if (r === "admin" || r === "superadmin") {
    window.location.href = "/admin";
  } else {
    window.location.href = "/dashboard";
  }
}

el("form-login-member").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  try {
    const fd = new FormData(e.target);
    const data = await auth("/login/client", {
      email: (fd.get("email") || "").trim().toLowerCase(),
      password: fd.get("password") || "",
    });
    setToken(data.access_token);
    if (data.user) setUser(data.user);
    redirectAfterLogin(data.user);
  } catch (err) {
    showAuthError(err.message || String(err));
  }
});

el("form-login-admin").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  try {
    const fd = new FormData(e.target);
    const data = await auth("/login/admin", {
      email: (fd.get("email") || "").trim().toLowerCase(),
      password: fd.get("password") || "",
    });
    setToken(data.access_token);
    if (data.user) setUser(data.user);
    redirectAfterLogin(data.user);
  } catch (err) {
    showAuthError(err.message || String(err));
  }
});

const adminPanel = el("admin-login-panel");
const adminToggle = el("btn-toggle-admin-login");
if (adminToggle && adminPanel) {
  adminToggle.addEventListener("click", () => {
    const open = adminPanel.classList.toggle("hidden");
    adminToggle.setAttribute("aria-expanded", open ? "false" : "true");
  });
}

el("form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  try {
    const fd = new FormData(e.target);
    await auth("/register", {
      email: (fd.get("email") || "").trim().toLowerCase(),
      password: fd.get("password") || "",
      role: "user",
    });
    openModal("<p>Account created. Sign in.</p>");
  } catch (err) {
    showAuthError(err.message || String(err));
  }
});

el("btn-logout").addEventListener("click", () => {
  setToken(null);
  setUser(null);
  if (state.ws) state.ws.close();
  showAuth();
});

el("btn-send").addEventListener("click", sendCurrent);
el("composer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});

el("ecosystem-select").addEventListener("change", async (e) => {
  const id = Number(e.target.value);
  if (!Number.isFinite(id)) return;
  await api("/switch_workspace", { method: "POST", body: JSON.stringify({ workspace_id: id }) });
  const u = getUserStored() || state.user || {};
  setUser({ ...u, workspace_id: id });
  await bootData();
});

el("btn-new-ws").addEventListener("click", async () => {
  const name = prompt("Ecosystem name");
  if (!name) return;
  await api("/create_ecosystem", {
    method: "POST",
    body: JSON.stringify({ name, is_private: true, sync_members: false }),
  });
  await bootData();
});

el("member-search").addEventListener("input", () => renderPeople(state.members));

document.querySelectorAll(".drawer-tabs .tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".drawer-tabs .tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const tab = t.dataset.tab;
    el("tab-people").classList.toggle("hidden", tab !== "people");
    el("tab-ecosystems").classList.toggle("hidden", tab !== "ecosystems");
  });
});

el("btn-activity").addEventListener("click", async () => {
  const rows = await api("/get_activity");
  openModal(
    `<h3>Activity</h3><ul style="padding-left:1rem">${rows
      .map((r) => `<li><small>${r.time}</small><br/>${r.content}</li>`)
      .join("")}</ul>`
  );
});

el("btn-transfers").addEventListener("click", async () => {
  const data = await api("/transfer_requests_pending");
  openModal(
    `<h3>Transfers</h3><p>Incoming</p><ul>${data.incoming
      .map((r) => `<li>${r.member_email} → ${r.to_team} <button data-aid="${r.id}" class="btn ghost tx-a">Accept</button> <button data-did="${r.id}" class="btn ghost tx-d">Decline</button></li>`)
      .join("")}</ul><p>Outgoing</p><ul>${data.outgoing.map((r) => `<li>${r.member_email}</li>`).join("")}</ul>`
  );
  el("modal-body").querySelectorAll(".tx-a").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/transfer_member_respond", {
        method: "POST",
        body: JSON.stringify({ request_id: Number(b.dataset.aid), accept: true }),
      });
      closeModal();
    })
  );
  el("modal-body").querySelectorAll(".tx-d").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/transfer_member_respond", {
        method: "POST",
        body: JSON.stringify({ request_id: Number(b.dataset.did), accept: false }),
      });
      closeModal();
    })
  );
});

el("btn-join-public").addEventListener("click", async () => {
  const list = await api("/get_public_ecosystems");
  openModal(
    `<h3>Public ecosystems</h3><ul>${list
      .map(
        (w) =>
          `<li>${w.name} <button class="btn ghost jn" data-w="${w.id}">Join</button></li>`
      )
      .join("")}</ul>`
  );
  el("modal-body").querySelectorAll(".jn").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/join_ecosystem", {
        method: "POST",
        body: JSON.stringify({ workspace_id: Number(b.dataset.w) }),
      });
      closeModal();
      await bootData();
    })
  );
});

el("modal-close").addEventListener("click", closeModal);

(async function bootstrapHome() {
  let sessionOk = false;
  try {
    const r = await fetch("/auth/session", { credentials: "include" });
    if (r.ok) {
      sessionOk = true;
      const d = await r.json();
      if (d.access_token) setToken(d.access_token);
      if (d.user) setUser(d.user);
      window.location.replace(
        (() => {
          const role = (d.user?.role || "").toLowerCase();
          return role === "admin" || role === "superadmin" ? "/admin" : "/dashboard";
        })()
      );
      return;
    }
  } catch (_) {
    /* network error — treat as no session */
  }

  /* Stale localStorage + missing/expired cookie used to redirect to /dashboard, which sent users back to / in a loop. */
  if (!sessionOk) {
    setToken(null);
    setUser(null);
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("portal") === "admin" && adminPanel && adminToggle) {
    adminPanel.classList.remove("hidden");
    adminToggle.setAttribute("aria-expanded", "true");
  }

  showAuth();
})();
