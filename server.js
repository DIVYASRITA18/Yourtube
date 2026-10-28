import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import mongoose from "mongoose";
import cron from "node-cron";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { User, Video } from "./models.js";
import authRoutes from "./routes/auth.js";
import videoRoutes from "./routes/videos.js";
import commentRoutes from "./routes/comments.js";
import subRoutes from "./routes/subscription.js";
import downloadRoutes from "./routes/downloads.js";
import adminRoutes from "./routes/admin.js";
import { setupCall } from "./call.js";

process.env.JWT_SECRET ||= "dev-secret-change-me";
// Express 4 does not catch errors thrown inside async routes; this makes them reach the error handler (JSON 500) instead of crashing Node.
try {
  const { default: Layer } = await import("express/lib/router/layer.js");
  Layer.prototype.handle_request = function (req, res, next) {
    const fn = this.handle; if (fn.length > 3) return next();
    try { const r = fn(req, res, next); if (r && typeof r.catch === "function") r.catch(next); } catch (e) { next(e); }
  };
} catch (e) { console.warn("async error patch skipped:", e.message); }
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const origins = (process.env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
const corsOpts = { origin: origins.length ? origins : true };

const app = express();
app.set("trust proxy", true);
app.use(cors(corsOpts));
app.use(express.json({ limit: "1mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/subscription", subRoutes);
app.use("/api/downloads", downloadRoutes);
app.use("/api/admin", adminRoutes);
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }));
app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: "Server error" }); });

const server = http.createServer(app);
const io = new Server(server, { cors: corsOpts, maxHttpBufferSize: 3e6 });
setupCall(io);

async function connectDB() {
  let uri = process.env.MONGO_URI;
  if (!uri) {
    console.log("No MONGO_URI set -> starting a temporary in-memory MongoDB (first run downloads it, please wait)...");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    uri = (await MongoMemoryServer.create()).getUri();
    console.log("WARNING: data is temporary and is lost when the server stops. Set MONGO_URI in .env to keep data.");
  }
  await mongoose.connect(uri);
  console.log("MongoDB connected");
}

// Sample videos ship inside the project (public/videos + public/thumbs) so they always load.
// Replace these files / paths with your own videos any time. Restarting the server updates existing records by "order".
async function seed() {
  const v = (order, title, desc, dur, minPlan, extra = {}) => ({ order, title, description: desc, url: `/videos/v${order}.mp4`, thumbnail: `/thumbs/v${order}.jpg`, duration: dur, minPlan, ...extra });
  const items = [
    v(1, "Welcome Demo (Free)", "A 60-second demo video for testing the custom player, subtitles, resume and comments.", 60, "free", { subtitles: [{ label: "English", lang: "en", src: "/subs/en.vtt" }] }),
    v(2, "Nature Colours (Free)", "A free 45-second sample video.", 45, "free"),
    v(3, "Quick Clip (Free)", "A short 15-second clip, handy for testing the autoplay countdown.", 15, "free"),
    v(4, "Bronze Exclusive", "Needs the Bronze plan or higher.", 40, "bronze"),
    v(5, "Silver Premium Course", "Needs the Silver plan or higher.", 40, "silver"),
    v(6, "Gold Masterclass", "Gold-only exclusive content.", 40, "gold"),
  ];
  await Video.bulkWrite(items.map((x) => ({ updateOne: { filter: { order: x.order }, update: { $set: x, $setOnInsert: { views: 0, channel: "YouTube 2.0" } }, upsert: true } })));
  console.log("Sample videos ready");
  const email = (process.env.ADMIN_EMAIL || "admin@demo.com").toLowerCase();
  if (!(await User.exists({ role: "admin" }))) try {
    await User.create({ name: "Admin", username: "admin", email, password: await bcrypt.hash(process.env.ADMIN_PASSWORD || "Admin@123", 10), role: "admin",
      avatar: "https://api.dicebear.com/7.x/initials/svg?seed=Admin" });
    console.log(`Admin account created: ${email} / ${process.env.ADMIN_PASSWORD || "Admin@123"}`);
  } catch (e) { console.warn("Admin account not created:", e.message); }
}

// hourly: expired subscriptions fall back to Free (watch history and data are kept)
cron.schedule("0 * * * *", async () => {
  const r = await User.updateMany({ plan: { $ne: "free" }, planExpiry: { $lt: new Date() } }, { plan: "free", autoRenew: false });
  if (r.modifiedCount) console.log(`Downgraded ${r.modifiedCount} expired subscription(s)`);
});

const PORT = process.env.PORT || 5000;
connectDB().then(seed).then(() => server.listen(PORT, () => console.log(`\n>>> Site running at http://localhost:${PORT}\n`)))
  .catch((e) => { console.error("Startup failed:", e); process.exit(1); });
