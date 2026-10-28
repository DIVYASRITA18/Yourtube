/* WebRTC mesh video call. Signalling: Socket.IO (see call.js on the server) */
renderNav("call");
if (!requireLogin()) throw new Error("login");
const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
const EMOJIS = ["😀", "😂", "😍", "👍", "👏", "🎉", "🙏", "❤️", "😮", "🔥"];
let socket, myId = null, roomId = null, local = new MediaStream(), notes = [];
let room = { hostId: null, cohosts: [], locked: false, permissions: { screen: true, chat: true } };
const info = new Map(), conns = new Map(), analysers = new Map();
let camTrack = null, sharing = false, screenStream = null, handUp = false, lowData = false, autoLow = false, poorCount = 0, goodCount = 0;
let audioCtx = null, rec = null, recDest = null, recTimer = null, startTs = 0, joined = false;
const ack = (ev, data) => new Promise((r) => socket.emit(ev, data, r));
const lmsg = (t, c = "err") => ($("#lmsg").innerHTML = t ? `<div class="alert ${c}">${esc(t)}</div>` : "");

/* ---------------- lobby / media ---------------- */
const qRoom = new URLSearchParams(location.search).get("room");
if (qRoom) $("#roomIn").value = qRoom;
const pend = sessionStorage.getItem("callMsg"); if (pend) { lmsg(pend, "okk"); sessionStorage.removeItem("callMsg"); }

async function getLocal() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }; // background noise suppression
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } };
  if (!navigator.mediaDevices?.getUserMedia) { notes.push("Your browser does not support camera/microphone access (use HTTPS or localhost)."); return new MediaStream(); }
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); } catch {}
  try { const s = await navigator.mediaDevices.getUserMedia({ audio }); notes.push("Camera unavailable or permission denied - joining with microphone only."); return s; } catch {}
  try { const s = await navigator.mediaDevices.getUserMedia({ video }); notes.push("Microphone unavailable or permission denied - others cannot hear you."); return s; } catch {}
  notes.push("Camera and microphone are blocked. You can still watch, listen and chat. Allow access in the browser address bar and re-join to speak.");
  return new MediaStream();
}
(async () => {
  local = await getLocal(); camTrack = local.getVideoTracks()[0] || null;
  $("#preview").srcObject = local;
  if (notes.length) lmsg(notes.join(" "), "err");
  $("#pvCam").onchange = (e) => local.getVideoTracks().forEach((t) => (t.enabled = e.target.checked));
  $("#pvMic").onchange = (e) => local.getAudioTracks().forEach((t) => (t.enabled = e.target.checked));
})();
const slug = () => Math.random().toString(36).slice(2, 5) + "-" + Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 5);
$("#create").onclick = () => start(slug());
$("#join").onclick = () => {
  let v = $("#roomIn").value.trim(); try { const u = new URL(v); v = u.searchParams.get("room") || v; } catch {}
  if (!v) return lmsg("Enter a room ID or meeting link."); start(v.toLowerCase());
};

function loadSocketIo() {
  return new Promise((res, rej) => {
    if (window.io) return res();
    const s = document.createElement("script"); s.src = (window.API_BASE || "") + "/socket.io/socket.io.js"; s.onload = res; s.onerror = () => rej(new Error("Could not reach the call server."));
    document.head.appendChild(s);
  });
}
async function start(id) {
  roomId = id; lmsg("");
  try { await loadSocketIo(); } catch (e) { return lmsg(e.message); }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume();
  socket = io(window.API_BASE || undefined, { auth: { token: token() }, reconnection: true, reconnectionDelay: 800 });
  wireSocket();
}

