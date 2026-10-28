import { Router } from "express";
import { Video, Progress } from "../models.js";
import { auth, optionalAuth, effectivePlan, istDayKey, PLANS } from "../utils.js";

const r = Router();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

r.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const f = q ? { title: new RegExp(esc(q), "i") } : {};
  res.json(await Video.find(f).sort({ order: 1 }).select("-url -subtitles"));
});

r.get("/:id", optionalAuth, async (req, res) => {
  const v = await Video.findById(req.params.id).catch(() => null);
  if (!v) return res.status(404).json({ message: "Video not found" });
  const plan = req.user ? effectivePlan(req.user) : "free";
  if (PLANS[plan].rank < PLANS[v.minPlan].rank)
    return res.status(403).json({ message: `This video needs the ${PLANS[v.minPlan].name} plan or higher.`, minPlan: v.minPlan, video: { _id: v._id, title: v.title, thumbnail: v.thumbnail } });

  const next = (await Video.findOne({ order: { $gt: v.order } }).sort({ order: 1 }).select("title thumbnail"))
    || (await Video.findOne({ _id: { $ne: v._id } }).sort({ order: 1 }).select("title thumbnail"));
  Video.updateOne({ _id: v._id }, { $inc: { views: 1 } }).exec();
  const progress = req.user ? await Progress.findOne({ user: req.userId, video: v._id }) : null;
  const lim = PLANS[plan].dailyWatchMinutes * 60;
  const used = req.user?.watchToday?.day === istDayKey() ? req.user.watchToday.seconds : 0;
  res.json({ video: v, plan, quality: PLANS[plan].quality, next, progress, watchLimit: { limit: lim, used } });
});

// save progress + count today's watch time (free plan has a daily limit)
r.post("/:id/progress", auth, async (req, res) => {
  const { seconds = 0, duration = 0, delta = 0 } = req.body;
  const pct = +process.env.COMPLETE_PERCENT || 90;
  const completed = duration > 0 && (seconds / duration) * 100 >= pct;
  await Progress.findOneAndUpdate(
    { user: req.userId, video: req.params.id },
    { $set: { seconds, duration, ...(completed ? { completed: true } : {}) } },
    { upsert: true }
  );
  const plan = effectivePlan(req.user);
  const day = istDayKey();
  if (req.user.watchToday?.day !== day) req.user.watchToday = { day, seconds: 0 };
  req.user.watchToday.seconds += Math.min(Math.max(+delta || 0, 0), 30);
  await req.user.save();
  const lim = PLANS[plan].dailyWatchMinutes * 60;
  res.json({ completed, limitReached: lim > 0 && req.user.watchToday.seconds >= lim });
});

export default r;
