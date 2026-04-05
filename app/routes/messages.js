import express from "express";
import * as store from "../services/org_store.js";
import * as sqlite from "../services/sqlite_store.js";
import * as ctx from "../services/context_helpers.js";
import { dispatchOutboundMessage } from "../services/message_dispatch.js";

const router = express.Router();

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

router.get("/get_messages", async (req, res) => {
  const u = req.user;
  const receiverId = req.query.receiver_id;
  const channelName = req.query.channel_name;
  const markRead = String(req.query.mark_read || "1") !== "0";
  const markVisit = String(req.query.mark_visit || "1") !== "0";
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  function isIso(s) {
    return s && typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);
  }
  const beforeTs = isIso(req.query.before) ? req.query.before : null;
  const afterTs = isIso(req.query.after) ? req.query.after : null;

  function mapMessagesWithSenders(msgs, senderById) {
    return msgs.map((m) => {
      const sender = senderById.get(Number(m.sender_id));
      const raw = m.raw_timestamp || m.timestamp;
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
        raw_timestamp: raw,
        timestamp: m.raw_timestamp ? m.timestamp : fmtTime(m.timestamp),
        is_me: Number(m.sender_id) === Number(u.id),
        is_read: m.is_read,
      };
    });
  }

  if (channelName) {
    const channel = await ctx.getChannelInContext(u, { channelName });
    if (!channel || !(await ctx.canViewChannelResolved(u, channel))) {
      return res.status(404).json({ error: "Group not found" });
    }
    let msgs = await sqlite.listMessagesForChannel(channelName, u.workspace_id, u.workspace_id, {
      limit,
      beforeTs,
      afterTs,
    });
    if (!msgs || msgs.length === 0) {
      msgs = await store.listMessagesForChannel(channelName, u.workspace_id, u.workspace_id, {
        limit,
        beforeTs,
        afterTs,
      });
    }
    if (markVisit) {
      await sqlite.upsertChannelVisit(u.id, channelName);
    }
    const senderIds = [...new Set((msgs || []).map((m) => Number(m.sender_id)).filter((x) => Number.isFinite(x)))];
    const senders = await sqlite.ensureUsersCached(senderIds, store);
    const senderById = new Map(senders.map((s) => [Number(s.id), s]));
    const out = mapMessagesWithSenders(msgs, senderById);
    res.setHeader("Cache-Control", "private, max-age=1");
    return res.json(out);
  }

  if (receiverId != null) {
    const rid = Number(receiverId);
    let msgs = await sqlite.listDmMessages(u.id, rid, u.workspace_id, { limit, beforeTs, afterTs });
    if (!msgs || msgs.length === 0) {
      msgs = await store.listDmMessages(u.id, rid, { limit, beforeTs, afterTs });
    }
    if (markRead) {
      await sqlite.markDmReadForReceiver(u.id, rid);
    }
    const senderIds = [...new Set((msgs || []).map((m) => Number(m.sender_id)).filter((x) => Number.isFinite(x)))];
    const senders = await sqlite.ensureUsersCached(senderIds, store);
    const senderById = new Map(senders.map((s) => [Number(s.id), s]));
    const out = mapMessagesWithSenders(msgs, senderById);
    res.setHeader("Cache-Control", "private, max-age=1");
    return res.json(out);
  }

  return res.json([]);
});

router.post("/send_message", async (req, res) => {
  const result = await dispatchOutboundMessage(req.user, req.body || {});
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json({ success: true, msg_id: result.msg_id });
});

export default router;