/* ---------------- socket events ---------------- */
function wireSocket() {
  socket.on("connect_error", (e) => { if (!joined) { lmsg(e.message === "auth" ? "Please log in again." : "Could not connect to the call server."); socket.close(); } else banner("Connection lost - reconnecting..."); });
  socket.on("disconnect", () => banner("Connection lost - reconnecting..."));
  socket.on("connect", join);
  socket.on("peer-joined", (p) => { info.set(p.id, p); createConn(p.id); updateTile(p.id); renderPeople(); adapt(); if (p.id !== myId) toast(p.name + " joined"); });
  socket.on("peer-left", ({ id, reason }) => { closeConn(id); $(`#tile-${id}`)?.remove(); const n = info.get(id)?.name; info.delete(id); renderPeople(); adapt(); if (n) toast(`${n} ${reason === "removed" ? "was removed" : "left"}`); });
  socket.on("peer-state", (p) => { info.set(p.id, p); updateTile(p.id); renderPeople(); });
  socket.on("room-state", (s) => { room = s; renderRole(); renderPeople(); });
  socket.on("signal", onSignal);
  socket.on("force-mute", () => { setMic(false); toast("The host muted you"); });
  socket.on("kicked", () => leave("You were removed from the meeting by the host."));
  socket.on("ended", () => leave("The host ended the meeting."));
  socket.on("replaced", () => leave("You joined this meeting from another browser or device."));
  socket.on("chat", addChat);
}
async function join() {
  const res = await ack("join", { room: roomId });
  if (res.error) { socket.close(); $("#lobby").hidden = false; $("#callUI").hidden = true; return lmsg(res.error); }
  const reconnect = joined; joined = true; myId = res.me; room = res.state; banner("");
  info.clear(); res.peers.forEach((p) => info.set(p.id, p));
  [...conns.keys()].forEach(closeConn);
  $("#lobby").hidden = true; $("#callUI").hidden = false; $("#roomName").textContent = "Room: " + roomId;
  history.replaceState(null, "", "?room=" + roomId);
  res.peers.forEach((p) => { if (p.id !== myId) createConn(p.id); updateTile(p.id); });
  attachLocal();
  if (!reconnect) { startTs = Date.now(); notes.forEach((n) => toast(n, "error")); setInterval(() => { const s = Math.floor((Date.now() - startTs) / 1000); $("#dur").textContent = fmtTime(s); }, 1000); setInterval(statsLoop, 3000); setInterval(speakLoop, 200); }
  socket.emit("state", { muted: !local.getAudioTracks().some((t) => t.enabled), cam: local.getVideoTracks().some((t) => t.enabled) });
  renderRole(); renderPeople(); adapt();
  if (navigator.mediaDevices?.enumerateDevices) navigator.mediaDevices.enumerateDevices().then((d) => ($("#bSwitch").hidden = d.filter((x) => x.kind === "videoinput").length < 2));
}
const banner = (t) => ($("#banner").innerHTML = t ? `<span class="badge warn">${esc(t)}</span>` : "");

/* ---------------- peer connections (perfect negotiation) ---------------- */
function createConn(id) {
  if (id === myId) return;
  closeConn(id);
  const pc = new RTCPeerConnection(ICE);
  const c = { pc, polite: myId < id, making: false, ignore: false, stream: new MediaStream(), q: "", last: { rx: 0, lost: 0 } };
  conns.set(id, c);
  pc.onicecandidate = (e) => e.candidate && socket.emit("signal", { to: id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    const s = e.streams[0] || c.stream; if (!e.streams[0]) s.addTrack(e.track); c.stream = s;
    ensureTile(id); $(`#tile-${id} video`).srcObject = s; watchAudio(id, s); recAdd(s);
  };
  pc.onnegotiationneeded = async () => {
    try { c.making = true; await pc.setLocalDescription(); socket.emit("signal", { to: id, data: { description: pc.localDescription } }); }
    catch (e) { console.warn(e); } finally { c.making = false; }
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") pc.restartIce(); };
  const out = sharing && screenStream ? local.getAudioTracks().concat(screenStream.getVideoTracks()) : local.getTracks();
  out.forEach((t) => pc.addTrack(t, local));
  if (!local.getAudioTracks().length) pc.addTransceiver("audio", { direction: "recvonly" });
  if (!out.some((t) => t.kind === "video")) pc.addTransceiver("video", { direction: "recvonly" });
  setTimeout(adapt, 1500);
  return c;
}
function closeConn(id) { const c = conns.get(id); if (c) { c.pc.close(); conns.delete(id); } analysers.delete(id); }
async function onSignal({ from, data }) {
  const c = conns.get(from) || createConn(from); if (!c) return; const pc = c.pc;
  try {
    if (data.description) {
      const collision = data.description.type === "offer" && (c.making || pc.signalingState !== "stable");
      c.ignore = !c.polite && collision; if (c.ignore) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") { await pc.setLocalDescription(); socket.emit("signal", { to: from, data: { description: pc.localDescription } }); }
    } else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!c.ignore) console.warn(e); } }
  } catch (e) { console.warn("signal error", e); }
}

