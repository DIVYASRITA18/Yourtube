import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import UAParser from "ua-parser-js";
import { User } from "./models.js";
import { PLANS } from "./plans.js";

export const signToken = (u) => jwt.sign({ id: u._id, tv: u.tokenVersion }, process.env.JWT_SECRET, { expiresIn: "7d" });

export const effectivePlan = (u) =>
  u && u.plan !== "free" && u.planExpiry && u.planExpiry > new Date() ? u.plan : "free";

export const publicUser = (u) => ({
  id: u._id, name: u.name, username: u.username, email: u.email, role: u.role, avatar: u.avatar,
  theme: u.theme, themeManual: u.themeManual, plan: effectivePlan(u), planExpiry: u.planExpiry,
});

// ---- India Standard Time helpers (UTC+5:30) ----
const IST_MS = 5.5 * 3600 * 1000;
export const istShift = (d = new Date()) => new Date(d.getTime() + IST_MS);
export const istDayKey = (d = new Date()) => istShift(d).toISOString().slice(0, 10);
export const istHour = (d = new Date()) => istShift(d).getUTCHours();
export const nextIstMidnight = (d = new Date()) =>
  new Date(Date.parse(istDayKey(d) + "T00:00:00Z") + 86400000 - IST_MS);

// ---- auth middleware ----
async function readUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const p = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(p.id);
  if (!user || user.tokenVersion !== p.tv) return null;
  return user;
}
export async function auth(req, res, next) {
  try {
    const user = await readUser(req);
    if (!user) return res.status(401).json({ message: "Please log in again." });
    req.user = user; req.userId = user._id; next();
  } catch { res.status(401).json({ message: "Invalid or expired session." }); }
}
export async function optionalAuth(req, res, next) {
  try { const user = await readUser(req); if (user) { req.user = user; req.userId = user._id; } } catch {}
  next();
}
export const adminOnly = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).json({ message: "Admin only" });

// ---- client info ----
export function clientInfo(req) {
  let ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket.remoteAddress || "";
  ip = ip.replace("::ffff:", "");
  if (ip === "::1") ip = "127.0.0.1";
  const ua = new UAParser(req.headers["user-agent"] || "").getResult();
  const t = ua.device.type;
  return {
    ip,
    browser: `${ua.browser.name || "Unknown"} ${ua.browser.major || ""}`.trim(),
    os: `${ua.os.name || "Unknown"} ${ua.os.version || ""}`.trim(),
    deviceType: t === "mobile" ? "Mobile" : t === "tablet" ? "Tablet" : "Desktop",
    deviceModel: [ua.device.vendor, ua.device.model].filter(Boolean).join(" "),
  };
}

const geoCache = new Map();
export async function geo(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
    return { city: "Localhost", state: "Local", country: "Local", approx: "Local network" };
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,lat,lon`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j.status === "success") {
      const g = { city: j.city, state: j.regionName, country: j.country, approx: `${j.lat.toFixed(1)}, ${j.lon.toFixed(1)}` };
      geoCache.set(ip, g); return g;
    }
  } catch {}
  return { city: "Unknown", state: "Unknown", country: "Unknown", approx: "" };
}

// ---- email (falls back to console when SMTP is not configured) ----
let transporter = null;
export async function sendMail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`\n[EMAIL not configured] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}\n`);
    return false;
  }
  transporter ||= nodemailer.createTransport({ service: "gmail", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  try {
    await transporter.sendMail({ from: `"YouTube 2.0" <${process.env.SMTP_USER}>`, to, subject, html });
    return true;
  } catch (e) { console.error("Email failed:", e.message); return false; }
}

export { PLANS };
