/* Custom HTML5 video player (no browser default controls) */
function initPlayer(root, data) {
  const v = data.video;
  const subs = (v.subtitles || []).map((s) => `<track kind="subtitles" label="${esc(s.label)}" srclang="${esc(s.lang)}" src="${esc(s.src)}">`).join("");
  root.innerHTML = `
  <div class="player" id="player" tabindex="0">
    <video id="vid" playsinline preload="metadata" src="${esc(v.url)}" poster="${esc(v.thumbnail)}">${subs}</video>
    <div class="spinner" id="spin"></div>
    <div class="big-play" id="bigPlay">▶</div>
    <div class="next-ov" id="nextOv"><div>Up next: <b>${esc(data.next?.title || "")}</b></div><div style="font-size:30px">Playing in <span id="cd">5</span>s</div>
      <div class="row"><button class="primary" id="playNow">Play now</button><button id="cancelNext">Cancel</button><button id="replay">Replay</button></div></div>
    <div class="limit-ov" id="limitOv"><h3>Daily watch limit reached</h3><p>The Free plan allows ${data.watchLimit.limit / 60} minutes of watch time per day. Upgrade for unlimited watching.</p>
      <a class="btn primary" href="/subscription.html">View plans</a></div>
    <div class="help-ov" id="helpOv"><h3>Keyboard shortcuts</h3><table>
      <tr><td><kbd>Space</kbd>/<kbd>K</kbd></td><td>Play / pause</td><td><kbd>M</kbd></td><td>Mute</td></tr>
      <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Seek 5s</td><td><kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>Seek 30s</td></tr>
      <tr><td><kbd>J</kbd> <kbd>L</kbd></td><td>Seek 10s</td><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Volume</td></tr>
      <tr><td><kbd>&lt;</kbd> <kbd>&gt;</kbd></td><td>Speed down/up</td><td><kbd>S</kbd></td><td>Cycle speed</td></tr>
      <tr><td><kbd>P</kbd></td><td>Picture-in-Picture</td><td><kbd>T</kbd></td><td>Theater mode</td></tr>
      <tr><td><kbd>C</kbd></td><td>Subtitles</td><td><kbd>F</kbd></td><td>Full screen</td></tr>
      <tr><td><kbd>N</kbd></td><td>Next video</td><td><kbd>0</kbd>-<kbd>9</kbd></td><td>Jump to 0-90%</td></tr></table>
      <button id="closeHelp">Close (Esc)</button></div>
    <div class="controls" id="controls">
      <div class="timeline" id="tl"><div class="bar"></div><div class="buf" id="buf"></div><div class="prog" id="prog"></div><div class="knob" id="knob"></div>
        <div class="pv" id="pv"><video muted preload="auto" src="${esc(v.url)}"></video><span id="pvT">0:00</span></div></div>
      <div class="cbar">
        <button class="pb" id="bPlay" title="Play/Pause (k)">▶</button>
        <button class="pb" id="bBack" title="Back 10s (j)">⏪</button>
        <button class="pb" id="bFwd" title="Forward 10s (l)">⏩</button>
        <button class="pb" id="bNext" title="Next video (n)">⏭</button>
        <button class="pb" id="bMute" title="Mute (m)">🔊</button>
        <input type="range" id="vol" min="0" max="1" step="0.02" title="Volume">
        <span class="time" id="tm">0:00 / 0:00</span>
        <span class="sp"></span>
        <span class="qinfo" id="qi"></span>
        <select id="speed" title="Playback speed (s)"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
        <button class="pb" id="bCC" title="Subtitles (c)">CC</button>
        <button class="pb" id="bPip" title="Picture-in-Picture (p)">⧉</button>
        <button class="pb" id="bTheater" title="Theater mode (t)">▭</button>
        <button class="pb" id="bFs" title="Full screen (f)">⛶</button>
        <button class="pb" id="bHelp" title="Shortcuts (?)">?</button>
      </div>
    </div>
  </div>`;
  const $p = (s) => root.querySelector(s);
  const player = $p("#player"), vid = $p("#vid"), pvVid = $p("#pv video");
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const RATES = [0.5, 1, 1.25, 1.5, 2];
  let idleT = null, cdT = null, acc = 0, limitHit = data.watchLimit.limit > 0 && data.watchLimit.used >= data.watchLimit.limit;

  // ---- remembered preferences ----
  const prefs = JSON.parse(localStorage.getItem("playerPrefs") || "{}");
  vid.volume = prefs.volume ?? 1; vid.muted = !!prefs.muted; vid.playbackRate = prefs.rate || 1; $p("#speed").value = String(vid.playbackRate);
  const savePrefs = () => localStorage.setItem("playerPrefs", JSON.stringify({ volume: vid.volume, muted: vid.muted, rate: vid.playbackRate }));
  [...vid.textTracks].forEach((t) => (t.mode = "hidden"));
  if (!vid.textTracks.length) { $p("#bCC").disabled = true; $p("#bCC").title = "No subtitles for this video"; }
  if (!document.pictureInPictureEnabled) $p("#bPip").style.display = "none";

  // ---- helpers ----
  const toggle = () => { if (limitHit) return showLimit(); vid.paused ? vid.play().catch(() => {}) : vid.pause(); };
  const seekBy = (d) => { vid.currentTime = clamp(vid.currentTime + d, 0, vid.duration || 0); wake(); };
  const setVol = (x) => { vid.volume = clamp(x, 0, 1); if (vid.volume > 0) vid.muted = false; savePrefs(); ui(); };
  const toggleMute = () => { vid.muted = !vid.muted; savePrefs(); ui(); };
  const setRate = (r) => { vid.playbackRate = r; $p("#speed").value = String(r); savePrefs(); };
  const changeRate = (d) => { const i = clamp(RATES.indexOf(vid.playbackRate) + d, 0, RATES.length - 1); setRate(RATES[i]); toast("Speed " + RATES[i] + "×"); };
  const cycleRate = () => { setRate(RATES[(RATES.indexOf(vid.playbackRate) + 1) % RATES.length]); toast("Speed " + vid.playbackRate + "×"); };
  const toggleCC = () => { if (!vid.textTracks.length) return toast("No subtitles available"); const on = vid.textTracks[0].mode !== "showing"; [...vid.textTracks].forEach((t) => (t.mode = on ? "showing" : "hidden")); $p("#bCC").classList.toggle("on", on); };
  const togglePip = async () => { try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await vid.requestPictureInPicture(); } catch { toast("Picture-in-Picture is not available", "error"); } };
  const toggleTheater = () => { const on = player.classList.toggle("theater"); document.body.classList.toggle("theater", on); $p("#bTheater").classList.toggle("on", on); };
  const toggleFs = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (player.requestFullscreen) player.requestFullscreen().catch(() => {}); else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
  };
  const goNext = () => { if (data.next) { flush(); location.href = "/watch.html?id=" + data.next._id; } else toast("No next video"); };
  function showLimit() { $p("#limitOv").classList.add("on"); vid.pause(); limitHit = true; }

  // ---- UI refresh ----
  function ui() {
    const d = vid.duration || v.duration || 0, t = vid.currentTime || 0;
    $p("#bPlay").textContent = vid.paused ? "▶" : "⏸";
    $p("#bigPlay").classList.toggle("hide", !vid.paused || vid.ended);
    $p("#bMute").textContent = vid.muted || vid.volume === 0 ? "🔇" : vid.volume < 0.5 ? "🔉" : "🔊";
    $p("#vol").value = vid.muted ? 0 : vid.volume;
    $p("#tm").textContent = `${fmtTime(t)} / ${fmtTime(d)} • -${fmtTime(d - t)}`;
    const pct = d ? (t / d) * 100 : 0; $p("#prog").style.width = pct + "%"; $p("#knob").style.left = pct + "%";
    $p("#bFs").classList.toggle("on", !!document.fullscreenElement);
  }
  function buffered() {
    const d = vid.duration; if (!d) return;
    let end = 0; for (let i = 0; i < vid.buffered.length; i++) if (vid.buffered.start(i) <= vid.currentTime + 0.5) end = Math.max(end, vid.buffered.end(i));
    $p("#buf").style.width = (end / d) * 100 + "%";
  }
  function wake() { player.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => { if (!vid.paused) player.classList.add("idle"); }, 3000); }

  // ---- video events ----
  vid.addEventListener("loadedmetadata", () => {
    const r = data.progress?.seconds || 0;
    if (r > 5 && r < vid.duration - 5) { vid.currentTime = r; toast("Resumed from " + fmtTime(r)); }
    $p("#qi").textContent = `${vid.videoHeight}p • ${data.plan} plan max ${data.quality}`; ui();
  });
  vid.addEventListener("timeupdate", () => { ui(); buffered(); });
  vid.addEventListener("progress", buffered);
  ["waiting", "stalled", "seeking"].forEach((e) => vid.addEventListener(e, () => $p("#spin").classList.add("on")));
  ["canplay", "playing", "seeked"].forEach((e) => vid.addEventListener(e, () => $p("#spin").classList.remove("on")));
  vid.addEventListener("error", () => { $p("#spin").classList.remove("on"); toast("The video failed to load. Check your connection and refresh.", "error"); });
  vid.addEventListener("pause", () => { ui(); wake(); flush(); });
  vid.addEventListener("volumechange", ui);
  vid.addEventListener("ratechange", () => ($p("#speed").value = String(vid.playbackRate)));
  vid.addEventListener("play", () => {
    if (limitHit) return showLimit();
    ui(); wake(); bc?.postMessage({ id: tabId });
    document.querySelectorAll("video").forEach((x) => { if (x !== vid && !x.closest(".pv") && !x.paused) x.pause(); }); // only one video plays
  });
  vid.addEventListener("ended", () => {
    ui(); flush(true); player.classList.remove("idle");
    if (!data.next) return;
    $p("#nextOv").classList.add("on"); let n = 5; $p("#cd").textContent = n;
    cdT = setInterval(() => { n--; $p("#cd").textContent = n; if (n <= 0) { clearInterval(cdT); goNext(); } }, 1000);
  });
  // another tab started playing -> pause this one
  const tabId = Math.random().toString(36).slice(2);
  const bc = window.BroadcastChannel ? new BroadcastChannel("yt2-player") : null;
  if (bc) bc.onmessage = (e) => { if (e.data?.id !== tabId && !vid.paused) vid.pause(); };

  // ---- controls ----
  $p("#bPlay").onclick = toggle; $p("#bBack").onclick = () => seekBy(-10); $p("#bFwd").onclick = () => seekBy(10);
  $p("#bNext").onclick = goNext; $p("#bMute").onclick = toggleMute; $p("#vol").oninput = (e) => setVol(+e.target.value);
  $p("#speed").onchange = (e) => setRate(+e.target.value);
  $p("#bCC").onclick = toggleCC; $p("#bPip").onclick = togglePip; $p("#bTheater").onclick = toggleTheater; $p("#bFs").onclick = toggleFs;
  $p("#bHelp").onclick = () => $p("#helpOv").classList.toggle("on"); $p("#closeHelp").onclick = () => $p("#helpOv").classList.remove("on");
  $p("#bigPlay").onclick = toggle;
  $p("#playNow").onclick = goNext; $p("#replay").onclick = () => { clearInterval(cdT); $p("#nextOv").classList.remove("on"); vid.currentTime = 0; vid.play(); };
  $p("#cancelNext").onclick = () => { clearInterval(cdT); $p("#nextOv").classList.remove("on"); };
  vid.addEventListener("click", toggle);
  vid.addEventListener("dblclick", toggleFs);
  root.addEventListener("click", (e) => e.target.closest("button")?.blur()); // so Space/keys keep controlling the video
  player.addEventListener("mousemove", wake); player.addEventListener("touchstart", wake, { passive: true });
  document.addEventListener("fullscreenchange", ui);

  // ---- timeline: click, drag, hover preview ----
  const tl = $p("#tl"), pv = $p("#pv"); let dragging = false, pvTarget = 0, pvBusy = false;
  const pctOf = (e) => { const r = tl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  function pvSeek(t) { pvTarget = t; if (pvBusy) return; pvBusy = true; pvVid.currentTime = t; }
  pvVid.addEventListener("seeked", () => { pvBusy = false; if (Math.abs(pvTarget - pvVid.currentTime) > 0.5) pvSeek(pvTarget); });
  tl.addEventListener("pointerdown", (e) => { dragging = true; tl.setPointerCapture(e.pointerId); if (vid.duration) vid.currentTime = pctOf(e) * vid.duration; });
  tl.addEventListener("pointermove", (e) => {
    const p = pctOf(e), d = vid.duration || 0; if (!d) return;
    const w = tl.clientWidth; pv.style.display = "block"; pv.style.left = clamp(p * w, 80, Math.max(80, w - 80)) + "px";
    $p("#pvT").textContent = fmtTime(p * d); pvSeek(p * d);
    if (dragging) vid.currentTime = p * d;
  });
  tl.addEventListener("pointerup", () => (dragging = false));
  tl.addEventListener("pointerleave", () => { if (!dragging) pv.style.display = "none"; });

  // ---- keyboard shortcuts ----
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input,textarea,select,[contenteditable='true']") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key; if (e.target.tagName === "BUTTON" && (k === " " || k === "Enter")) return;
    let ok = true;
    switch (k) {
      case " ": case "k": case "K": toggle(); break;
      case "ArrowLeft": seekBy(e.shiftKey ? -30 : -5); break;
      case "ArrowRight": seekBy(e.shiftKey ? 30 : 5); break;
      case "j": case "J": seekBy(-10); break;
      case "l": case "L": seekBy(10); break;
      case "ArrowUp": setVol(vid.volume + 0.05); break;
      case "ArrowDown": setVol(vid.volume - 0.05); break;
      case "m": case "M": toggleMute(); break;
      case "<": case ",": changeRate(-1); break;
      case ">": case ".": changeRate(1); break;
      case "s": case "S": cycleRate(); break;
      case "p": case "P": togglePip(); break;
      case "t": case "T": toggleTheater(); break;
      case "c": case "C": toggleCC(); break;
      case "f": case "F": toggleFs(); break;
      case "n": case "N": goNext(); break;
      case "Home": vid.currentTime = 0; break;
      case "End": vid.currentTime = Math.max(0, (vid.duration || 0) - 1); break;
      case "?": $p("#helpOv").classList.toggle("on"); break;
      case "Escape": $p("#helpOv").classList.remove("on"); break;
      default: if (/^[0-9]$/.test(k) && vid.duration) vid.currentTime = (vid.duration * +k) / 10; else ok = false;
    }
    if (ok) { e.preventDefault(); wake(); }
  });

  // ---- save watch progress every 10s, on pause, on leave ----
  setInterval(() => { if (!vid.paused && !vid.ended) acc += 1; }, 1000);
  setInterval(() => { if (!vid.paused) flush(); }, 10000);
  async function flush(done) {
    if (!token()) return;
    const body = { seconds: done ? 0 : vid.currentTime, duration: vid.duration || v.duration, delta: acc }; acc = 0;
    if (done) body.seconds = vid.duration; // finished
    try {
      const r = await fetch(API + `/videos/${v._id}/progress`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.limitReached) showLimit();
      if (j.completed) document.getElementById("doneBadge")?.removeAttribute("hidden");
    } catch {}
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", () => flush());
  if (limitHit) showLimit();
  ui(); wake();
}
