import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User, LoginLog, Otp } from "../models.js";
import { auth, clientInfo, geo, signToken, publicUser, sendMail, istHour } from "../utils.js";

const r = Router();
const TRUST_DAYS = +process.env.TRUSTED_DAYS || 30;

// simple brute-force limiter: 10 tries / 15 min per ip+email
const tries = new Map();
const recent = (key) => (tries.get(key) || []).filter((t) => Date.now() - t < 15 * 60000);
const limited = (key) => recent(key).length >= 10;
const addFail = (key) => tries.set(key, [...recent(key), Date.now()]);

r.post("/register", async (req, res) => {
  try {
    let { name, username, email, password } = req.body;
    if (!name || !username || !email || !password) return res.status(400).json({ message: "All fields are required" });
    username = username.toLowerCase().trim(); email = email.toLowerCase().trim();
    if (!/^[a-z0-9_.-]{3,20}$/.test(username)) return res.status(400).json({ message: "Username: 3-20 letters, numbers, . _ -" });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: "Enter a valid email" });
    if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
    if (await User.findOne({ $or: [{ email }, { username }] }))
      return res.status(409).json({ message: "Email or username is already taken" });
    await User.create({
      name: name.trim(), username, email, password: await bcrypt.hash(password, 10),
      avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`,
    });
    res.json({ message: "Registered! Please log in." });
  } catch (e) { console.error(e); res.status(500).json({ message: "Registration failed" }); }
});

const row = (user, info, g, deviceId, status) =>
  LoginLog.create({ user: user._id, email: user.email, ...info, city: g.city, state: g.state, country: g.country, approx: g.approx, deviceId, status });

async function finish(user, info, g, deviceId, trust) {
  user.lastLocation = { city: g.city, state: g.state, country: g.country };
  if (!user.themeManual) { const h = istHour(); user.theme = h >= 5 && h < 12 ? "light" : "dark"; } // 5AM-12PM IST => light
  if (trust) {
    user.trustedDevices = user.trustedDevices.filter((d) => d.deviceId !== deviceId);
    user.trustedDevices.push({ deviceId, label: `${info.browser} on ${info.os}`, addedAt: new Date(), expiresAt: new Date(Date.now() + TRUST_DAYS * 86400000) });
  }
  await user.save();
  await row(user, info, g, deviceId, "success");
  return { token: signToken(user), user: publicUser(user) };
}

r.post("/login", async (req, res) => {
  try {
    const { email, password, deviceId } = req.body;
    if (!email || !password || !deviceId) return res.status(400).json({ message: "Email and password are required" });
    const info = clientInfo(req);
    const lkey = info.ip + String(email).toLowerCase();
    if (limited(lkey)) return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
    const g = await geo(info.ip);
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      addFail(lkey);
      if (user) await row(user, info, g, deviceId, "bad_password");
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const now = new Date();
    const trusted = user.trustedDevices.some((d) => d.deviceId === deviceId && d.expiresAt > now);
    const prior = await LoginLog.find({ user: user._id, status: "success" }).select("ip city state").lean();
    const firstEver = prior.length === 0;
    const newIp = !prior.some((p) => p.ip === info.ip);
    const newPlace = !prior.some((p) => p.city === g.city && p.state === g.state);
    // OTP when: new/untrusted browser or device, OR new IP AND new city/state
    const needOtp = !firstEver && (!trusted || (newIp && newPlace));
    if (!needOtp) return res.json(await finish(user, info, g, deviceId, firstEver));

    const code = String(crypto.randomInt(100000, 1000000));
    const reason = !trusted ? "new browser or device" : "new IP address and location";
    const otp = await Otp.create({ user: user._id, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + 5 * 60000), deviceId, reason });
    await row(user, info, g, deviceId, "otp_required");
    const sent = await sendMail(user.email, "Your login verification code",
      `<p>Hi ${user.name}, your one-time code is <b style="font-size:20px">${code}</b>.</p><p>It expires in 5 minutes. Reason: ${reason}.</p>`);
    console.log(`[OTP] ${user.email} -> ${code}`);
    res.json({ otpRequired: true, otpId: otp._id, reason, emailSent: sent, ...(process.env.NODE_ENV === "production" && sent ? {} : { devOtp: code }) });
  } catch (e) { console.error(e); res.status(500).json({ message: "Login failed" }); }
});

r.post("/verify-otp", async (req, res) => {
  try {
    const { otpId, code, trustDevice } = req.body;
    const otp = await Otp.findById(otpId).catch(() => null);
    if (!otp || otp.used || otp.expiresAt < new Date()) return res.status(400).json({ message: "Code expired. Please log in again." });
    const user = await User.findById(otp.user);
    const info = clientInfo(req); const g = await geo(info.ip);
    if (otp.attempts >= 5) return res.status(429).json({ message: "Too many wrong attempts. Please log in again." });
    if (!(await bcrypt.compare(String(code || "").trim(), otp.codeHash))) {
      otp.attempts += 1; await otp.save();
      await row(user, info, g, otp.deviceId, "otp_failed");
      return res.status(400).json({ message: `Wrong code. ${5 - otp.attempts} attempts left.` });
    }
    otp.used = true; await otp.save();
    await row(user, info, g, otp.deviceId, "otp_verified");
    res.json(await finish(user, info, g, otp.deviceId, !!trustDevice));
  } catch (e) { console.error(e); res.status(500).json({ message: "Verification failed" }); }
});

r.get("/me", auth, (req, res) => res.json(publicUser(req.user)));

// manual theme (saved to profile, follows the user to every device). theme="auto" goes back to login-time rule
r.put("/theme", auth, async (req, res) => {
  const { theme } = req.body;
  if (theme === "auto") { const h = istHour(); req.user.themeManual = false; req.user.theme = h >= 5 && h < 12 ? "light" : "dark"; }
  else if (["light", "dark"].includes(theme)) { req.user.theme = theme; req.user.themeManual = true; }
  else return res.status(400).json({ message: "Invalid theme" });
  await req.user.save();
  res.json(publicUser(req.user));
});

r.get("/security", auth, async (req, res) => {
  const logs = await LoginLog.find({ user: req.userId }).sort({ createdAt: -1 }).limit(60).lean();
  res.json({
    logs, trustDays: TRUST_DAYS,
    devices: req.user.trustedDevices.filter((d) => d.expiresAt > new Date()),
  });
});
r.delete("/security/device/:deviceId", auth, async (req, res) => {
  req.user.trustedDevices = req.user.trustedDevices.filter((d) => d.deviceId !== req.params.deviceId);
  await req.user.save(); res.json({ ok: true });
});
r.post("/security/logout-all", auth, async (req, res) => {
  req.user.tokenVersion += 1; await req.user.save();
  res.json({ message: "All sessions logged out." });
});

// @mention autocomplete
r.get("/users", auth, async (req, res) => {
  const q = String(req.query.q || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  if (!q) return res.json([]);
  const list = await User.find({ username: new RegExp("^" + q.replace(/\./g, "\\.")) }).limit(6).select("username name avatar");
  res.json(list);
});

export default r;
