import {
  canUserDmTarget,
  getChannelPostBlockReason,
} from "../policy/chat_policy.js";
import * as store from "./org_store.js";
import * as sqlite from "./sqlite_store.js";
import * as ctx from "./context_helpers.js";
import { getUserByEmail } from "./auth_service.js";
import { manager } from "../utils/websocket_manager.js";

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
 * Shared channel/DM send pipeline (REST + future Socket.IO).
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

  const ws = await store.getWorkspace(u.workspace_id);
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
    const channel = await ctx.getChannelInContext(u, { channelName });
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
    const existing = await store.findMessageByClientMsgId(u.id, clientMsgId);
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
    const channel = await ctx.getChannelInContext(u, { channelName });
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

  manager.broadcastJson({
    type: "new_message",
    workspace_id: u.workspace_id,
    msg_id: newMsg.id,
    channel_name: channelName || null,
    receiver_id: receiverId != null ? Number(receiverId) : null,
    sender_id: u.id,
    message: {
      id: newMsg.id,
      client_msg_id: clientMsgId || null,
      sender_email: u.email || "Unknown",
      sender_name: u.name || (u.email || "Unknown").split("@")[0],
      sender_id: u.id,
      sender_pic: u.profile_pic_url || null,
      content: newMsg.content || "",
      type: newMsg.msg_type || msgType,
      file_path: newMsg.file_path || null,
      raw_timestamp: newMsg.timestamp,
      timestamp: fmtTime(newMsg.timestamp),
      is_read: newMsg.is_read,
      channel_name: newMsg.channel_name || null,
      receiver_id: newMsg.receiver_id || null,
      workspace_id: newMsg.workspace_id || null,
    },
  });

  try {
    const { getIO } = await import("../socketio_server.js");
    const io = getIO();
    if (io) {
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
        raw_timestamp: newMsg.timestamp,
        timestamp: fmtTime(newMsg.timestamp),
        is_read: newMsg.is_read,
        channel_name: newMsg.channel_name || null,
        receiver_id: newMsg.receiver_id || null,
        workspace_id: newMsg.workspace_id || null,
      };
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
        // Ultra-fast fanout for low latency: emit once to workspace room.
        // Client filters by channel_name and existing visibility constraints.
        io.to(`ws_${u.workspace_id}`).emit("new_message", evt);
      }
    }
  } catch (e) {
    console.warn("[dispatch] socket realtime emit failed", e);
  }

  return { ok: true, msg_id: newMsg.id };
}

export { emitRoster };
