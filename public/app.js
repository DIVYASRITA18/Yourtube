/* Shared helpers used by every page */
const API = (window.API_BASE || "") + "/api";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const token = () => localStorage.getItem("token");
const me = () => { try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; } };
function deviceId() {
  let d = localStorage.getItem("deviceId");
  if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)); localStorage.setItem("deviceId", d); }
  return d;
}
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = "Bearer " + token();
  let r;
  try { r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error("Network error. Please check your connection and try again."), { network: true }); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token() && !/login\.html/.test(location.pathname)) {
    logoutLocal(); location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search); throw new Error("Session expired");
  }
  if (!r.ok) throw Object.assign(new Error(data.message || "Something went wrong"), { status: r.status, data });
  return data;
}
function logoutLocal() { localStorage.removeItem("token"); localStorage.removeItem("user"); }
function requireLogin() {
  if (!token()) { location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search); return false; }
  return true;
}
function toast(msg, type = "") {
  const t = document.createElement("div"); t.className = "toast " + type; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function applyTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); }
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
const fmtSize = (b) => !b ? "-" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(0) + " KB";
const fmtDate = (d) => d ? new Date(d).toLocaleString() : "-";
const avatarImg = (u, cls = "avatar") => `<img class="${cls}" src="${esc(u.avatar || "")}" alt="" onerror="this.style.visibility='hidden'">`;

async function renderNav(active) {
  const u = me();
  const links = [["/", "Home", "home"], ["/subscription.html", "Plans", "plans"], ["/downloads.html", "Downloads", "downloads"], ["/call.html", "Video Call", "call"], ["/security.html", "Security", "security"]];
  if (u?.role === "admin") links.push(["/admin.html", "Admin", "admin"]);
  const h = document.createElement("header"); h.className = "nav";
  h.innerHTML = `<a class="logo" href="/"><b>▶</b> YouTube 2.0</a><button class="burger" aria-label="menu">☰</button>
    <nav>${links.map(([href, label, key]) => `<a href="${href}" class="${key === active ? "active" : ""}">${label}</a>`).join("")}</nav>
    <div class="right"><button id="themeBtn" title="Toggle theme">${document.documentElement.dataset.theme === "light" ? "🌙" : "☀️"}</button>
    ${u ? `<span class="small muted">${esc(u.name)} <span class="badge ${u.plan}">${esc(u.plan)}</span></span><button id="logoutBtn" class="sm">Logout</button>` : `<a class="btn primary" href="/login.html">Login</a>`}</div>`;
  document.body.prepend(h);
  $(".burger", h).onclick = () => $("nav", h).classList.toggle("open");
  $("#themeBtn", h).onclick = async () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next); $("#themeBtn").textContent = next === "light" ? "🌙" : "☀️";
    if (token()) { try { await api("/auth/theme", { method: "PUT", body: { theme: next } }); } catch {} }
  };
  const lo = $("#logoutBtn", h); if (lo) lo.onclick = () => { logoutLocal(); location.href = "/login.html"; };
  if (token()) { // sync profile (theme/plan) so it follows the user across devices
    try {
      const fresh = await api("/auth/me"); localStorage.setItem("user", JSON.stringify(fresh));
      if (fresh.theme !== document.documentElement.dataset.theme) { applyTheme(fresh.theme); $("#themeBtn").textContent = fresh.theme === "light" ? "🌙" : "☀️"; }
    } catch {}
  }
}
