import {
  canUserDmTarget,
  getChannelPostBlockReason,
} from "../policy/chat_policy.js";
import * as store from "./org_store.js";
import * as sqlite from "./sqlite_store.js";
import * as ctx from "./context_helpers.js";
import { getUserByEmail } from "./auth_service.js";
import { manager } from "../utils/websocket_manager.js";

// ── In-process hot-path caches (avoids repeated Supabase round-trips per message) ──

/** Workspace cache: workspace_id → { data, expiresAt } — 30s TTL */
const _wsCache = new Map();
async function getCachedWorkspace(workspaceId) {
  const now = Date.now();
  const cached = _wsCache.get(workspaceId);
  if (cached && cached.expiresAt > now) return cached.data;
  const ws = await store.getWorkspace(workspaceId);
  _wsCache.set(workspaceId, { data: ws, expiresAt: now + 30_000 });
  return ws;
}

/** Channel list cache: workspace_id → { data, expiresAt } — 12s TTL */
const _channelCache = new Map();
async function getCachedChannels(workspaceId) {
  const now = Date.now();
  const cached = _channelCache.get(workspaceId);
  if (cached && cached.expiresAt > now) return cached.data;
  const rows = await store.listChannelsByWorkspace(workspaceId);
  _channelCache.set(workspaceId, { data: rows, expiresAt: now + 12_000 });
  return rows;
}

/** Bust channel cache after any channel mutation (create/update/delete). */
export function bustChannelCache(workspaceId) {
  if (workspaceId != null) _channelCache.delete(workspaceId);
  else _channelCache.clear();
}

