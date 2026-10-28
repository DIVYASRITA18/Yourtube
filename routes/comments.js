import { Router } from "express";
import { Comment, Report, User, Video } from "../models.js";
import { auth, optionalAuth } from "../utils.js";

const r = Router();
const EDIT_MS = (+process.env.EDIT_WINDOW_MIN || 15) * 60000;

/* ---------------- content moderation ---------------- */
// Extend this list as needed (or add words in the BADWORDS env var, comma separated)
const BAD = ["fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "slut", "whore", "motherfucker",
  "bullshit", "dumbass", "jackass", "moron", "idiot", "stupid", "scumbag", "piss", "damn", "crap",
  ...(process.env.BADWORDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
const collapse = (w) => w.replace(/(.)\1+/g, "$1");
const BAD_SET = new Set(BAD.flatMap((w) => [w, collapse(w)]));
const leet = (s) => s.replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a").replace(/\$/g, "s");

function hasProfanity(text) {
  return leet(text.toLowerCase()).split(/\s+/).some((tok) => {
    const t = tok.replace(/[^a-z]/g, "");
    return t && (BAD_SET.has(t) || BAD_SET.has(collapse(t)));
  });
}
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "cutt.ly", "rb.gy", "shorturl.at"];
function badLink(u) {
  let url; try { url = new URL(/^https?:/i.test(u) ? u : "http://" + u); } catch { return true; }
  const h = url.hostname.toLowerCase();
  return SHORTENERS.includes(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes("xn--")
    || /\.(exe|zip|apk|scr|bat|msi|jar)$/i.test(url.pathname) || /(free-?gift|free-?money|prize|claim-?now|login-?verify)/i.test(h);
}
function checkContent(text) {
  const t = (text || "").trim();
  if (!t) return { code: "empty", message: "Comment cannot be empty." };
  if (t.length > 500) return { code: "long", message: "Comment is too long (max 500 characters)." };
  const emojis = t.match(/\p{Extended_Pictographic}/gu) || [];
  if (emojis.length >= 5 && new Set(emojis).size <= 2) return { code: "emoji_spam", message: "Repeated emoji comments are not allowed." };
  if (emojis.length >= 10 && emojis.length / [...t].length > 0.7) return { code: "emoji_spam", message: "Too many emojis in one comment." };
  if (/([^\p{L}\p{N}\s])\1{4,}/u.test(t) || (!/[\p{L}\p{N}]/u.test(t) && emojis.length === 0 && t.length > 4))
    return { code: "special_spam", message: "Repeated special characters are not allowed." };
  if (/(.)\1{9,}/u.test(t) || /\b(\w+)(\s+\1\b){4,}/i.test(t)) return { code: "repeat_spam", message: "Repeated characters or words look like spam." };
  const links = t.match(/((https?:\/\/|www\.)[^\s]+)/gi) || [];
  if (links.length > 2) return { code: "link_spam", message: "Too many links in one comment." };
  if (links.some(badLink) || /javascript:|data:text\/html|vbscript:/i.test(t)) return { code: "bad_link", message: "A suspicious or malicious link was blocked." };
  if (/(free money|click here|buy now|earn \$|work from home|crypto giveaway|whatsapp me|dm me for|100% free)/i.test(t)) return { code: "spam", message: "This looks like spam." };
  if (hasProfanity(t)) return { code: "abusive", message: "Please remove abusive language and try again." };
  return null;
}

/* ---------------- rate limit + captcha ---------------- */
const state = new Map(); // userId -> {times:[], strikes, captcha}
const getState = (uid) => { if (!state.has(uid)) state.set(uid, { times: [], strikes: 0, captcha: false }); return state.get(uid); };
const strike = (s) => { s.strikes += 1; if (s.strikes >= 3) s.captcha = true; };
const captchas = new Map();
function newCaptcha() {
  const a = 2 + Math.floor(Math.random() * 8), b = 2 + Math.floor(Math.random() * 8);
  const id = Math.random().toString(36).slice(2);
  captchas.set(id, { ans: String(a + b), exp: Date.now() + 5 * 60000 });
  for (const [k, v] of captchas) if (v.exp < Date.now()) captchas.delete(k);
  return { id, question: `What is ${a} + ${b} ?` };
}
function okCaptcha(id, ans) {
  const c = captchas.get(id); captchas.delete(id);
  return !!c && c.exp > Date.now() && String(ans).trim() === c.ans;
}
r.get("/captcha", auth, (req, res) => res.json(newCaptcha()));

/* ---------------- helpers ---------------- */
function fmt(c, uid) {
  const removed = c.deleted || c.hidden;
  const mine = !!uid && String(c.user) === uid;
  const has = (arr) => !!uid && arr.some((x) => String(x) === uid);
  return {
    _id: c._id, parent: c.parent, userName: c.userName, username: c.username, avatar: c.avatar, location: c.location,
    text: removed ? (c.hidden ? "[Removed by a moderator]" : "[This comment was deleted]") : c.text,
    removed, edited: c.edited, editedAt: c.editedAt, createdAt: c.createdAt, version: c.version,
    likes: c.likes.length, dislikes: c.dislikes.length,
    myVote: has(c.likes) ? "like" : has(c.dislikes) ? "dislike" : null,
    mine, canEdit: mine && !removed && Date.now() - new Date(c.createdAt) < EDIT_MS,
    editMsLeft: mine ? Math.max(0, EDIT_MS - (Date.now() - new Date(c.createdAt))) : 0,
    mentions: c.mentions,
  };
}
async function findMentions(text) {
  const names = [...new Set([...text.matchAll(/@([a-zA-Z0-9_.-]{3,20})/g)].map((m) => m[1].toLowerCase()))];
  if (!names.length) return [];
  return (await User.find({ username: { $in: names } }).select("username")).map((u) => u.username);
}

/* ---------------- list ---------------- */
r.get("/video/:videoId", optionalAuth, async (req, res) => {
  const uid = req.userId ? String(req.userId) : null;
  const all = await Comment.find({ video: req.params.videoId }).sort({ createdAt: 1 }).limit(800);
  const top = all.filter((c) => !c.parent).map((c) => ({ ...fmt(c, uid), replies: [] }));
  const byId = new Map(top.map((c) => [String(c._id), c]));
  for (const c of all.filter((c) => c.parent)) byId.get(String(c.parent))?.replies.push(fmt(c, uid));
  let list = top.map((c) => {
    c.replies = c.replies.filter((x) => !x.removed || false); // hide removed replies
    return c;
  }).filter((c) => !c.removed || c.replies.length > 0); // keep deleted parent only if replies exist
  const score = (c) => c.likes - 0.5 * c.dislikes + 2 * c.replies.length + 8 / (1 + (Date.now() - new Date(c.createdAt)) / 86400000);
  const sort = req.query.sort || "newest";
  list.sort({
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    liked: (a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes) || new Date(b.createdAt) - new Date(a.createdAt),
    relevant: (a, b) => score(b) - score(a),
  }[sort] || ((a, b) => 0));
  const total = list.reduce((n, c) => n + (c.removed ? 0 : 1) + c.replies.length, 0);
  res.json({ comments: list, total, editMinutes: EDIT_MS / 60000 });
});

/* ---------------- create ---------------- */
r.post("/", auth, async (req, res) => {
  try {
    const { videoId, text, parentId, captchaId, captchaAnswer } = req.body;
    const uid = String(req.userId); const s = getState(uid); const now = Date.now();
    if (s.captcha) {
      if (!okCaptcha(captchaId, captchaAnswer)) return res.status(429).json({ captchaRequired: true, message: "Please solve the CAPTCHA to continue." });
      s.captcha = false; s.strikes = 0;
    }
    s.times = s.times.filter((t) => now - t < 60000);
    if (s.times.length >= 5) { strike(s); return res.status(429).json({ flood: true, captchaRequired: s.captcha, message: "You are commenting too fast. Please wait a minute." }); }

    const bad = checkContent(text);
    if (bad) { strike(s); return res.status(400).json({ ...bad, captchaRequired: s.captcha }); }
    const video = await Video.findById(videoId).catch(() => null);
    if (!video) return res.status(404).json({ message: "Video not found" });

    const norm = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (await Comment.findOne({ user: req.userId, norm, deleted: false, createdAt: { $gt: new Date(now - 10 * 60000) } })) {
      strike(s); return res.status(409).json({ code: "duplicate", message: "You already posted this comment recently.", captchaRequired: s.captcha });
    }
    let parent = null;
    if (parentId) {
      const p = await Comment.findById(parentId).catch(() => null);
      if (!p || String(p.video) !== String(videoId)) return res.status(404).json({ message: "The comment you are replying to no longer exists." });
      if (p.deleted || p.hidden) return res.status(400).json({ message: "You cannot reply to a deleted comment." });
      parent = p.parent || p._id; // replies are flattened to one level
    }
    const loc = req.user.lastLocation || {};
    const c = await Comment.create({
      video: videoId, user: req.userId, userName: req.user.name, username: req.user.username, avatar: req.user.avatar,
      location: [loc.city, loc.country].filter((x) => x && x !== "Local").join(", ") || "Unknown location",
      text: text.trim(), norm, parent, mentions: await findMentions(text),
      history: [{ text: text.trim(), at: new Date(), action: "create" }],
    });
    s.times.push(now);
    res.json(fmt(c, uid));
  } catch (e) { console.error(e); res.status(500).json({ message: "Could not post comment" }); }
});

/* ---------------- edit (with simultaneous-edit protection) ---------------- */
r.put("/:id", auth, async (req, res) => {
  try {
    const { text, version } = req.body; const uid = String(req.userId);
    const c = await Comment.findById(req.params.id).catch(() => null);
    if (!c || c.deleted || c.hidden) return res.status(404).json({ message: "Comment not found" });
    if (String(c.user) !== uid) return res.status(403).json({ message: "You can only edit your own comments" });
    if (Date.now() - new Date(c.createdAt) > EDIT_MS) return res.status(403).json({ message: `Editing is allowed only within ${EDIT_MS / 60000} minutes.` });
    const bad = checkContent(text); if (bad) return res.status(400).json(bad);
    const upd = await Comment.findOneAndUpdate(
      { _id: c._id, version: +version, deleted: false },
      { $set: { text: text.trim(), norm: text.trim().toLowerCase().replace(/\s+/g, " "), edited: true, editedAt: new Date(), mentions: await findMentions(text) },
        $inc: { version: 1 }, $push: { history: { text: c.text, at: new Date(), action: "edit" } } },
      { new: true });
    if (!upd) return res.status(409).json({ conflict: true, message: "This comment was changed in another tab/device. Reload and try again.", current: fmt(await Comment.findById(c._id), uid) });
    res.json(fmt(upd, uid));
  } catch (e) { console.error(e); res.status(500).json({ message: "Could not edit comment" }); }
});

/* ---------------- delete (soft: history is kept) ---------------- */
r.delete("/:id", auth, async (req, res) => {
  const c = await Comment.findById(req.params.id).catch(() => null);
  if (!c || c.deleted) return res.status(404).json({ message: "Comment not found" });
  if (String(c.user) !== String(req.userId)) return res.status(403).json({ message: "You can only delete your own comments" });
  if (Date.now() - new Date(c.createdAt) > EDIT_MS) return res.status(403).json({ message: `Deleting is allowed only within ${EDIT_MS / 60000} minutes.` });
  c.deleted = true; c.history.push({ text: c.text, at: new Date(), action: "delete" }); await c.save();
  res.json({ ok: true });
});

/* ---------------- like / dislike ---------------- */
r.post("/:id/vote", auth, async (req, res) => {
  const { type } = req.body; if (!["like", "dislike"].includes(type)) return res.status(400).json({ message: "Invalid vote" });
  const c = await Comment.findById(req.params.id).catch(() => null);
  if (!c || c.deleted || c.hidden) return res.status(404).json({ message: "Comment not found" });
  const add = type === "like" ? "likes" : "dislikes", rem = type === "like" ? "dislikes" : "likes";
  const has = c[add].some((x) => String(x) === String(req.userId));
  if (has) await Comment.updateOne({ _id: c._id }, { $pull: { [add]: req.userId } });
  else await Comment.updateOne({ _id: c._id }, { $addToSet: { [add]: req.userId }, $pull: { [rem]: req.userId } });
  res.json(fmt(await Comment.findById(c._id), String(req.userId)));
  // NOTE: dislikes only change the score. Comments are never auto-deleted by dislikes.
});

/* ---------------- report -> admin review ---------------- */
r.post("/:id/report", auth, async (req, res) => {
  const { reason, details } = req.body;
  if (!["spam", "harassment", "offensive", "hate", "misinformation", "other"].includes(reason)) return res.status(400).json({ message: "Choose a valid reason" });
  const c = await Comment.findById(req.params.id).catch(() => null);
  if (!c || c.deleted) return res.status(404).json({ message: "Comment not found" });
  if (String(c.user) === String(req.userId)) return res.status(400).json({ message: "You cannot report your own comment" });
  try { await Report.create({ comment: c._id, reporter: req.userId, reason, details: (details || "").slice(0, 300) }); }
  catch (e) { if (e.code === 11000) return res.status(409).json({ message: "You already reported this comment." }); throw e; }
  await Comment.updateOne({ _id: c._id }, { $set: { flagged: true }, $inc: { reportCount: 1 } });
  res.json({ message: "Thanks! A moderator will review this comment." });
});

/* ---------------- translate (MyMemory free API, with cache + graceful failure) ---------------- */
const tcache = new Map();
r.post("/translate", auth, async (req, res) => {
  const { text, target } = req.body;
  if (!text || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(target || "")) return res.status(400).json({ message: "Invalid translation request" });
  const key = target + "|" + text;
  if (tcache.has(key)) return res.json({ translated: tcache.get(key), cached: true });
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=Autodetect|${target}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await resp.json();
    const out = j?.responseData?.translatedText;
    if (!out || +j.responseStatus !== 200 || /MYMEMORY WARNING|INVALID/i.test(out)) throw new Error("bad response");
    tcache.set(key, out); if (tcache.size > 2000) tcache.delete(tcache.keys().next().value);
    res.json({ translated: out });
  } catch { res.status(502).json({ message: "Translation is unavailable right now. Showing the original text." }); }
});

export default r;