/* ---------------- tiles ---------------- */
function ensureTile(id) {
  let t = $(`#tile-${id}`); if (t) return t;
  t = document.createElement("div"); t.className = "tile"; t.id = "tile-" + id;
  t.innerHTML = `<video autoplay playsinline ${id === myId ? "muted" : ""}></video><div class="noncam">👤</div><div class="q"></div><div class="st"></div><div class="nm"></div>`;
  $("#grid").appendChild(t); return t;
}
function updateTile(id) {
  const p = info.get(id) || {}, t = ensureTile(id);
  $(".nm", t).textContent = (p.name || "Participant") + (id === myId ? " (You)" : "") + (id === room.hostId ? " ★" : "");
  $(".st", t).textContent = [p.muted ? "🔇" : "", p.hand ? "✋" : "", p.sharing ? "🖥" : "", p.online === false ? "⚠ reconnecting" : ""].filter(Boolean).join(" ");
  t.classList.toggle("nocam", p.cam === false && !p.sharing);
  if (id === myId) $(".q", t).textContent = "You";
  $("#pc").textContent = info.size;
}
function attachLocal() { const t = ensureTile(myId); $("video", t).srcObject = sharing && screenStream ? screenStream : local; watchAudio(myId, local); updateTile(myId); }

/* ---------------- speaking indicator + quality ---------------- */
function watchAudio(id, stream) {
  if (!audioCtx || !stream.getAudioTracks().length) return;
  try { const an = audioCtx.createAnalyser(); an.fftSize = 256; audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an); analysers.set(id, an); } catch {}
}
function speakLoop() {
  const buf = new Uint8Array(128);
  for (const [id, an] of analysers) {
    an.getByteFrequencyData(buf); const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
    $(`#tile-${id}`)?.classList.toggle("speaking", avg > 18 && !(id === myId && info.get(myId)?.muted));
  }
}
async function statsLoop() {
  let anyPoor = false;
  for (const [id, c] of conns) {
    try {
      const rep = await c.pc.getStats(); let rtt = null, rx = 0, lost = 0;
      rep.forEach((r) => {
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded" && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
        if (r.type === "inbound-rtp" && r.kind === "video") { rx += r.packetsReceived || 0; lost += r.packetsLost || 0; }
      });
      const dRx = rx - c.last.rx, dLost = lost - c.last.lost; c.last = { rx, lost };
      const loss = dRx + dLost > 0 ? dLost / (dRx + dLost) : 0;
      const q = rtt == null ? "…" : rtt < 0.15 && loss < 0.02 ? "Good" : rtt < 0.4 && loss < 0.06 ? "Fair" : "Poor";
      if (q === "Poor") anyPoor = true;
      const el = $(`#tile-${id} .q`); if (el) el.textContent = "📶 " + q + (rtt != null ? ` ${Math.round(rtt * 1000)}ms` : "");
    } catch {}
  }
  // low-bandwidth adaptation
  if (anyPoor) { poorCount++; goodCount = 0; } else { goodCount++; poorCount = 0; }
  if (!autoLow && poorCount >= 2) { autoLow = true; toast("Weak network detected - lowering video quality"); adapt(); }
  if (autoLow && goodCount >= 6) { autoLow = false; adapt(); }
}
async function adapt() {
  const n = info.size, kbps = lowData || autoLow ? 200 : n > 4 ? 400 : n > 2 ? 800 : 0;
  for (const c of conns.values()) for (const s of c.pc.getSenders()) {
    if (s.track?.kind !== "video") continue;
    try {
      const p = s.getParameters(); if (!p.encodings?.length) p.encodings = [{}];
      if (kbps) { p.encodings[0].maxBitrate = kbps * 1000; p.encodings[0].scaleResolutionDownBy = kbps < 300 ? 2 : 1; }
      else { delete p.encodings[0].maxBitrate; p.encodings[0].scaleResolutionDownBy = 1; }
      await s.setParameters(p);
    } catch {}
  }
}