/** Native `/ws` + in-process hooks. Socket.IO clients listen via separate wiring if needed. */
function emitRoster(workspaceId) {
  const wid = Number(workspaceId);
  manager.broadcastJson({
    type: "workspace_roster_changed",
    workspace_id: wid,
  });
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

/**
 * Shared channel/DM send pipeline (REST + Socket.IO).
 * Uses in-process caches for workspace and channel lookups to minimize Supabase round-trips.
 * @returns {{ ok: true, msg_id: number } | { error: string, status?: number }}
 */
export async function dispatchOutboundMessage(u, body) {
  const {
    content,
    receiver_id: receiverId,
    channel_name: channelName,
    type: msgType = "text",
    file_path: filePath,
    client_msg_id: clientMsgId,
  } = body || {};

  if (!content && msgType === "text") {
    return { error: "No content", status: 400 };
  }
  if (u.is_restricted) {
    return {
      error: "Your communication privileges have been revoked.",
      status: 403,
    };
  }

  // Use cached workspace — avoids a Supabase round-trip on every message
  const ws = await getCachedWorkspace(u.workspace_id);
  const senderWorkspace = ws;

  if (receiverId != null) {
    const rid = Number(receiverId);
    const target = await store.listUsersByIds([rid]).then((r) => r[0]);
    if (!target) return { error: "User not found", status: 404 };
    const grant = await store.hasDmGrant(u.id, rid);
    if (!canUserDmTarget(u, target, grant, senderWorkspace)) {
      if (u.dm_allowlist_only) {
        return {
          error:
            "You may only message people your team lead has selected, or team leads.",
          status: 403,
        };
      }
      return {
        error:
          "You can only message team leads or members your team lead has approved for DMs.",
        status: 403,
      };
    }
  } else if (channelName) {
    // Fast channel lookup using in-process cache instead of full ctx.getChannelInContext
    const allChannels = await getCachedChannels(u.workspace_id);
    const channel = allChannels.find((c) => c.name === channelName) || null;
    if (!channel) return { error: "Group not found", status: 404 };
    const canView = await ctx.canViewChannelResolved(u, channel);
    if (!canView) return { error: "Group not found", status: 404 };
    const canPost = await ctx.canPostResolved(u, channel);
    if (!canPost) {
      return { error: getChannelPostBlockReason(u, channel), status: 403 };
    }
  } else {
    return { error: "receiver_id or channel_name required", status: 400 };
  }

  if (clientMsgId) {
    const existing = await sqlite.findMessageByClientMsgId(u.id, clientMsgId);
    if (existing) {
      return { ok: true, msg_id: existing.id };
    }
  }

  // 100% Pure SQLite Live Database Flow:
  const newMsg = await sqlite.insertMessage({
    sender_id: u.id,
    receiver_id: receiverId != null ? Number(receiverId) : null,
    channel_name: channelName || null,
    content: content || "",
    type: msgType,
    file_path: filePath || null,
    client_msg_id: clientMsgId || null,
    workspace_id: u.workspace_id != null ? Number(u.workspace_id) : null,
  });

  if (channelName && content) {
    // Use cached channels for mention lookup too
    const allChannels = await getCachedChannels(u.workspace_id);
    const channel = allChannels.find((c) => c.name === channelName) || null;
    if (channel) {
      const lower = String(content).toLowerCase();
      if (lower.includes("@all")) {
        const users = await ctx.getUsersForAllMention(channel, u, u.id);
        for (const x of users) {
          const exists = await store.notificationExists(x.id, newMsg.id, "all");
          if (!exists) {
            await store.insertNotification({
              user_id: x.id,
              message_id: newMsg.id,
              type: "all",
              is_seen: false,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
      const mentionRe = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
      let m;
      const seen = new Set();
      while ((m = mentionRe.exec(content)) !== null) {
        const email = m[1];
        if (seen.has(email)) continue;
        seen.add(email);
        const tagged = await getUserByEmail(email);
        if (tagged && Number(tagged.id) !== Number(u.id)) {
          const exists = await store.notificationExists(tagged.id, newMsg.id, "mention");
          if (!exists) {
            await store.insertNotification({
              user_id: tagged.id,
              message_id: newMsg.id,
              type: "mention",
              is_seen: false,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  const messagePayload = {
    id: newMsg.id,
    client_msg_id: clientMsgId || null,
    sender_email: u.email || "Unknown",
    sender_name: u.name || (u.email || "Unknown").split("@")[0],
    sender_id: u.id,
    sender_pic: u.profile_pic_url || null,
    content: newMsg.content || "",
    type: newMsg.msg_type || msgType,
    file_path: newMsg.file_path || null,
    raw_timestamp: newMsg.raw_timestamp || newMsg.timestamp,
    timestamp: newMsg.raw_timestamp ? newMsg.timestamp : fmtTime(newMsg.timestamp),
    is_read: newMsg.is_read,
    channel_name: newMsg.channel_name || null,
    receiver_id: newMsg.receiver_id || null,
    workspace_id: newMsg.workspace_id || null,
  };

  // Defer realtime fan-out to next tick so HTTP/socket ack paths return without waiting on emit I/O.
  setImmediate(() => {
    try {
      manager.broadcastJson({
        type: "new_message",
        workspace_id: u.workspace_id,
        msg_id: newMsg.id,
        channel_name: channelName || null,
        receiver_id: receiverId != null ? Number(receiverId) : null,
        sender_id: u.id,
        message: messagePayload,
      });
    } catch (e) {
      console.warn("[dispatch] native ws broadcast failed", e);
    }

    import("../socketio_server.js")
      .then(({ getIO }) => {
        const io = getIO();
        if (!io) return;
        const evt = {
          msg_id: newMsg.id,
          workspace_id: u.workspace_id,
          channel_name: channelName || null,
          receiver_id: receiverId != null ? Number(receiverId) : null,
          sender_id: u.id,
          message: messagePayload,
        };
        if (receiverId != null) {
          io.to(`user_${u.id}`).emit("new_message", evt);
          io.to(`user_${Number(receiverId)}`).emit("new_message", evt);
        } else {
          io.to(`ws_${u.workspace_id}`).emit("new_message", evt);
        }
      })
      .catch((e) => console.warn("[dispatch] socket realtime emit failed", e));
  });

  return { ok: true, msg_id: newMsg.id };
}

export { emitRoster };
