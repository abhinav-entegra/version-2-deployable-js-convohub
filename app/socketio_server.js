import { Server } from "socket.io";
import { decodeAccessToken } from "./utils/security.js";
import { getUserById } from "./services/auth_service.js";
import { AUTH_DISABLED, GUEST_USER_ID } from "./config.js";
import { canUserDmTarget } from "./policy/chat_policy.js";
import * as store from "./services/org_store.js";
import * as sqlite from "./services/sqlite_store.js";
import * as ctx from "./services/context_helpers.js";
import { dispatchOutboundMessage } from "./services/message_dispatch.js";

let ioRef = null;
const onlineUserIds = new Set();

export function getOnlineSocketUserIds() {
  return [...onlineUserIds];
}

export function getIO() {
  return ioRef;
}

export function broadcastWorkspaceRoster(workspaceId) {
  if (ioRef) {
    ioRef.emit("workspace_roster_changed", { workspace_id: Number(workspaceId) });
  }
}

function parseCookie(header, name) {
  if (!header || typeof header !== "string") return null;
  const m = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1].trim()) : null;
}

/**
 * Socket.IO on /socket.io/ — parity with Flask-SocketIO realtime_handlers (calls, presence).
 */
export function attachSocketIO(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token;
      if (!token) token = parseCookie(socket.handshake.headers?.cookie, "access_token");
      let user = null;
      if (token) {
        const payload = decodeAccessToken(token);
        const uid = Number(payload?.sub);
        if (Number.isFinite(uid)) user = await getUserById(uid);
      }
      if (!user && AUTH_DISABLED) {
        user = await getUserById(GUEST_USER_ID);
      }
      if (!user) return next(new Error("unauthorized"));
      socket.user = user;
      socket.userId = user.id;
      next();
    } catch (e) {
      console.error("[socket.io] auth middleware error", e);
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const u = socket.user;
    onlineUserIds.add(u.id);
    socket.join(`user_${u.id}`);
    socket.join(`ws_${u.workspace_id}`);
    io.emit("user_status_change", { user_id: u.id, status: "online" });

    socket.on("join", () => { });

    socket.on("call-user", async (data, ack) => {
      try {
        const targetId = Number(data?.to);
        if (!Number.isFinite(targetId)) return;

        console.log(`[socket] call-user from ${u.id} to ${targetId}`);

        const target = await getUserById(targetId);
        const ws = await store.getWorkspace(u.workspace_id);
        const grant = await store.hasDmGrant(u.id, targetId);
        const allowed = !!target && canUserDmTarget(u, target, grant, ws);

        if (!allowed) {
          console.warn("[call-user] denied", { from: u.id, to: targetId });
          if (typeof ack === "function") ack({ ok: false, error: "DM not allowed" });
          return;
        }

        io.to(`user_${targetId}`).emit("incoming-call", {
          from: u.id,
          from_email: u.email,
          offer: data?.offer,
          type: data?.type,
          context: data?.context ?? null,
        });
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        console.error("[socket] call-user handler error", e);
        if (typeof ack === "function") ack({ ok: false, error: "Internal signaling error" });
      }
    });

    socket.on("answer-call", async (data) => {
      try {
        const targetId = Number(data?.to);
        if (!Number.isFinite(targetId)) return;

        console.log(`[socket] answer-call from ${u.id} to ${targetId}`);
        io.to(`user_${targetId}`).emit("call-answered", { from: u.id, answer: data?.answer });
      } catch (e) {
        console.error("[socket] answer-call handler error", e);
      }
    });

    socket.on("ice-candidate", async (data) => {
      try {
        const targetId = Number(data?.to);
        if (!Number.isFinite(targetId)) return;
        io.to(`user_${targetId}`).emit("ice-candidate", { from: u.id, candidate: data?.candidate });
      } catch (e) {
        console.error("[socket] ice-candidate handler error", e);
      }
    });

    socket.on("end-call", async (data) => {
      try {
        const targetId = Number(data?.to);
        if (!Number.isFinite(targetId)) return;

        console.log(`[socket] end-call from ${u.id} to ${targetId}`);
        io.to(`user_${targetId}`).emit("call-ended", { from: u.id });
      } catch (e) {
        console.error("[socket] end-call handler error", e);
      }
    });

    socket.on("join-huddle", async (data) => {
      try {
        const channelName = data?.channel_name;
        if (!channelName || typeof channelName !== "string") return;
        const channel = await ctx.getChannelInContext(u, { channelName });
        if (!channel || !(await ctx.canViewChannelResolved(u, channel))) return;
        const room = `huddle:${u.workspace_id}:${channel.name}`;
        await socket.join(room);
        socket.to(room).emit("huddle-peer-joined", {
          user_id: u.id,
          channel_name: channel.name,
        });
      } catch (e) {
        console.error("[socket] join-huddle handler error", e);
      }
    });

    socket.on("leave-huddle", async (data) => {
      try {
        const channelName = data?.channel_name;
        if (!channelName || typeof channelName !== "string") return;
        const room = `huddle:${u.workspace_id}:${channelName}`;
        await socket.leave(room);
        socket.to(room).emit("huddle-peer-left", { user_id: u.id, channel_name: channelName });
      } catch (e) {
        console.error("[socket] leave-huddle handler error", e);
      }
    });

    socket.on("huddle-action", (data) => {
      const channelName = data?.channel_name;
      if (!channelName || typeof channelName !== "string") return;
      const room = `huddle:${u.workspace_id}:${channelName}`;
      socket.to(room).emit("huddle-action", { from: u.id, ...data });
    });

    socket.on("huddle-signal", (data) => {
      const targetId = Number(data?.to);
      if (!Number.isFinite(targetId)) return;
      io.to(`user_${targetId}`).emit("huddle-signal", {
        from: u.id,
        payload: data?.payload,
      });
    });

    socket.on("get_channel_messages", async (data, ack) => {
      try {
        const channelName = data.channel_name;
        const limit = Math.max(1, Math.min(200, Number(data.limit) || 50));
        const markVisit = data.mark_visit !== false;

        const channel = await ctx.getChannelInContext(u, { channelName });
        if (!channel || !(await ctx.canViewChannelResolved(u, channel))) {
          if (ack) ack({ error: "Group not found" });
          return;
        }
        let msgs = await sqlite.listMessagesForChannel(channelName, u.workspace_id, u.workspace_id, {
          limit,
          beforeTs: data.before,
          afterTs: data.after,
        });
        if (!msgs || msgs.length === 0) {
          msgs = await store.listMessagesForChannel(channelName, u.workspace_id, u.workspace_id, {
            limit, beforeTs: data.before, afterTs: data.after
          });
        }
        if (markVisit) await sqlite.upsertChannelVisit(u.id, channelName);

        const senderIds = [...new Set((msgs || []).map((m) => Number(m.sender_id)).filter((x) => Number.isFinite(x)))];
        const senders = await sqlite.ensureUsersCached(senderIds, store);
        const senderById = new Map(senders.map((s) => [Number(s.id), s]));

        function fmtTime(ts) {
          try {
            if (!ts) return "";
            var iso = String(ts).replace(" ", "T");
            if (!iso.includes("Z") && !iso.includes("+")) iso += "Z";
            return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          } catch { return ""; }
        }

        const out = msgs.map((m) => {
          const sender = senderById.get(Number(m.sender_id));
          return {
            id: m.id,
            sender_email: sender?.email || "Unknown",
            sender_name: sender?.name || sender?.email?.split("@")[0] || "Unknown",
            sender_id: m.sender_id,
            sender_pic: sender?.profile_pic_url || null,
            content: m.content,
            type: m.msg_type || m.type,
            file_path: m.file_path,
            client_msg_id: m.client_msg_id || null,
            raw_timestamp: m.timestamp,
            timestamp: fmtTime(m.timestamp),
            is_me: Number(m.sender_id) === Number(u.id),
            is_read: m.is_read || false,
          };
        });
        if (ack) ack({ rows: out });
      } catch (e) {
        console.error("get_channel_messages error", e);
        if (ack) ack({ error: "internal error" });
      }
    });

    socket.on("get_dm_messages", async (data, ack) => {
      try {
        const rid = Number(data.receiver_id);
        const limit = Math.max(1, Math.min(200, Number(data.limit) || 50));
        const markRead = data.mark_read !== false;

        let msgs = await sqlite.listDmMessages(u.id, rid, u.workspace_id, { limit, beforeTs: data.before, afterTs: data.after });
        if (!msgs || msgs.length === 0) {
          msgs = await store.listDmMessages(u.id, rid, { limit, beforeTs: data.before, afterTs: data.after });
        }

        if (markRead) await sqlite.markDmReadForReceiver(u.id, rid);

        const senderIds = [...new Set((msgs || []).map((m) => Number(m.sender_id)).filter((x) => Number.isFinite(x)))];
        const senders = await sqlite.ensureUsersCached(senderIds, store);
        const senderById = new Map(senders.map((s) => [Number(s.id), s]));

        function fmtTime(ts) {
          try {
            if (!ts) return "";
            var iso = String(ts).replace(" ", "T");
            if (!iso.includes("Z") && !iso.includes("+")) iso += "Z";
            return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          } catch { return ""; }
        }

        const out = msgs.map((m) => {
          const sender = senderById.get(Number(m.sender_id));
          return {
            id: m.id,
            sender_email: sender?.email || "Unknown",
            sender_name: sender?.name || sender?.email?.split("@")[0] || "Unknown",
            sender_id: m.sender_id,
            sender_pic: sender?.profile_pic_url || null,
            content: m.content,
            type: m.msg_type || m.type,
            file_path: m.file_path,
            client_msg_id: m.client_msg_id || null,
            raw_timestamp: m.timestamp,
            timestamp: fmtTime(m.timestamp),
            is_me: Number(m.sender_id) === Number(u.id),
            is_read: m.is_read || false,
          };
        });
        if (ack) ack({ rows: out });
      } catch (e) {
        console.error("get_dm_messages error", e);
        if (ack) ack({ error: "internal error" });
      }
    });

    socket.on("message", async (payload, ack) => {
      try {
        const result = await dispatchOutboundMessage(u, payload || {});
        if (typeof ack === "function") {
          ack(result.ok ? { ok: true, msg_id: result.msg_id } : { error: result.error, status: result.status });
        }
      } catch (e) {
        console.error("[socket] message handler error", e);
        if (typeof ack === "function") ack({ error: "internal_error", status: 500 });
      }
    });

    socket.on("disconnect", () => {
      onlineUserIds.delete(u.id);
      io.emit("user_status_change", { user_id: u.id, status: "offline" });
    });
  });

  ioRef = io;
  return io;
}
