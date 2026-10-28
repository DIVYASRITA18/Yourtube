/* Multilingual comments */
const LANGS = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", ur: "Urdu",
  es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ru: "Russian", ja: "Japanese", ko: "Korean", "zh-CN": "Chinese", ar: "Arabic", tr: "Turkish", id: "Indonesian" };
const REASONS = { spam: "Spam", harassment: "Harassment", offensive: "Offensive content", hate: "Hate speech", misinformation: "Misinformation", other: "Other" };

function initComments(root, videoId) {
  let sort = "newest", lang = localStorage.getItem("cmLang") || "en", editMin = 15;
  const store = new Map();
  root.innerHTML = `<div class="row" style="justify-content:space-between"><h3 id="cCount">Comments</h3>
    <div class="row"><label class="small">Sort <select id="cSort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="liked">Most liked</option><option value="relevant">Most relevant</option></select></label>
    <label class="small">Translate to <select id="cLang">${Object.entries(LANGS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label></div></div>
    <div id="cNew"></div><div id="cList"></div>`;
  const $c = (s) => root.querySelector(s);
  $c("#cLang").value = lang;
  $c("#cSort").onchange = (e) => { sort = e.target.value; load(); };
  $c("#cLang").onchange = (e) => { lang = e.target.value; localStorage.setItem("cmLang", lang); $$(".tr", root).forEach((x) => x.remove()); };

  const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago"; return Math.floor(s / 86400) + " d ago"; };
  const body = (c) => esc(c.text).replace(/@([a-zA-Z0-9_.-]{3,20})/g, (m, n) => (c.mentions || []).includes(n.toLowerCase()) ? `<span class="mention">${m}</span>` : m);

  /* ---------- composer (used for new comments and replies) ---------- */
  function composer({ parentId = null, placeholder = "Add a comment... use @username to mention", onDone, onCancel }) {
    const el = document.createElement("div"); el.className = "composer"; el.style.position = "relative";
    el.innerHTML = `<textarea maxlength="500" placeholder="${esc(placeholder)}"></textarea>
      <div class="row" style="justify-content:space-between"><span class="small muted"><span class="cnt">0</span>/500</span>
      <span class="row">${onCancel ? '<button class="sm cancel">Cancel</button>' : ""}<button class="primary sm post">Post</button></span></div>
      <div class="cap" hidden><span class="q"></span> <input class="ans" size="4" placeholder="Answer"></div><div class="alert err" hidden></div><div class="suggest" hidden></div>`;
    const ta = $("textarea", el), err = $(".err", el), sug = $(".suggest", el), cap = $(".cap", el); let capId = null, st;
    ta.oninput = () => {
      $(".cnt", el).textContent = ta.value.length;
      const m = ta.value.slice(0, ta.selectionStart).match(/@([a-zA-Z0-9_.-]*)$/);
      clearTimeout(st); if (!m || !m[1]) { sug.hidden = true; return; }
      st = setTimeout(async () => {
        try {
          const users = await api("/auth/users?q=" + encodeURIComponent(m[1]));
          sug.innerHTML = users.map((u) => `<div data-u="${esc(u.username)}">${avatarImg(u, "")}<span>@${esc(u.username)} <span class="muted small">${esc(u.name)}</span></span></div>`).join(""); sug.hidden = !users.length;
        } catch { sug.hidden = true; }
      }, 200);
    };
    sug.onclick = (e) => {
      const d = e.target.closest("[data-u]"); if (!d) return;
      const pos = ta.selectionStart, before = ta.value.slice(0, pos).replace(/@([a-zA-Z0-9_.-]*)$/, "@" + d.dataset.u + " ");
      ta.value = before + ta.value.slice(pos); sug.hidden = true; ta.focus(); ta.oninput();
    };
    async function showCaptcha() { try { const c = await api("/comments/captcha"); capId = c.id; $(".q", el).textContent = "CAPTCHA: " + c.question; $(".ans", el).value = ""; cap.hidden = false; } catch {} }
    if (onCancel) $(".cancel", el).onclick = onCancel;
    $(".post", el).onclick = async (ev) => {
      if (!requireLogin()) return;
      const btn = ev.target; btn.disabled = true; err.hidden = true;
      const payload = { videoId, text: ta.value, parentId };
      if (!cap.hidden) { payload.captchaId = capId; payload.captchaAnswer = $(".ans", el).value; }
      try { await api("/comments", { method: "POST", body: payload }); ta.value = ""; $(".cnt", el).textContent = 0; cap.hidden = true; onDone?.(); }
      catch (e) { err.textContent = e.message; err.hidden = false; if (e.data?.captchaRequired) await showCaptcha(); }
      finally { btn.disabled = false; }
    };
    return el;
  }

  /* ---------- rendering ---------- */
  const actsHtml = (c) => c.removed ? "" : `<button data-a="like" class="${c.myVote === "like" ? "on" : ""}">👍 ${c.likes}</button>
    <button data-a="dislike" class="${c.myVote === "dislike" ? "on" : ""}">👎 ${c.dislikes}</button>
    <button data-a="reply">Reply</button><button data-a="translate">🌐 Translate</button>
    ${c.canEdit ? `<button data-a="edit">Edit</button><button data-a="delete">Delete</button>` : ""}
    ${c.mine ? "" : `<button data-a="report">🚩 Report</button>`}`;
  const itemHtml = (c) => { store.set(c._id, c); return `<div class="cm ${c.removed ? "removed" : ""}" data-id="${c._id}">
      ${c.removed ? `<div class="avatar"></div>` : avatarImg(c)}
      <div class="body"><div class="meta">${c.removed ? "" : `<b>@${esc(c.username)}</b> · ${esc(c.userName)} · 📍 ${esc(c.location)} · `}<span title="${esc(fmtDate(c.createdAt))}">${esc(fmtDate(c.createdAt))} (${ago(c.createdAt)})</span>${c.edited ? ` · <i title="Edited ${esc(fmtDate(c.editedAt))}">(edited)</i>` : ""}</div>
        <div class="txt">${body(c)}</div><div class="tr small muted" hidden></div>
        <div class="acts">${actsHtml(c)}</div><div class="rbox"></div>
        ${(c.replies || []).length ? `<div class="replies">${c.replies.map(itemHtml).join("")}</div>` : ""}</div></div>`; };

  async function load() {
    try {
      const d = await api(`/comments/video/${videoId}?sort=${sort}`); editMin = d.editMinutes;
      $c("#cCount").textContent = `${d.total} Comment${d.total === 1 ? "" : "s"}`;
      store.clear(); $c("#cList").innerHTML = d.comments.length ? d.comments.map(itemHtml).join("") : `<p class="muted">No comments yet. Be the first!</p>`;
    } catch (e) { $c("#cList").innerHTML = `<p class="alert err">${esc(e.message)} <button class="sm" id="retryC">Retry</button></p>`; const b = $c("#retryC"); if (b) b.onclick = load; }
  }
  const refreshOne = (c) => {
    const el = $c(`.cm[data-id="${c._id}"]`); if (!el) return load(); store.set(c._id, { ...store.get(c._id), ...c });
    $(".acts", el).innerHTML = actsHtml(store.get(c._id));
  };

  /* ---------- actions (event delegation) ---------- */
  $c("#cList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-a]"); if (!btn) return;
    const el = btn.closest(".cm"), id = el.dataset.id, c = store.get(id), a = btn.dataset.a;
    const need = ["like", "dislike", "reply", "edit", "delete", "report", "translate"].includes(a); if (need && !requireLogin()) return;
    try {
      if (a === "like" || a === "dislike") refreshOne(await api(`/comments/${id}/vote`, { method: "POST", body: { type: a } }));
      else if (a === "reply") {
        const box = $(".rbox", el); if (box.firstChild) { box.innerHTML = ""; return; }
        box.appendChild(composer({ parentId: id, placeholder: `Reply to @${c.username}...`, onDone: load, onCancel: () => (box.innerHTML = "") })); $("textarea", box).focus();
      } else if (a === "translate") {
        const out = $(".tr", el);
        if (!out.hidden && out.dataset.lang === lang) { out.hidden = true; return; }
        out.hidden = false; out.dataset.lang = lang; out.textContent = "Translating..."; btn.disabled = true;
        try { const r = await api("/comments/translate", { method: "POST", body: { text: c.text, target: lang } }); out.innerHTML = `🌐 <b>${esc(LANGS[lang])}:</b> ${esc(r.translated)}`; }
        catch (er) { out.innerHTML = `⚠ ${esc(er.message)} <button class="sm" data-a="translate">Retry</button>`; out.dataset.lang = ""; }
        btn.disabled = false;
      } else if (a === "edit") {
        const txt = $(".txt", el), old = c.text; txt.innerHTML = ""; const ta = document.createElement("textarea"); ta.value = old; ta.maxLength = 500; ta.style.width = "100%";
        const row = document.createElement("div"); row.className = "row";
        row.innerHTML = `<button class="primary sm s">Save</button><button class="sm x">Cancel</button><span class="small muted">You can edit for ${editMin} min after posting.</span><span class="err small" style="color:#f88"></span>`;
        txt.append(ta, row);
        $(".x", row).onclick = () => (txt.innerHTML = body(c));
        $(".s", row).onclick = async () => {
          try { refreshOne(await api(`/comments/${id}`, { method: "PUT", body: { text: ta.value, version: c.version } })); load(); }
          catch (er) { if (er.data?.conflict) { toast(er.message, "error"); load(); } else $(".err", row).textContent = er.message; }
        };
      } else if (a === "delete") {
        if (!confirm("Delete this comment?")) return; await api(`/comments/${id}`, { method: "DELETE" }); toast("Comment deleted", "success"); load();
      } else if (a === "report") report(id);
    } catch (er) { toast(er.message, "error"); if (er.status === 404 || er.status === 403) load(); }
  });

  function report(id) {
    const bg = document.createElement("div"); bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal"><h3>Report comment</h3><select>${Object.entries(REASONS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
      <textarea placeholder="Extra details (optional)" maxlength="300"></textarea><div class="row" style="justify-content:flex-end"><button class="x">Cancel</button><button class="primary s">Submit report</button></div>
      <p class="small muted">Reported comments are reviewed by a moderator. They are never removed automatically.</p></div>`;
    document.body.appendChild(bg);
    $(".x", bg).onclick = () => bg.remove();
    $(".s", bg).onclick = async () => {
      try { const r = await api(`/comments/${id}/report`, { method: "POST", body: { reason: $("select", bg).value, details: $("textarea", bg).value } }); toast(r.message, "success"); bg.remove(); }
      catch (er) { toast(er.message, "error"); if (er.status === 409) bg.remove(); }
    };
  }

  $c("#cNew").appendChild(composer({ onDone: load }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !document.activeElement?.closest?.("textarea")) load(); });
  load();
}