/* ---------------- controls ---------------- */
function setMic(on) {
  if (!local.getAudioTracks().length) return toast("No microphone available (permission denied?)", "error");
  local.getAudioTracks().forEach((t) => (t.enabled = on)); socket.emit("state", { muted: !on });
  $("#bMic").textContent = on ? "🎤 Mute" : "🎤 Unmute"; $("#bMic").classList.toggle("off", !on);
}
function setCam(on) {
  if (!local.getVideoTracks().length) return toast("No camera available (permission denied?)", "error");
  local.getVideoTracks().forEach((t) => (t.enabled = on)); socket.emit("state", { cam: on });
  $("#bCam").textContent = on ? "📷 Camera off" : "📷 Camera on"; $("#bCam").classList.toggle("off", !on);
}
$("#bMic").onclick = () => setMic(!local.getAudioTracks().some((t) => t.enabled));
$("#bCam").onclick = () => setCam(!local.getVideoTracks().some((t) => t.enabled));
async function sendVideo(track) {
  for (const c of conns.values()) {
    const tr = c.pc.getTransceivers().find((t) => t.receiver.track?.kind === "video"); if (!tr) continue;
    if (track && tr.direction === "recvonly") tr.direction = "sendrecv";
    try { await tr.sender.replaceTrack(track); } catch (e) { console.warn(e); }
  }
  adapt();
}
$("#bSwitch").onclick = async () => { // front/back camera switch (works on phones and PCs with several cameras)
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const cur = camTrack?.getSettings().deviceId; const next = cams[(cams.findIndex((d) => d.deviceId === cur) + 1) % cams.length];
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } }); const nt = s.getVideoTracks()[0];
    nt.enabled = camTrack ? camTrack.enabled : true;
    if (camTrack) { local.removeTrack(camTrack); camTrack.stop(); } local.addTrack(nt); camTrack = nt;
    if (!sharing) { await sendVideo(nt); $("#tile-" + myId + " video").srcObject = local; }
  } catch (e) { toast("Could not switch camera: " + e.message, "error"); }
};
$("#bScreen").onclick = async () => {
  if (sharing) return stopScreen();
  const r = await ack("screen", { on: true }); if (r.error) return toast(r.error, "error");
  try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true }); }
  catch { socket.emit("screen", { on: false }); return toast("Screen sharing was cancelled or denied"); }
  const t = screenStream.getVideoTracks()[0]; t.onended = stopScreen; sharing = true;
  await sendVideo(t); attachLocal(); $("#bScreen").textContent = "🖥 Stop sharing"; $("#bScreen").classList.add("off");
};
async function stopScreen() {
  if (!sharing) return; sharing = false; screenStream?.getTracks().forEach((t) => t.stop()); screenStream = null;
  await sendVideo(camTrack); attachLocal(); socket.emit("screen", { on: false });
  $("#bScreen").textContent = "🖥 Share screen"; $("#bScreen").classList.remove("off");
}
$("#bHand").onclick = () => { handUp = !handUp; socket.emit("hand", { up: handUp }); $("#bHand").textContent = handUp ? "✋ Lower hand" : "✋ Raise hand"; $("#bHand").classList.toggle("off", handUp); };
$("#bLow").onclick = () => { lowData = !lowData; $("#bLow").classList.toggle("off", lowData); $("#bLow").textContent = lowData ? "📉 Low data ON" : "📉 Low data"; adapt(); };
$("#bLeave").onclick = () => leave("You left the meeting.");
$("#copyLink").onclick = async () => { const link = location.origin + "/call.html?room=" + roomId; try { await navigator.clipboard.writeText(link); toast("Invite link copied", "success"); } catch { prompt("Copy this link:", link); } };
function leave(msg) {
  try { socket?.emit("leave"); socket?.close(); } catch {}
  [...conns.keys()].forEach(closeConn); local.getTracks().forEach((t) => t.stop()); screenStream?.getTracks().forEach((t) => t.stop());
  if (rec && rec.state !== "inactive") rec.stop();
  sessionStorage.setItem("callMsg", msg); setTimeout(() => (location.href = "/call.html"), 400);
}
// No "leave" on refresh/close: the server keeps your seat (and host role) for 20s so you can re-join after a refresh or network drop.

