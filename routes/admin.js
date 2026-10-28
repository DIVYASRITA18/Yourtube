import { Router } from "express";
import { Report, Comment, ModLog } from "../models.js";
import { auth, adminOnly } from "../utils.js";

const r = Router();
r.use(auth, adminOnly);

r.get("/reports", async (req, res) => {
  const status = req.query.status || "open";
  const reports = await Report.find({ status }).sort({ createdAt: -1 }).limit(100)
    .populate("comment", "text userName username hidden deleted reportCount history video")
    .populate("reporter", "username");
  res.json(reports.filter((r) => r.comment));
});

r.post("/reports/:id", async (req, res) => {
  const { action, note } = req.body; // dismiss | remove
  const rep = await Report.findById(req.params.id);
  if (!rep || rep.status !== "open") return res.status(404).json({ message: "Report not found or already handled" });
  const c = await Comment.findById(rep.comment);
  const done = { resolvedBy: req.userId, resolvedAt: new Date() };
  if (action === "remove" && c) {
    c.hidden = true; c.history.push({ text: c.text, at: new Date(), action: "removed_by_moderator" }); await c.save();
    await Report.updateMany({ comment: c._id, status: "open" }, { status: "actioned", ...done });
  } else if (action === "dismiss") {
    await Report.updateOne({ _id: rep._id }, { status: "dismissed", ...done });
    if (c && !(await Report.exists({ comment: c._id, status: "open" }))) await Comment.updateOne({ _id: c._id }, { flagged: false });
  } else return res.status(400).json({ message: "Invalid action" });
  await ModLog.create({ admin: req.userId, adminName: req.user.username, action, comment: rep.comment, report: rep._id, note: (note || "").slice(0, 300) });
  res.json({ ok: true });
});

r.get("/modlog", async (req, res) => res.json(await ModLog.find().sort({ createdAt: -1 }).limit(100)));
r.get("/comment/:id/history", async (req, res) => {
  const c = await Comment.findById(req.params.id).select("history userName username");
  res.json(c || {});
});

export default r;
