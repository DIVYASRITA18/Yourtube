import { Router } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { User, Transaction } from "../models.js";
import { auth, effectivePlan, sendMail, PLANS } from "../utils.js";
import { PERIOD_DAYS } from "../plans.js";

const r = Router();
const live = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
let rzp = null;
const getRzp = () => (rzp ||= new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }));

r.get("/plans", (req, res) => res.json({ plans: PLANS, demo: !live() }));

r.get("/me", auth, (req, res) => {
  const u = req.user; const plan = effectivePlan(u);
  res.json({
    plan, period: plan === "free" ? null : u.planPeriod, start: plan === "free" ? null : u.planStart,
    expiry: plan === "free" ? null : u.planExpiry,
    daysLeft: plan === "free" ? null : Math.max(0, Math.ceil((u.planExpiry - Date.now()) / 86400000)),
    autoRenew: u.autoRenew, nextRenewal: plan !== "free" && u.autoRenew ? u.planExpiry : null,
    features: PLANS[plan].features, renewEligible: plan !== "free" && u.planExpiry - Date.now() < 7 * 86400000,
  });
});

r.get("/history", auth, async (req, res) => res.json(await Transaction.find({ user: req.userId }).sort({ createdAt: -1 })));

r.post("/order", auth, async (req, res) => {
  try {
    const { plan, period } = req.body;
    if (!PLANS[plan] || plan === "free" || !PERIOD_DAYS[period]) return res.status(400).json({ message: "Invalid plan or period" });
    const u = req.user; const cur = effectivePlan(u);
    if (cur === plan && u.planPeriod === period && u.planExpiry - Date.now() > 7 * 86400000)
      return res.status(400).json({ message: "You already have this plan. Renewal opens in the last 7 days." });

    // duplicate payment attempt: reuse an unpaid order created in the last 10 minutes
    const recent = await Transaction.findOne({ user: req.userId, plan, period, status: "created", createdAt: { $gt: new Date(Date.now() - 600000) } });
    if (recent) return res.json({ orderId: recent.orderId, amount: recent.amount * 100, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID || null, demo: !live() });

    const amount = PLANS[plan].price[period];
    let orderId;
    if (live()) orderId = (await getRzp().orders.create({ amount: amount * 100, currency: "INR", receipt: "rcpt_" + Date.now() })).id;
    else orderId = "demo_order_" + crypto.randomBytes(6).toString("hex");
    await Transaction.create({ user: req.userId, orderId, plan, period, amount, renewal: cur === plan });
    res.json({ orderId, amount: amount * 100, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID || null, demo: !live() });
  } catch (e) { console.error(e); res.status(500).json({ message: "Could not create the payment order. Try again." }); }
});

r.post("/verify", auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const tx = await Transaction.findOne({ orderId: razorpay_order_id, user: req.userId });
    if (!tx) return res.status(404).json({ message: "Order not found" });
    if (tx.status === "paid") return res.json({ message: "Already verified", transaction: tx }); // idempotent (refresh / double click)

    let valid;
    if (live()) {
      const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
      valid = expected === razorpay_signature;
    } else valid = razorpay_order_id.startsWith("demo_order_") && razorpay_signature === "demo";
    if (!valid) { tx.status = "failed"; tx.failureReason = "Signature mismatch"; await tx.save(); return res.status(400).json({ message: "Payment verification failed" }); }

    const u = req.user;
    const base = tx.renewal && u.planExpiry > new Date() ? new Date(u.planExpiry) : new Date();
    const expiry = new Date(base.getTime() + PERIOD_DAYS[tx.period] * 86400000);
    tx.status = "paid"; tx.paymentId = razorpay_payment_id; tx.startDate = base; tx.expiryDate = expiry;
    tx.invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-5)}`;
    try { await tx.save(); } catch (e) { if (e.code === 11000) return res.json({ message: "Duplicate payment ignored" }); throw e; }

    u.plan = tx.plan; u.planPeriod = tx.period; u.planStart = base; u.planExpiry = expiry; u.autoRenew = true; await u.save();
    sendMail(u.email, `Your invoice ${tx.invoiceNumber}`, `
      <div style="font-family:Arial;max-width:560px;margin:auto;border:1px solid #ddd;padding:20px">
      <h2>Payment receipt ${tx.invoiceNumber}</h2><p>Hi ${u.name}, thanks for subscribing!</p>
      <table cellpadding="6"><tr><td>Plan</td><td><b>${tx.plan.toUpperCase()} (${tx.period})</b></td></tr>
      <tr><td>Amount</td><td>${tx.currency} ${tx.amount}</td></tr><tr><td>Order ID</td><td>${tx.orderId}</td></tr>
      <tr><td>Payment ID</td><td>${tx.paymentId}</td></tr><tr><td>Status</td><td>${tx.status}</td></tr>
      <tr><td>Valid from</td><td>${tx.startDate.toDateString()}</td></tr><tr><td>Valid until</td><td>${tx.expiryDate.toDateString()}</td></tr></table>
      <p>Support: ${process.env.SUPPORT_EMAIL || "support@example.com"}</p></div>`);
    res.json({ message: "Subscription activated", transaction: tx });
  } catch (e) { console.error(e); res.status(500).json({ message: "Verification error. If money was deducted, contact support with your payment ID." }); }
});

r.post("/failed", auth, async (req, res) => {
  const { orderId, reason, cancelled } = req.body;
  await Transaction.updateOne({ orderId, user: req.userId, status: "created" }, { status: cancelled ? "cancelled" : "failed", failureReason: reason || "Unknown" });
  res.json({ ok: true });
});

r.post("/cancel", auth, async (req, res) => {
  req.user.autoRenew = false; await req.user.save();
  res.json({ message: "Auto-renew is off. You keep access until your plan expires." });
});

export default r;
