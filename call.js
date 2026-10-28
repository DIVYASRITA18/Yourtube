import jwt from "jsonwebtoken";
import { User } from "./models.js";

// In-memory rooms. peer id = user id (one connection per user per room: refresh / device switch simply takes over)
const rooms = new Map();
const MAX = () => +process.env.MAX_CALL_PARTICIPANTS || 6;
const GRACE_MS = 20000; // time allowed to reconnect after a network drop

const view = (p) => ({ id: p.id, name: p.name, username: p.username, avatar: p.avatar, muted: p.muted, cam: p.cam, hand: p.hand, sharing: p.sharing, online: p.online });
const roster = (room) => [...room.peers.values()].map(view);
const roomState = (room) => ({ hostId: room.hostId, cohosts: [...room.cohosts], locked: room.locked, permissions: room.permissions });

export function setupCall(io) {
  io.use(async (socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
      const u = await User.findById(p.id);
      if (!u || u.tokenVersion !== p.tv) return next(new Error("auth"));
      socket.data.user = { id: String(u._id), name: u.name, username: u.username, avatar: u.avatar };
      next();
    } catch { next(new Error("auth")); }
  });

  io.on("connection", (socket) => {
    const me = socket.data.user;
    let roomId = null;

    const canModerate = (room) => room.hostId === me.id || room.cohosts.has(me.id);
    const removePeer = (room, id, reason) => {
      const peer = room.peers.get(id); if (!peer) return;
      clearTimeout(peer.timer); room.peers.delete(id); room.cohosts.delete(id);
      io.to(room.id).emit("peer-left", { id, reason });
      if (!room.peers.size) { rooms.delete(room.id); return; }
      if (room.hostId === id) { // hand the room to a co-host or the longest-present participant
        room.hostId = [...room.cohosts][0] || room.peers.keys().next().value;
        room.cohosts.delete(room.hostId);
        io.to(room.id).emit("room-state", roomState(room));
      }
    };

    socket.on("join", ({ room: rid }, ack = () => {}) => {
      rid = String(rid || "").trim().toLowerCase();
      if (!/^[a-z0-9-]{4,40}$/.test(rid)) return ack({ error: "Invalid room ID (use 4-40 letters, numbers or -)" });
      let room = rooms.get(rid);
      if (!room) {
        room = { id: rid, hostId: me.id, cohosts: new Set(), locked: false, permissions: { screen: true, chat: true }, peers: new Map() };
        rooms.set(rid, room);
      }
      const existing = room.peers.get(me.id);
      if (!existing) {
        if (room.locked) return ack({ error: "This meeting is locked by the host." });
        if (room.peers.size >= MAX()) return ack({ error: `Meeting is full (max ${MAX()} participants).` });
      }
      if (existing) { // reconnect / refresh / switched device -> take over
        clearTimeout(existing.timer);
        if (existing.socketId !== socket.id) io.to(existing.socketId).emit("replaced");
      }
      const peer = { id: me.id, name: me.name, username: me.username, avatar: me.avatar, socketId: socket.id,
        muted: existing?.muted ?? false, cam: existing?.cam ?? true, hand: false, sharing: false, online: true, timer: null };
      room.peers.set(me.id, peer);
      roomId = rid; socket.join(rid);
      socket.to(rid).emit("peer-joined", view(peer));
      ack({ ok: true, me: me.id, state: roomState(room), peers: roster(room) });
    });

    socket.on("signal", ({ to, data }) => {
      const room = rooms.get(roomId); const target = room?.peers.get(to);
      if (target) io.to(target.socketId).emit("signal", { from: me.id, data });
    });

    socket.on("state", (s) => {
      const peer = rooms.get(roomId)?.peers.get(me.id); if (!peer) return;
      if (typeof s.muted === "boolean") peer.muted = s.muted;
      if (typeof s.cam === "boolean") peer.cam = s.cam;
      io.to(roomId).emit("peer-state", view(peer));
    });
    socket.on("hand", ({ up }) => {
      const peer = rooms.get(roomId)?.peers.get(me.id); if (!peer) return;
      peer.hand = !!up; io.to(roomId).emit("peer-state", view(peer));
    });
    socket.on("screen", ({ on }, ack = () => {}) => {
      const room = rooms.get(roomId); const peer = room?.peers.get(me.id); if (!peer) return;
      if (on && !room.permissions.screen && !canModerate(room)) return ack({ error: "The host has disabled screen sharing." });
      peer.sharing = !!on; io.to(roomId).emit("peer-state", view(peer)); ack({ ok: true });
    });

    socket.on("chat", ({ text, file }, ack = () => {}) => {
      const room = rooms.get(roomId); if (!room) return;
      if (!room.permissions.chat && !canModerate(room)) return ack({ error: "Chat is disabled by the host." });
      if (file && (!file.data || file.data.length > 1_500_000)) return ack({ error: "File too large (max ~1 MB)." });
      io.to(roomId).emit("chat", { from: me.id, name: me.name, text: String(text || "").slice(0, 1000), file: file || null, at: Date.now() });
      ack({ ok: true });
    });

    // host / co-host controls
    socket.on("mod", ({ action, target, value }, ack = () => {}) => {
      const room = rooms.get(roomId); if (!room || !canModerate(room)) return ack({ error: "Only the host or a co-host can do that." });
      const isHost = room.hostId === me.id;
      const tp = room.peers.get(target);
      const protectedTarget = target === room.hostId || (room.cohosts.has(target) && !isHost);
      switch (action) {
        case "mute": if (tp && !protectedTarget) io.to(tp.socketId).emit("force-mute"); break;
        case "kick": if (tp && !protectedTarget) { io.to(tp.socketId).emit("kicked"); removePeer(room, target, "removed"); } break;
        case "lock": room.locked = !!value; break;
        case "cohost": if (!isHost) return ack({ error: "Only the host can assign co-hosts." }); if (tp && target !== room.hostId) value ? room.cohosts.add(target) : room.cohosts.delete(target); break;
        case "perm": if (["screen", "chat"].includes(value?.key)) room.permissions[value.key] = !!value.on; break;
        case "end": if (!isHost) return ack({ error: "Only the host can end the meeting." }); io.to(roomId).emit("ended"); rooms.delete(roomId); return ack({ ok: true });
        default: return ack({ error: "Unknown action" });
      }
      io.to(roomId).emit("room-state", roomState(room)); ack({ ok: true });
    });

    socket.on("leave", () => { const room = rooms.get(roomId); if (room) removePeer(room, me.id, "left"); socket.leave(roomId); roomId = null; });

    socket.on("disconnect", () => {
      const room = rooms.get(roomId); const peer = room?.peers.get(me.id);
      if (!peer || peer.socketId !== socket.id) return; // already replaced by a newer connection
      peer.online = false; io.to(roomId).emit("peer-state", view(peer));
      peer.timer = setTimeout(() => removePeer(room, me.id, "disconnected"), GRACE_MS);
    });
  });
}