/* ---------------- roles, people list, host controls ---------------- */
const isHost = () => room.hostId === myId, canMod = () => isHost() || room.cohosts.includes(myId);
function renderRole() {
  $("#roleBadge").textContent = isHost() ? "Host" : room.cohosts.includes(myId) ? "Co-host" : "Participant";
  $("#lockBadge").hidden = !room.locked; $("#bRec").hidden = !canMod();
  [...info.keys()].forEach(updateTile);
}
function renderPeople() {
  const pane = $("#panePeople"); $("#pc").textContent = info.size;
  let h = [...info.values()].map((p) => {
    const host = p.id === room.hostId, co = room.cohosts.includes(p.id), self = p.id === myId, prot = host || (co && !isHost());
    return `<div class="person"><b>${esc(p.name)}</b>${self ? " (you)" : ""} ${host ? '<span class="badge warn">Host</span>' : ""}${co ? '<span class="badge">Co-host</span>' : ""}
      <span>${p.muted ? "🔇" : "🎤"} ${p.cam === false ? "🚫📷" : "📷"} ${p.hand ? "✋" : ""} ${p.online === false ? "⚠" : ""}</span>
      ${canMod() && !self && !prot ? `<span class="row"><button class="sm" data-m="mute" data-t="${p.id}">Mute</button><button class="sm danger" data-m="kick" data-t="${p.id}">Remove</button>
        ${isHost() ? `<button class="sm" data-m="cohost" data-t="${p.id}" data-v="${co ? 0 : 1}">${co ? "Remove co-host" : "Make co-host"}</button>` : ""}</span>` : ""}
</div>`;
  }).join("");
  if (canMod()) h += `<h4>Host controls</h4><label class="small"><input type="checkbox" id="cLock" ${room.locked ? "checked" : ""}> Lock meeting (no new joins)</label><br>
    <label class="small"><input type="checkbox" id="cScr" ${room.permissions.screen ? "checked" : ""}> Allow participants to share screen</label><br>
    <label class="small"><input type="checkbox" id="cChat" ${room.permissions.chat ? "checked" : ""}> Allow participants to chat</label>
    ${isHost() ? '<br><button class="danger sm" id="cEnd" style="margin-top:8px">End meeting for everyone</button>' : ""}`;
  pane.innerHTML = h;
}
async function mod(action, target, value) { const r = await ack("mod", { action, target, value }); if (r?.error) toast(r.error, "error"); }
$("#panePeople").addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]"); if (b) return mod(b.dataset.m, b.dataset.t, b.dataset.v === undefined ? undefined : b.dataset.v === "1");
  if (e.target.id === "cEnd" && confirm("End the meeting for everyone?")) mod("end");
});
$("#panePeople").addEventListener("change", (e) => {
  if (e.target.id === "cLock") mod("lock", null, e.target.checked);
  if (e.target.id === "cScr") mod("perm", null, { key: "screen", on: e.target.checked });
  if (e.target.id === "cChat") mod("perm", null, { key: "chat", on: e.target.checked });
});
$$(".side .tabs button").forEach((b) => (b.onclick = () => {
  $$(".side .tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("#panePeople").hidden = b.dataset.p !== "people"; $("#paneChat").hidden = b.dataset.p !== "chat";
  if (b.dataset.p === "chat") $("#chatIn").focus();
}));

/* ---------------- chat: text, emojis, files ---------------- */
$("#emoji").innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join("");
$("#emoji").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("#chatIn").value += e.target.textContent; $("#chatIn").focus(); } };
async function sendChat(payload) { const r = await ack("chat", payload); if (r?.error) toast(r.error, "error"); }
$("#chatSend").onclick = () => { const v = $("#chatIn").value.trim(); if (!v) return; $("#chatIn").value = ""; sendChat({ text: v }); };
$("#chatIn").onkeydown = (e) => { if (e.key === "Enter") $("#chatSend").click(); };
$("#fileIn").onchange = (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (f.size > 1_000_000) return toast("File too large (max 1 MB)", "error");
  const rd = new FileReader(); rd.onload = () => sendChat({ text: "", file: { name: f.name, type: f.type, data: rd.result } }); rd.readAsDataURL(f);
};
function addChat(m) {
  const mine = m.from === myId; let body = esc(m.text);
  if (m.file && /^data:[\w\/+.-]+;base64,/.test(m.file.data)) {
    body += /^image\/(png|jpe?g|gif|webp)$/.test(m.file.type) ? `<br><img src="${m.file.data}" style="max-width:100%;border-radius:6px">` : "";
    body += `<br><a href="${m.file.data}" download="${esc(m.file.name)}">📎 ${esc(m.file.name)}</a>`;
  }
  $("#msgs").insertAdjacentHTML("beforeend", `<div class="msg"><b>${esc(m.name)}${mine ? " (you)" : ""}</b> <span class="muted small">${new Date(m.at).toLocaleTimeString()}</span><br>${body}</div>`);
  $("#msgs").scrollTop = 1e9;
  if ($("#paneChat").hidden && !mine) toast("💬 " + m.name + ": " + (m.text || "sent a file"));
}

