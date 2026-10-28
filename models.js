import mongoose from "mongoose";
const { Schema, model } = mongoose;
const ObjId = Schema.Types.ObjectId;

const userSchema = new Schema({
  name: String,
  username: { type: String, unique: true, lowercase: true },
  email: { type: String, unique: true, lowercase: true },
  password: String,
  role: { type: String, default: "user" },
  avatar: String,
  plan: { type: String, enum: ["free", "bronze", "silver", "gold"], default: "free" },
  planPeriod: String,
  planStart: Date,
  planExpiry: Date,
  autoRenew: { type: Boolean, default: true },
  theme: { type: String, default: "dark" },
  themeManual: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 },
  trustedDevices: [{ deviceId: String, label: String, addedAt: Date, expiresAt: Date }],
  lastLocation: { city: String, state: String, country: String },
  watchToday: { day: String, seconds: { type: Number, default: 0 } },
}, { timestamps: true });

const videoSchema = new Schema({
  title: String, description: String, url: String, thumbnail: String,
  duration: Number, minPlan: { type: String, default: "free" },
  channel: { type: String, default: "YouTube 2.0" },
  views: { type: Number, default: 0 }, order: Number,
  subtitles: [{ label: String, lang: String, src: String }],
}, { timestamps: true });

const commentSchema = new Schema({
  video: { type: ObjId, ref: "Video", index: true },
  user: { type: ObjId, ref: "User" },
  userName: String, username: String, avatar: String, location: String,
  text: String, norm: String,
  parent: { type: ObjId, ref: "Comment", default: null },
  mentions: [String],
  likes: [{ type: ObjId }], dislikes: [{ type: ObjId }],
  deleted: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
  edited: { type: Boolean, default: false }, editedAt: Date,
  version: { type: Number, default: 0 },
  history: [{ text: String, at: Date, action: String }],
  flagged: { type: Boolean, default: false },
  reportCount: { type: Number, default: 0 },
}, { timestamps: true });

const reportSchema = new Schema({
  comment: { type: ObjId, ref: "Comment" },
  reporter: { type: ObjId, ref: "User" },
  reason: { type: String, enum: ["spam", "harassment", "offensive", "hate", "misinformation", "other"] },
  details: String,
  status: { type: String, enum: ["open", "dismissed", "actioned"], default: "open" },
  resolvedBy: { type: ObjId, ref: "User" }, resolvedAt: Date,
}, { timestamps: true });
reportSchema.index({ comment: 1, reporter: 1 }, { unique: true }); // blocks duplicate reports

const modLogSchema = new Schema({
  admin: { type: ObjId, ref: "User" }, adminName: String,
  action: String, comment: { type: ObjId, ref: "Comment" }, report: { type: ObjId }, note: String,
}, { timestamps: true });

const transactionSchema = new Schema({
  user: { type: ObjId, ref: "User", index: true },
  orderId: { type: String, unique: true },
  paymentId: { type: String, unique: true, sparse: true },
  invoiceNumber: String, plan: String, period: String,
  amount: Number, currency: { type: String, default: "INR" },
  status: { type: String, enum: ["created", "paid", "failed", "cancelled"], default: "created" },
  failureReason: String, startDate: Date, expiryDate: Date, renewal: { type: Boolean, default: false },
}, { timestamps: true });

const downloadSchema = new Schema({
  user: { type: ObjId, ref: "User", index: true },
  video: { type: ObjId, ref: "Video" }, videoTitle: String, thumbnail: String,
  status: { type: String, enum: ["started", "completed", "interrupted", "failed"], default: "started" },
  countsToQuota: { type: Boolean, default: true },
  size: { type: Number, default: 0 }, plan: String, dayKey: String,
  token: { type: String, index: true }, tokenExpires: Date, tokenUsed: { type: Boolean, default: false },
  ip: String, deviceId: String, device: String, browser: String, os: String,
  completedAt: Date,
}, { timestamps: true });

const loginLogSchema = new Schema({
  user: { type: ObjId, ref: "User", index: true }, email: String,
  ip: String, browser: String, os: String, deviceType: String, deviceModel: String, deviceId: String,
  city: String, state: String, country: String, approx: String,
  status: { type: String, enum: ["success", "otp_required", "otp_verified", "otp_failed", "bad_password"] },
}, { timestamps: true });

const otpSchema = new Schema({
  user: { type: ObjId, ref: "User" }, codeHash: String, expiresAt: Date,
  attempts: { type: Number, default: 0 }, used: { type: Boolean, default: false },
  deviceId: String, reason: String,
}, { timestamps: true });

const progressSchema = new Schema({
  user: { type: ObjId, ref: "User" }, video: { type: ObjId, ref: "Video" },
  seconds: { type: Number, default: 0 }, duration: Number, completed: { type: Boolean, default: false },
}, { timestamps: true });
progressSchema.index({ user: 1, video: 1 }, { unique: true });

export const User = model("User", userSchema);
export const Video = model("Video", videoSchema);
export const Comment = model("Comment", commentSchema);
export const Report = model("Report", reportSchema);
export const ModLog = model("ModLog", modLogSchema);
export const Transaction = model("Transaction", transactionSchema);
export const Download = model("Download", downloadSchema);
export const LoginLog = model("LoginLog", loginLogSchema);
export const Otp = model("Otp", otpSchema);
export const Progress = model("Progress", progressSchema);
