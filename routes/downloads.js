import { Router } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { Download, Video } from "../models.js";
import { auth, clientInfo, effectivePlan, istDayKey, nextIstMidnight, PLANS } from "../utils.js";

const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEDUP_MIN = +process.env.DOWNLOAD_DEDUP_MINUTES || 60;

async function quota(user) {
  const plan = effectivePlan(user);
  const limit = PLANS[plan].dailyDownloads;
  const fresh = new Date(Date.now() - 10 * 60000); // "started" only holds quota for 10 minutes
  const used = await Download.countDocuments({ user: user._id, dayKey: istDayKey(), countsToQuota: true,
    $or: [{ status: "completed" }, { status: "started", createdAt: { $gt: fresh } }] });
  return { plan, limit, used, remaining: Math.max(0, limit - used), resetsAt: nextIstMidnight() };
}

r.get("/", auth, async (req, res) => {
  const list = await Download.find({ user: req.userId }).sort({ createdAt: -1 }).limit(100).select("-token");
  res.json({ downloads: list, quota: await quota(req.user) });
});
r.get("/quota", auth, async (req, res) => res.json(await quota(req.user)));

// step 1: authorise + reserve quota -> returns one-time URL
r.post("/request", auth, async (req, res) => {
  try {
    const { videoId, deviceId } = req.body;
    const user = req.user; const q = await quota(user);
    const video = await Video.findById(videoId).catch(() => null);
    if (!video) return res.status(404).json({ message: "Video not found" });
    if (PLANS[q.plan].rank < PLANS[video.minPlan].rank)
      return res.status(403).json({ message: `Your ${PLANS[q.plan].name} plan cannot access this video.` });

    if (process.env.ENFORCE_DEVICE_LIMIT === "true" &&
        !user.trustedDevices.some((d) => d.deviceId === deviceId && d.expiresAt > new Date()))
      return res.status(403).json({ message: "Downloads are only allowed on your registered/trusted devices." });

    // one active download at a time (blocks simultaneous downloads across devices)
    const active = await Download.findOne({ user: user._id, status: "started", createdAt: { $gt: new Date(Date.now() - 10 * 60000) } });
    if (active) return res.status(409).json({ message: "Another download is already in progress. Wait for it to finish." });

    // same video again within the window does not use extra quota
    const dup = await Download.findOne({ user: user._id, video: video._id, countsToQuota: true, createdAt: { $gt: new Date(Date.now() - DEDUP_MIN * 60000) },
      $or: [{ status: "completed" }, { status: "started", createdAt: { $gt: new Date(Date.now() - 10 * 60000) } }] });
    if (!dup && q.remaining <= 0)
      return res.status(429).json({ quotaExceeded: true, message: `Daily limit reached (${q.limit}/day on the ${PLANS[q.plan].name} plan). Resets at midnight IST. Upgrade for more.` });

    const info = clientInfo(req);
    const token = crypto.randomBytes(24).toString("hex");
    const d = await Download.create({
      user: user._id, video: video._id, videoTitle: video.title, thumbnail: video.thumbnail, plan: q.plan, dayKey: istDayKey(),
      countsToQuota: !dup, token, tokenExpires: new Date(Date.now() + 2 * 60000),
      ip: info.ip, deviceId, device: `${info.deviceType} ${info.deviceModel}`.trim(), browser: info.browser, os: info.os,
    });
    res.json({ downloadId: d._id, url: `/api/downloads/file/${token}`, countedAgainstQuota: !dup });
  } catch (e) { console.error(e); res.status(500).json({ message: "Could not start the download" }); }
});

// step 2: the browser opens this URL. Token is single-use and expires in 2 minutes.
r.get("/file/:token", async (req, res) => {
  const d = await Download.findOne({ token: req.params.token });
  if (!d || d.tokenUsed || d.tokenExpires < new Date()) return res.status(410).send("This download link has expired or was already used. Start the download again from the site.");
  d.tokenUsed = true; await d.save();
  const video = await Video.findById(d.video);
  const fail = async (status) => { await Download.updateOne({ _id: d._id }, { status, countsToQuota: false }); };
  try {
    const fname = video.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") + ".mp4";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    let stream, ctrl;
    if (/^https?:/i.test(video.url)) {
      ctrl = new AbortController();
      const up = await fetch(video.url, { signal: ctrl.signal });
      if (!up.ok || !up.body) throw new Error("source unavailable " + up.status);
      if (up.headers.get("content-length")) res.setHeader("Content-Length", up.headers.get("content-length"));
      stream = Readable.fromWeb(up.body);
    } else {
      const file = path.join(__dirname, "..", "public", video.url);
      res.setHeader("Content-Length", fs.statSync(file).size);
      stream = fs.createReadStream(file);
    }
    let bytes = 0;
    stream.on("data", (c) => (bytes += c.length));
    stream.on("error", async () => { await fail("failed"); res.destroy(); });
    res.on("finish", () => Download.updateOne({ _id: d._id }, { status: "completed", size: bytes, completedAt: new Date() }).exec());
    res.on("close", async () => {          // user cancelled / network dropped
      if (!res.writableFinished) { ctrl?.abort(); stream.destroy(); await Download.updateOne({ _id: d._id }, { status: "interrupted", size: bytes, countsToQuota: false }); }
    });
    stream.pipe(res);
  } catch (e) {
    console.error("download error:", e.message); await fail("failed");
    res.removeHeader("Content-Disposition"); res.setHeader("Content-Type", "text/plain");
    if (!res.headersSent) res.status(502).send("The video source is unavailable right now. Your quota was not used."); else res.destroy();
  }
});

export default r;