/* ---------------- recording (host / co-host; saved on this computer) ---------------- */
function recAdd(stream) { if (rec && recDest && stream.getAudioTracks().length) try { audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(recDest); } catch {} }
$("#bRec").onclick = () => {
  if (rec && rec.state !== "inactive") return rec.stop();
  const cv = document.createElement("canvas"); cv.width = 1280; cv.height = 720; const g = cv.getContext("2d");
  recDest = audioCtx.createMediaStreamDestination(); recAdd(local); conns.forEach((c) => recAdd(c.stream));
  recTimer = setInterval(() => {
    const vs = $$("#grid .tile video").filter((v) => v.readyState >= 2); g.fillStyle = "#000"; g.fillRect(0, 0, 1280, 720);
    const cols = Math.ceil(Math.sqrt(vs.length || 1)), rows = Math.ceil((vs.length || 1) / cols), w = 1280 / cols, h = 720 / rows;
    vs.forEach((v, i) => g.drawImage(v, (i % cols) * w, Math.floor(i / cols) * h, w, h));
  }, 66);
  const mime = ["video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  const out = new MediaStream([...cv.captureStream(15).getVideoTracks(), ...recDest.stream.getAudioTracks()]); const chunks = [];
  rec = new MediaRecorder(out, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    clearInterval(recTimer); $("#recBadge").hidden = true; $("#bRec").textContent = "⏺ Record"; $("#bRec").classList.remove("off");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" })); a.download = `meeting-${roomId}-${Date.now()}.webm`; a.click();
    sendChat({ text: "⏹ Recording stopped." }); toast("Recording saved to your computer", "success");
  };
  rec.start(1000); $("#recBadge").hidden = false; $("#bRec").textContent = "⏹ Stop recording"; $("#bRec").classList.add("off");
  sendChat({ text: "🔴 The host started recording this meeting." });
};
