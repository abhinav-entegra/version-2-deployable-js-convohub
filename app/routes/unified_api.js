import express from "express";
import { requireAuth } from "../dependencies.js";
import { SOCKET_TOKEN_EXPIRE_MINUTES } from "../config.js";
import { createAccessTokenFromUser } from "../utils/security.js";
import {
  getChannelPostBlockReason,
  isChannelManager,
  canManageTargetUser,
  canManagePublicGroupPostPolicy,
  isPublicEcosystemWorkspace,
  canUserDmTarget,
} from "../policy/chat_policy.js";
import * as store from "../services/org_store.js";
import * as sqlite from "../services/sqlite_store.js";
import * as ctx from "../services/context_helpers.js";
import * as xfer from "../services/transfer_service.js";
import { getOnlineSocketUserIds } from "../socketio_server.js";
import { buildDashboardBoot } from "../services/dashboard_boot.js";
import { dispatchOutboundMessage, emitRoster as emitRosterBus } from "../services/message_dispatch.js";
import { setAccessTokenCookie } from "../utils/auth_cookies.js";
import { broadcastWorkspaceRoster } from "../socketio_server.js";
import * as storage from "../services/storage_service.js";

const router = express.Router();
router.use(requireAuth);
const privateGroupMembershipSyncMsByTeam = new Map();
const PRIVATE_GROUP_SYNC_TTL_MS = 5 * 60 * 1000;

function emitRoster(workspaceId) {
  emitRosterBus(workspaceId);
  broadcastWorkspaceRoster(workspaceId);
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

router.get("/socket_token", (req, res) => {
  const token = createAccessTokenFromUser(req.user, SOCKET_TOKEN_EXPIRE_MINUTES);
  res.json({ token });
});

router.get("/get_online_users", (_req, res) => {
  res.json(getOnlineSocketUserIds());
});

router.get("/me", async (req, res) => {
  const boot = await buildDashboardBoot(req.user);
  res.json(boot);
});

router.post("/send_message", async (req, res) => {
  const result = await dispatchOutboundMessage(req.user, req.body || {});
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json({ success: true, msg_id: result.msg_id });
});

router.get("/get_messages", async (req, res) => {
  const u = req.user;
  const receiverId = req.query.receiver_id;
  const channelName = req.query.channel_name;
  const markRead = String(req.query.mark_read || "1") !== "0";
  const markVisit = String(req.query.mark_visit || "1") !== "0";
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const beforeTs = req.query.before ? String(req.query.before) : null;
  const afterTs = req.query.after ? String(req.query.after) : null;

  function mapMessagesWithSenders(msgs, senderById) {
    return msgs.map((m) => {
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
    // Fallback to Supabase if local SQLite is empty (for backward-compatibility with previously sent messages)
    if (!msgs || msgs.length === 0) {
      msgs = await store.listMessagesForChannel(channelName, u.workspace_id, u.workspace_id, {
        limit, beforeTs, afterTs
      });
    }
    if (markVisit) {
      await sqlite.upsertChannelVisit(u.id, channelName);
    }
    const senderIds = [...new Set((msgs || []).map((m) => Number(m.sender_id)).filter((x) => Number.isFinite(x)))];
    const senders = await sqlite.ensureUsersCached(senderIds, store);
    const senderById = new Map(senders.map((s) => [Number(s.id), s]));
    const out = mapMessagesWithSenders(msgs, senderById);
    return res.json(out);
  }

  if (receiverId != null) {
    const rid = Number(receiverId);
    let msgs = await sqlite.listDmMessages(u.id, rid, u.workspace_id, { limit, beforeTs, afterTs });
    // Fallback if SQLite empty
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
    return res.json(out);
  }

  return res.json([]);
});

router.get("/get_message_by_id", async (req, res) => {
  const u = req.user;
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "id required" });
  const m = await store.getMessageById(id);
  if (!m) return res.status(404).json({ error: "Message not found" });

  if (m.channel_name) {
    const channel = await ctx.getChannelInContext(u, { channelName: m.channel_name });
    if (!channel || !(await ctx.canViewChannelResolved(u, channel))) {
      return res.status(403).json({ error: "Forbidden" });
    }
  } else {
    const me = Number(u.id);
    const s = Number(m.sender_id);
    const r = Number(m.receiver_id);
    if (me !== s && me !== r) return res.status(403).json({ error: "Forbidden" });
  }

  const sender = (await store.listUsersByIds([m.sender_id]))[0];
  return res.json({
    id: m.id,
    sender_email: sender?.email || "Unknown",
    sender_name: sender?.name || sender?.email?.split("@")[0] || "Unknown",
    sender_id: m.sender_id,
    sender_pic: sender?.profile_pic_url || null,
    content: m.content,
    type: m.msg_type,
    file_path: m.file_path,
    client_msg_id: m.client_msg_id || null,
    raw_timestamp: m.timestamp,
    timestamp: fmtTime(m.timestamp),
    is_me: Number(m.sender_id) === Number(u.id),
    is_read: m.is_read,
    channel_name: m.channel_name || null,
    receiver_id: m.receiver_id || null,
    workspace_id: m.workspace_id || null,
  });
});

router.get("/get_unread_counts", async (req, res) => {
  const counts = await sqlite.countUnreadDmBySender(req.user.id);
  return res.json(counts);
});

router.get("/get_channel_unread", async (req, res) => {
  const u = req.user;
  const base = await ctx.getChannelBaseRows(u);
  const channels = base; // Also include private groups for Home notifications
  const visible = [];
  for (const ch of channels) {
    if (await ctx.canViewChannelResolved(u, ch)) visible.push(ch);
  }
  const names = visible.map((c) => c.name);
  const counts = await sqlite.countChannelUnread(u.id, names, u.workspace_id);
  return res.json(counts);
});

router.get("/get_activity", async (req, res) => {
  const u = req.user;
  const notifs = await store.listNotifications(u.id, 20);
  const messageIds = [...new Set(notifs.map((n) => n.message_id))];
  const messages = messageIds.length ? await Promise.all(messageIds.map((id) => store.getMessageById(id))) : [];
  const byId = Object.fromEntries(messages.filter(Boolean).map((m) => [m.id, m]));
  const sendersNeeded = [...new Set(messages.filter(Boolean).map((m) => m.sender_id))];
  const senders = sendersNeeded.length ? await store.listUsersByIds(sendersNeeded) : [];
  const senderById = Object.fromEntries(senders.map((x) => [x.id, x]));

  const resBody = notifs.map((n) => {
    const msg = byId[n.message_id];
    const mtype = n.type || "";
    const isTransfer = mtype.startsWith("transfer");
    const raw = (msg?.content || "") || "";
    return {
      id: n.id,
      type: n.type,
      is_seen: n.is_seen,
      sender: msg ? senderById[msg.sender_id]?.email || "Unknown" : "Unknown",
      sender_id: msg?.sender_id ?? null,
      channel_name: msg?.channel_name ?? null,
      content: isTransfer ? raw : raw.slice(0, 50) + (raw.length > 50 ? "…" : ""),
      full_content: isTransfer ? raw : null,
      time: msg ? new Date(n.timestamp).toISOString().replace("T", " ").slice(0, 22) : "",
    };
  });
  res.json(resBody);
});

router.post("/mark_activity_read", async (req, res) => {
  const ids = req.body?.notification_ids || [];
  const intIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  await store.markNotificationsSeen(intIds);
  res.json({ success: true });
});

router.get("/get_channels", async (req, res) => {
  const u = req.user;
  const base = await ctx.getChannelBaseRows(u);
  const ws = await store.getWorkspace(u.workspace_id);
  const flags = ctx.workspaceFlags(u, ws);
  const out = [];
  for (const c of base) {
    if (c.is_private_group) continue;
    if (!(await ctx.canViewChannelResolved(u, c))) continue;
    const canPost = await ctx.canPostResolved(u, c);
    out.push({
      id: c.id,
      name: c.name,
      display_name: c.display_name || c.name,
      icon_url:
        c.icon_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=f4f4f5&color=18181b`,
      visibility: c.visibility,
      post_permission_mode: c.post_permission_mode || "all_visible",
      can_post: canPost,
      workspace_is_public_ecosystem: flags.isPublic,
      can_manage_public_post_policy: flags.canManagePublic,
    });
  }
  res.json(out);
});

router.get("/get_groups", async (req, res) => {
  const u = req.user;
  if (Number(u.workspace_id) !== 1) return res.json([]);

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);
  
  // Honor team_name from query if provided (e.g. for __EXTERNAL__), else fallback to user's team
  const tn = (req.query.team_name || u.team_name || "").trim();

  const out = (await store.listPrivateGroupsFast(u.workspace_id, tn, u.id, isAdmin || isLead))
    .map((g) => ({
      id: g.id,
      name: g.name,
      display_name: g.display_name || g.name,
      icon_url:
        g.icon_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(g.name)}&background=f4f4f5&color=18181b`,
      post_permission_mode: g.post_permission_mode || "custom",
      can_post: true,
    }));
  res.json(out);
});

router.post("/update_group", async (req, res) => {
  const u = req.user;
  const { group_id, display_name, icon_url } = req.body || {};
  if (!group_id) return res.status(400).json({ error: "group_id required" });

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (!isAdmin && !isLead) {
    return res.status(403).json({ error: "Only team leads or admins can update groups" });
  }

  const patch = {};
  if (display_name != null) patch.display_name = display_name;
  if (icon_url != null) patch.icon_url = icon_url;

  await store.updateChannel(group_id, patch);
  res.json({ success: true });
});

router.get("/get_group_visibility", async (req, res) => {
  const u = req.user;
  const groupId = Number(req.query.group_id);
  if (!groupId) return res.status(400).json({ error: "group_id required" });

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (!isAdmin && !isLead) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const memberIds = await store.listExplicitMemberIds(groupId);
  res.json([...memberIds]);
});

router.post("/update_group_visibility", async (req, res) => {
  const u = req.user;
  const { group_id, user_ids } = req.body || {};
  if (!group_id || !Array.isArray(user_ids)) {
    return res.status(400).json({ error: "group_id and user_ids array required" });
  }

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (!isAdmin && !isLead) {
    return res.status(403).json({ error: "Only team leads or admins can update visibility" });
  }

  await store.replaceExplicitMembers(group_id, user_ids.map(Number));
  res.json({ success: true });
});

router.get("/get_user_dm_permissions", async (req, res) => {
  const u = req.user;
  const targetUserId = Number(req.query.user_id);
  if (!targetUserId) return res.status(400).json({ error: "user_id required" });

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (!isAdmin && !isLead) return res.status(403).json({ error: "Unauthorized" });

  const raw = await store.listDmPermissions(targetUserId);
  const allowedIds = raw.map(r => Number(r.target_id));
  res.json({ targetUserId, allowedIds });
});

router.post("/update_user_dm_permissions", async (req, res) => {
  const u = req.user;
  const { user_id, allowlist_only, allowed_ids } = req.body || {};
  if (!user_id || !Array.isArray(allowed_ids)) {
    return res.status(400).json({ error: "user_id and allowed_ids required" });
  }

  const role = (u.role || "").toLowerCase();
  const isLead = (u.team_role || "").toLowerCase() === "teamlead";
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (!isAdmin && !isLead) return res.status(403).json({ error: "Unauthorized" });

  await store.updateUserDmAllowlist(user_id, !!allowlist_only);

  const existing = await store.listDmPermissions(user_id);
  for (const row of existing) {
    if (!allowed_ids.includes(Number(row.target_id))) {
       await store.deleteDmPermission(user_id, row.target_id);
    }
  }
  for (const aid of allowed_ids) {
    await store.upsertDmPermission(user_id, aid);
  }
  
  res.json({ success: true });
});


router.post("/create_channel", async (req, res) => {
  const u = req.user;
  if (!isChannelManager(u)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const name = req.body?.name;
  const iconUrl = req.body?.icon_url;
  if (!name) return res.status(400).json({ error: "No name" });
  const slug = String(name)
    .toLowerCase()
    .replace(/\s+/g, "-");
  const ch = await store.insertChannel({
    name: slug,
    team_name: u.team_name || "default",
    display_name: name,
    workspace_id: u.workspace_id,
    icon_url: iconUrl,
    post_permission_mode: "all_visible",
    is_private_group: false,
    visibility: "all",
  });
  await store.addGroupMember(ch.id, u.id);
  res.json({ success: true, group_id: ch.id });
});

router.post("/create_private_group", async (req, res) => {
  const u = req.user;
  if (Number(u.workspace_id) !== 1) {
    return res.status(403).json({ error: "Private groups can only be created in Team Ecosystem" });
  }
  if ((u.team_role || "").toLowerCase() !== "teamlead") {
    return res.status(403).json({ error: "Only Team Leads can create dedicated private groups." });
  }
  const name = req.body?.name;
  const iconUrl = req.body?.icon_url;
  if (!name) return res.status(400).json({ error: "No name" });
  const slug = String(name)
    .toLowerCase()
    .replace(/\s+/g, "-");
  const g = await store.insertChannel({
    name: slug,
    team_name: u.team_name || "default",
    display_name: name,
    workspace_id: u.workspace_id,
    icon_url: iconUrl,
    visibility: "all",
    post_permission_mode: "custom",
    is_private_group: true,
  });
  // For team-wide group conversations: include all users from this team in the group membership.
  // This allows every team member to view + post in the private group chat.
  const tn = (u.team_name || "").trim();
  if (tn) {
    const teamUsers = await store.listUsersByTeamName(tn);
    const userIds = teamUsers.map((x) => x.id);
    await store.replaceExplicitMembers(g.id, userIds);
  } else {
    await store.addGroupMember(g.id, u.id);
  }
  res.json({ success: true, group_id: g.id });
});

router.get("/get_team_members", async (req, res) => {
  const u = req.user;
  const ws = await store.getWorkspace(u.workspace_id);
  const members = await ctx.getContextMemberQueryUsers(u, ws);
  res.json(
    members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name || m.email.split("@")[0],
      profile_pic_url:
        m.profile_pic_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=ffffff&color=111827`,
      role: m.role,
      team_role: m.team_role,
      designation: m.designation || "SE",
      is_me: Number(m.id) === Number(u.id),
      is_restricted: m.is_restricted,
      dm_allowlist_only: !!m.dm_allowlist_only,
      workspace_id: m.workspace_id,
    }))
  );
});

router.get("/can_chat", async (req, res) => {
  const uId = req.user.id;
  const targetId = Number(req.query.target_id);
  if (!targetId) return res.status(400).json({ error: "target_id required" });
  
  // Fetch latest sender and target from DB to be reactive to permission changes
  const [sender, target] = await Promise.all([
    store.listUsersByIds([uId]).then(rows => rows[0]),
    store.listUsersByIds([targetId]).then(rows => rows[0])
  ]);
  
  if (!sender || !target) return res.json({ can_chat: false });

  const hasGrant = await store.hasDmGrant(sender.id, target.id);
  const sws = await store.getWorkspace(sender.workspace_id);
  
  const can = canUserDmTarget(sender, target, hasGrant, sws);
  res.json({ can_chat: can });
});

router.get("/get_workspace_members", async (req, res) => {
  const u = req.user;
  const ws = await store.getWorkspace(u.workspace_id);
  const members = await ctx.getClientWorkspaceRoster(u, ws);
  res.json(
    members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name || m.email.split("@")[0],
      profile_pic_url:
        m.profile_pic_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=ffffff&color=111827`,
      role: m.role,
      team_role: m.team_role,
      designation: m.designation || "SE",
      is_me: Number(m.id) === Number(u.id),
      is_restricted: m.is_restricted,
      dm_allowlist_only: !!m.dm_allowlist_only,
      workspace_id: m.workspace_id,
    }))
  );
});

router.get("/get_dm_permissions", async (req, res) => {
  const uid = req.query.user_id;
  if (!uid) return res.json([]);
  const subject = (await store.listUsersByIds([Number(uid)]))[0];
  if (!subject || !canManageTargetUser(req.user, subject)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const rows = await store.listDmPermissions(Number(uid));
  res.json(rows.map((r) => r.target_id));
});

router.post("/update_dm_permission", async (req, res) => {
  const actor = req.user;
  if ((actor.team_role || "").toLowerCase() !== "teamlead" && !["admin", "superadmin"].includes((actor.role || "").toLowerCase())) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { user_id: memberId, target_id: targetId, allowed } = req.body || {};
  const mid = Number(memberId);
  const tid = Number(targetId);
  if (!Number.isFinite(mid) || !Number.isFinite(tid)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  const sourceUser = (await store.listUsersByIds([mid]))[0];
  const targetUser = (await store.listUsersByIds([tid]))[0];
  if (!sourceUser || !targetUser) {
    return res.status(400).json({ error: "Not found" });
  }
  if (!canManageTargetUser(actor, sourceUser) || !canManageTargetUser(actor, targetUser)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (allowed) await store.upsertDmPermission(mid, tid);
  else await store.deleteDmPermission(mid, tid);
  emitRoster(actor.workspace_id);
  res.json({ success: true });
});

router.post("/toggle_user_restriction", async (req, res) => {
  const actor = req.user;
  if ((actor.team_role || "").toLowerCase() !== "teamlead" && !["admin", "superadmin"].includes((actor.role || "").toLowerCase())) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const targetId = Number(req.body?.user_id);
  if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Invalid user id" });
  const target = (await store.listUsersByIds([targetId]))[0];
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!canManageTargetUser(actor, target)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  await store.updateUser(targetId, { is_restricted: !!req.body?.restricted });
  emitRoster(actor.workspace_id);
  res.json({ success: true });
});

router.post("/set_dm_allowlist_only", async (req, res) => {
  const actor = req.user;
  const targetId = Number(req.body?.user_id);
  if (!Number.isFinite(targetId)) return res.status(400).json({ error: "user_id required" });
  const target = (await store.listUsersByIds([targetId]))[0];
  if (!target) return res.status(404).json({ error: "Not found" });
  if (!canManageTargetUser(actor, target)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const enabled = !!req.body?.enabled;
  await store.updateUser(targetId, { dm_allowlist_only: enabled });
  emitRoster(actor.workspace_id);
  res.json({ success: true, dm_allowlist_only: enabled });
});

router.post("/update_user_profile", async (req, res) => {
  const u = req.user;
  const { name, profile_pic_url: pic } = req.body || {};
  const patch = {};
  if (name != null) patch.name = name;
  if (pic != null) {
      if (pic.startsWith("data:image/")) {
          // If it's a raw base64 from the browser, save it as a file.
          patch.profile_pic_url = await storage.saveProfilePicture(pic, u.id);
      } else {
          patch.profile_pic_url = pic;
      }
  }
  await store.updateUser(u.id, patch);
  res.json({ success: true, profile_pic_url: patch.profile_pic_url });
});

router.get("/get_ecosystems", async (req, res) => {
  const u = req.user;
  const accessRows = await store.listWorkspaceAccessRows(u.id);
  const accessIds = accessRows.map((r) => r.workspace_id);
  const publicWs = await store.listPublicWorkspaces();
  const created = await store.listWorkspacesCreatedBy(u.id);
  const publicIds = publicWs.map((w) => w.id);
  const createdIds = created.map((w) => w.id);
  let allIds = [...new Set([...accessIds, ...publicIds, ...createdIds])];
  allIds = allIds.filter((id) => id !== 1);
  const list = await store.listWorkspacesByIds(allIds);
  res.json(
    list.map((w) => ({
      id: w.id,
      name: w.name,
      logo_url:
        w.logo_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(w.name)}&background=e4e4e7&color=18181b`,
      is_private: w.is_private !== false,
      is_creator: Number(w.creator_id) === Number(u.id),
    }))
  );
});

router.post("/switch_workspace", async (req, res) => {
  const u = req.user;
  const wsId = Number(req.body?.workspace_id);
  const ws = await store.getWorkspace(wsId);
  if (!ws) return res.status(403).json({ error: "Access denied" });
  const hasAccess = (await store.listWorkspaceAccessRows(u.id)).some((r) => r.workspace_id === wsId);
  const r = (u.role || "").toLowerCase();
  if (!ws.is_private || hasAccess || r === "superadmin") {
    await store.updateUser(u.id, { workspace_id: wsId });
    const fresh = await store.listUsersByIds([u.id]).then((rows) => rows[0]);
    let access_token;
    if (fresh) {
      access_token = createAccessTokenFromUser(fresh);
      setAccessTokenCookie(res, access_token);
    }
    return res.json({ success: true, access_token });
  }
  return res.status(403).json({ error: "Access denied" });
});

/** Same semantics as Flask `/api/switch_ecosystem` (private ecosystems need access). */
router.post("/switch_ecosystem", async (req, res) => {
  const u = req.user;
  const wsId = Number(req.body?.workspace_id);
  const ws = await store.getWorkspace(wsId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  const hasAccess = (await store.listWorkspaceAccessRows(u.id)).some((r) => r.workspace_id === wsId);
  const r = (u.role || "").toLowerCase();
  if (ws.is_private && !hasAccess && r !== "admin" && r !== "superadmin") {
    return res.status(403).json({ error: "Access denied" });
  }
  await store.updateUser(u.id, { workspace_id: wsId });
  const fresh = await store.listUsersByIds([u.id]).then((rows) => rows[0]);
  let access_token;
  if (fresh) {
    access_token = createAccessTokenFromUser(fresh);
    setAccessTokenCookie(res, access_token);
  }
  return res.json({ success: true, access_token });
});

router.post("/create_ecosystem", async (req, res) => {
  const u = req.user;
  if ((u.team_role || "").toLowerCase() !== "teamlead" && !["admin", "superadmin"].includes((u.role || "").toLowerCase())) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { name, logo_url: logoUrl, sync_members: syncMembers, is_private: requestedPrivate } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name is required" });

  let teamCanPublish = false;
  if (u.team_name) {
    const t = await store.getTeamByName(u.team_name);
    teamCanPublish = !!(t && t.can_deploy_publicly);
  }
  const isAdmin = ["admin", "superadmin"].includes((u.role || "").toLowerCase());
  let isPrivate = requestedPrivate !== false;
  if (!isAdmin && !teamCanPublish) isPrivate = true;

  const newWs = await store.insertWorkspace({
    name,
    logo_url: logoUrl,
    creator_id: u.id,
    is_private: isPrivate,
    allow_group_creation: true,
    theme_color: "#525252",
  });
  const team = await store.insertTeam({ name: `${name} Core`, workspace_id: newWs.id });
  await store.insertChannel({
    name: "general",
    display_name: "General",
    team_name: team.name,
    workspace_id: newWs.id,
    visibility: "all",
    post_permission_mode: "all_visible",
    is_private_group: false,
  });
  await store.grantWorkspaceAccess(u.id, newWs.id);

  if (syncMembers && u.team_name) {
    const members = await store.listUsersByTeamName(u.team_name);
    for (const m of members) {
      await store.grantWorkspaceAccess(m.id, newWs.id);
    }
  }

  emitRoster(newWs.id);
  res.json({ success: true, workspace_id: newWs.id });
});

router.get("/get_public_ecosystems", async (req, res) => {
  const u = req.user;
  const accessIds = (await store.listWorkspaceAccessRows(u.id)).map((r) => r.workspace_id);
  const exclude = new Set([...accessIds, u.workspace_id || 0, 1]);
  const publicWs = (await store.listPublicWorkspaces()).filter((w) => !exclude.has(w.id));
  res.json(
    publicWs.map((w) => ({
      id: w.id,
      name: w.name,
      logo_url:
        w.logo_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(w.name)}&background=e4e4e7&color=18181b`,
    }))
  );
});

router.post("/join_ecosystem", async (req, res) => {
  const u = req.user;
  const wsId = Number(req.body?.workspace_id);
  const ws = await store.getWorkspace(wsId);
  if (!ws || ws.is_private) {
    return res.status(404).json({ error: "Ecosystem not found or private" });
  }
  await store.grantWorkspaceAccess(u.id, wsId);
  emitRoster(wsId);
  res.json({ success: true });
});

router.get("/transfer_teams_list", async (req, res) => {
  const u = req.user;
  const wsId = u.workspace_id;
  if (!wsId) return res.json([]);
  const teams = await store.listTeamsByWorkspace(wsId);
  const mine = (u.team_name || "").trim();
  const r = (u.role || "").toLowerCase();
  const isAdmin = r === "admin" || r === "superadmin";
  const out = teams
    .filter((t) => t.name && (isAdmin || t.name !== mine))
    .map((t) => ({ name: t.name }));
  res.json(out);
});

router.post("/transfer_member_request", async (req, res) => {
  const u = req.user;
  const userId = Number(req.body?.user_id);
  const toTeamName = String(req.body?.to_team_name || "").trim();
  if (!Number.isFinite(userId) || !toTeamName) {
    return res.status(400).json({ error: "user_id and to_team_name required" });
  }
  const member = (await store.listUsersByIds([userId]))[0];
  const { ok, err } = xfer.canInitiateTeamTransfer(u, member);
  if (!ok) return res.status(403).json({ error: err });

  const destTeam = (await store.listTeamsByWorkspace(member.workspace_id)).find((t) => t.name === toTeamName);
  if (!destTeam) {
    return res.status(400).json({ error: "Destination team not found in this ecosystem." });
  }
  if ((member.team_name || "") === toTeamName) {
    return res.status(400).json({ error: "Member is already on that team." });
  }
  const leadIds = await xfer.destinationTeamLeadIds(toTeamName, member.workspace_id);
  if (!leadIds.length) {
    return res.status(400).json({ error: "Destination team has no team lead to approve this transfer." });
  }
  const pending = await store.findPendingTransferByMember(member.id);
  if (pending) {
    return res.status(400).json({ error: "This member already has a pending transfer request." });
  }

  const reqRow = await store.insertTransferRequest({
    member_user_id: member.id,
    from_team_name: member.team_name || "",
    to_team_name: toTeamName,
    workspace_id: member.workspace_id,
    initiator_id: u.id,
    status: "pending",
  });

  const wsLabel = await xfer.workspaceName(member.workspace_id);
  const mname = member.name || member.email.split("@")[0];
  const when = new Date(reqRow.created_at).toISOString().replace("T", " ").slice(0, 22);
  const body = `[Transfer — action needed] ${mname} (${member.email}) is requested to move from team "${reqRow.from_team_name}" → "${toTeamName}" in ecosystem "${wsLabel}". Requested by ${u.email} at ${when}. Request ID: ${reqRow.id}. Approve or decline in People panel (incoming transfers).`;
  await xfer.notifyTransferActivity(leadIds, u.id, body, "transfer_pending");
  res.json({ success: true, request_id: reqRow.id });
});

router.get("/transfer_requests_pending", async (req, res) => {
  const u = req.user;
  const wsId = u.workspace_id;
  const r = (u.role || "").toLowerCase();
  let incomingRows = [];
  if (r === "admin" || r === "superadmin") {
    incomingRows = await store.listPendingTransfersInWorkspace(wsId);
  } else if ((u.team_role || "").toLowerCase() === "teamlead") {
    incomingRows = await store.listTransferRequestsPendingForTeam(u.team_name, wsId);
  }

  const incoming = [];
  for (const row of incomingRows) {
    const mem = (await store.listUsersByIds([row.member_user_id]))[0];
    const inc = (await store.listUsersByIds([row.initiator_id]))[0];
    incoming.push({
      id: row.id,
      member_id: row.member_user_id,
      member_email: mem?.email || "",
      member_name: mem?.name || mem?.email?.split("@")[0] || "",
      from_team: row.from_team_name,
      to_team: row.to_team_name,
      initiator_email: inc?.email || "",
      created_at: new Date(row.created_at).toISOString().replace("T", " ").slice(0, 22) + " UTC",
    });
  }

  const outgoingRows = await store.listOutgoingTransfers(u.id, wsId);
  const outgoing = [];
  for (const row of outgoingRows) {
    const mem = (await store.listUsersByIds([row.member_user_id]))[0];
    outgoing.push({
      id: row.id,
      member_id: row.member_user_id,
      member_email: mem?.email || "",
      member_name: mem?.name || mem?.email?.split("@")[0] || "",
      from_team: row.from_team_name,
      to_team: row.to_team_name,
      created_at: new Date(row.created_at).toISOString().replace("T", " ").slice(0, 22) + " UTC",
    });
  }
  res.json({ incoming, outgoing });
});

router.post("/transfer_member_respond", async (req, res) => {
  const u = req.user;
  const reqId = Number(req.body?.request_id);
  const accept = !!req.body?.accept;
  if (!Number.isFinite(reqId)) return res.status(400).json({ error: "request_id required" });

  const reqRow = await store.getTransferRequestById(reqId);
  if (!reqRow || reqRow.status !== "pending") {
    return res.status(404).json({ error: "Request not found or already resolved." });
  }
  if (!xfer.canRespondTeamTransfer(u, reqRow)) {
    return res.status(403).json({ error: "Only the destination team lead (or workspace admin) can respond." });
  }
  const member = (await store.listUsersByIds([reqRow.member_user_id]))[0];
  if (!member) return res.status(404).json({ error: "Member no longer exists." });

  if (accept) {
    if ((member.team_name || "") !== reqRow.from_team_name || Number(member.workspace_id) !== Number(reqRow.workspace_id)) {
      return res.status(409).json({ error: "Member data changed; cancel this request and start over." });
    }
    const destTeam = (await store.listTeamsByWorkspace(reqRow.workspace_id)).find(
      (t) => t.name === reqRow.to_team_name
    );
    if (!destTeam) return res.status(400).json({ error: "Destination team missing." });

    const backupJson = await xfer.collectTransferChatBackup(
      member.id,
      reqRow.from_team_name,
      reqRow.workspace_id
    );
    await store.insertTransferBackup({
      user_id: member.id,
      transfer_request_id: reqRow.id,
      from_team_name: reqRow.from_team_name,
      to_team_name: reqRow.to_team_name,
      workspace_id: reqRow.workspace_id,
      payload_json: backupJson,
    });
    await xfer.stripOldTeamPrivateGroups(member.id, reqRow.from_team_name, reqRow.workspace_id);

    const patch = { team_name: reqRow.to_team_name };
    if (destTeam.workspace_id && Number(destTeam.workspace_id) !== Number(member.workspace_id)) {
      patch.workspace_id = destTeam.workspace_id;
      await store.grantWorkspaceAccess(member.id, destTeam.workspace_id);
    }
    await store.updateUser(member.id, patch);

    await store.updateTransferRequest(reqRow.id, {
      status: "accepted",
      resolved_at: new Date().toISOString(),
      resolver_id: u.id,
    });

    emitRoster(reqRow.workspace_id);
    const wsLabel = await xfer.workspaceName(reqRow.workspace_id);
    const mname = member.name || member.email.split("@")[0];
    const when = new Date().toISOString().replace("T", " ").slice(0, 22);
    const body = `[Transfer — completed] ${mname} (${member.email}) moved from team "${reqRow.from_team_name}" to "${reqRow.to_team_name}" in ecosystem "${wsLabel}" at ${when}. Approved by ${u.email}.`;
    const notifyIds = new Set([
      ...(await xfer.teamMemberUserIds(reqRow.to_team_name, member.workspace_id)),
      ...(await xfer.teamMemberUserIds(reqRow.from_team_name, member.workspace_id)),
    ]);
    notifyIds.add(member.id);
    notifyIds.add(reqRow.initiator_id);
    await xfer.notifyTransferActivity([...notifyIds], u.id, body, "transfer_complete");
    return res.json({ success: true, status: "accepted" });
  }

  await store.updateTransferRequest(reqRow.id, {
    status: "declined",
    resolved_at: new Date().toISOString(),
    resolver_id: u.id,
  });
  const wsLabel = await xfer.workspaceName(reqRow.workspace_id);
  const mname = member.name || member.email.split("@")[0];
  const when = new Date().toISOString().replace("T", " ").slice(0, 22);
  const body = `[Transfer — declined] Request for ${mname} (${member.email}) from "${reqRow.from_team_name}" to "${reqRow.to_team_name}" in "${wsLabel}" was declined by ${u.email} at ${when}.`;
  await xfer.notifyTransferActivity([reqRow.initiator_id, member.id], u.id, body, "transfer_declined");
  return res.json({ success: true, status: "declined" });
});

router.post("/transfer_member_cancel", async (req, res) => {
  const u = req.user;
  const reqId = Number(req.body?.request_id);
  if (!Number.isFinite(reqId)) return res.status(400).json({ error: "request_id required" });
  const reqRow = await store.getTransferRequestById(reqId);
  if (!reqRow || reqRow.status !== "pending") {
    return res.status(404).json({ error: "Not found" });
  }
  const r = (u.role || "").toLowerCase();
  if (Number(reqRow.initiator_id) !== Number(u.id) && r !== "admin" && r !== "superadmin") {
    return res.status(403).json({ error: "Only the initiator or admin can cancel." });
  }
  await store.updateTransferRequest(reqId, {
    status: "cancelled",
    resolved_at: new Date().toISOString(),
    resolver_id: u.id,
  });
  res.json({ success: true });
});

router.get("/my_transfer_chat_backups", async (req, res) => {
  const rows = await store.listTransferBackups(req.user.id);
  res.json(
    rows.map((b) => ({
      id: b.id,
      from_team: b.from_team_name,
      to_team: b.to_team_name,
      created_at: b.created_at,
    }))
  );
});

router.get("/my_transfer_chat_backup/:backupId", async (req, res) => {
  const b = await store.getTransferBackup(req.user.id, Number(req.params.backupId));
  if (!b) return res.status(404).json({ error: "Not found" });
  let parsed = [];
  try {
    parsed = JSON.parse(b.payload_json || "[]");
  } catch {
    parsed = [];
  }
  res.json({ backup: b, items: parsed });
});

router.get("/get_group_details/:groupId", async (req, res) => {
  const u = req.user;
  const groupId = Number(req.params.groupId);
  const g = await ctx.getChannelInContext(u, { channelId: groupId });
  if (!g || !(await ctx.canViewChannelResolved(u, g))) {
    return res.status(404).json({ error: "Group not found" });
  }
  const explicit = await store.listExplicitMemberIds(g.id);
  const users = await store.listUsersByIds([...explicit]);
  const memberList = users.map((m) => ({
    id: m.id,
    name: m.name || m.email.split("@")[0],
    email: m.email,
    profile_pic_url:
      m.profile_pic_url ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=e4e4e7&color=18181b`,
    team_role: m.team_role,
    role: m.role,
    designation: m.designation,
    is_me: Number(m.id) === Number(u.id),
    source: "member",
    source_label: "Added directly",
    removable: !["admin", "superadmin"].includes((m.role || "").toLowerCase()),
  }));
  res.json({
    id: g.id,
    name: g.name,
    display_name: g.display_name || g.name,
    icon_url:
      g.icon_url ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(g.name)}&background=e4e4e7&color=18181b`,
    visibility: g.visibility,
    members: memberList,
    can_post: await ctx.canPostResolved(u, g),
    can_manage: isChannelManager(u),
    post_permission_mode: g.post_permission_mode || "all_visible",
    bulk_roles: [...(await store.listBulkRoles(g.id))],
    is_private_group: !!g.is_private_group,
  });
});

router.post("/add_group_member", async (req, res) => {
  const u = req.user;
  const groupId = Number(req.body?.group_id);
  const userIdRaw = req.body?.user_id;
  if (!Number.isFinite(groupId)) return res.status(400).json({ error: "group_id required" });
  const g = await ctx.getChannelInContext(u, { channelId: groupId });
  if (!g || !(await ctx.canViewChannelResolved(u, g))) {
    return res.status(403).json({ error: "Unauthorized or group not found" });
  }
  if (g.is_private_group && !isChannelManager(u)) {
    return res.status(403).json({ error: "Only Team Leads or Admins can add members to private groups." });
  }
  const ws = await store.getWorkspace(g.workspace_id);
  const pool = g.is_private_group
    ? await ctx.getEcosystemMembers(ws)
    : await ctx.getClientWorkspaceRoster(u, ws);
  const eligible = new Set(pool.map((x) => x.id));
  const uids = Array.isArray(userIdRaw) ? userIdRaw : [userIdRaw];
  const addedNames = [];
  const { supabase } = await import("../database.js");
  const { data: selfGm } = await supabase
    .from("group_members")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", u.id)
    .maybeSingle();
  const roleLower = (u.role || "").toLowerCase();
  if (!selfGm && roleLower !== "admin" && roleLower !== "superadmin") {
    await store.addGroupMember(groupId, u.id);
  }
  for (const raw of uids) {
    const uid = Number(raw);
    if (!Number.isFinite(uid) || !eligible.has(uid)) continue;
    const { data: existsRow } = await supabase
      .from("group_members")
      .select("id")
      .eq("group_id", groupId)
      .eq("user_id", uid)
      .maybeSingle();
    if (existsRow) continue;
    await store.addGroupMember(groupId, uid);
    const added = (await store.listUsersByIds([uid]))[0];
    if (added) addedNames.push(added.name || added.email.split("@")[0]);
    await store.insertMessage({
      sender_id: u.id,
      channel_name: g.name,
      content: `${added?.name || added?.email || uid} has been added to the group`,
      msg_type: "system",
      timestamp: new Date().toISOString(),
      workspace_id: g.workspace_id,
    });
  }
  emitRoster(u.workspace_id);
  res.json({ success: true, added: addedNames });
});

router.post("/remove_group_member", async (req, res) => {
  const u = req.user;
  const groupId = Number(req.body?.group_id);
  const targetId = Number(req.body?.user_id);
  if (!Number.isFinite(groupId) || !Number.isFinite(targetId)) {
    return res.status(400).json({ error: "group_id and user_id required" });
  }
  if (targetId === u.id) {
    return res.status(400).json({ error: "Use leave_group to remove yourself" });
  }
  const g = await ctx.getChannelInContext(u, { channelId: groupId });
  if (!g || !(await ctx.canViewChannelResolved(u, g))) {
    return res.status(403).json({ error: "Unauthorized or group not found" });
  }
  if (g.is_private_group && !isChannelManager(u)) {
    return res.status(403).json({ error: "Only Team Leads or Admins can remove members." });
  }
  await store.removeGroupMember(groupId, targetId);
  const removed = (await store.listUsersByIds([targetId]))[0];
  await store.insertMessage({
    sender_id: u.id,
    channel_name: g.name,
    content: `${removed?.name || removed?.email || targetId} was removed from the group`,
    msg_type: "system",
    timestamp: new Date().toISOString(),
    workspace_id: g.workspace_id,
  });
  emitRoster(u.workspace_id);
  res.json({ success: true });
});

router.post("/update_channel_metadata", async (req, res) => {
  const u = req.user;
  const channelName = req.body?.channel_name;
  const ch = await ctx.getChannelInContext(u, { channelName });
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  const ws = await store.getWorkspace(ch.workspace_id);
  const isPublic = isPublicEcosystemWorkspace(ws);
  if (isPublic) {
    if (!canManagePublicGroupPostPolicy(u, ws)) {
      return res.status(403).json({ error: "Unauthorized" });
    }
  } else if (!isChannelManager(u)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const patch = {};
  if (req.body?.display_name) patch.display_name = req.body.display_name;
  if (req.body?.icon_url != null) patch.icon_url = req.body.icon_url;
  await store.updateChannel(ch.id, patch);
  res.json({ success: true });
});

router.post("/update_channel_visibility", async (req, res) => {
  const u = req.user;
  const channelName = req.body?.channel_name;
  const ch = await ctx.getChannelInContext(u, { channelName });
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  const ws = await store.getWorkspace(ch.workspace_id);
  const isPublic = isPublicEcosystemWorkspace(ws);
  if (isPublic) {
    if (!canManagePublicGroupPostPolicy(u, ws)) {
      return res.status(403).json({ error: "Unauthorized" });
    }
  } else if (!isChannelManager(u)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const patch = {};
  if (req.body?.visibility != null) patch.visibility = req.body.visibility;
  if (req.body?.post_permission_mode != null) patch.post_permission_mode = req.body.post_permission_mode;
  if (Object.keys(patch).length) await store.updateChannel(ch.id, patch);
  if (Array.isArray(req.body?.bulk_roles)) {
    await store.replaceBulkRoles(ch.id, req.body.bulk_roles);
  }
  res.json({ success: true });
});

router.post("/leave_group", async (req, res) => {
  const u = req.user;
  const groupId = Number(req.body?.group_id);
  const silent = !!req.body?.silent;
  if (!Number.isFinite(groupId)) return res.status(400).json({ error: "group_id required" });
  const group = await ctx.getChannelInContext(u, { channelId: groupId });
  if (!group) return res.status(404).json({ error: "Group not found" });
  const { supabase } = await import("../database.js");
  const { data: gm } = await supabase
    .from("group_members")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", u.id)
    .maybeSingle();
  if (!gm) return res.status(404).json({ error: "Not a member" });
  if ((u.team_role || "").toLowerCase() === "teamlead") {
    const n = await store.countTeamleadsInGroup(groupId, u.id);
    if (n === 0) {
      return res.status(403).json({ error: "Assign another Team Lead first." });
    }
  }
  await store.removeGroupMember(groupId, u.id);
  if (!silent) {
    await store.insertMessage({
      sender_id: u.id,
      channel_name: group.name,
      content: `${u.name || u.email.split("@")[0]} left the group`,
      msg_type: "system",
      timestamp: new Date().toISOString(),
      workspace_id: group.workspace_id,
    });
  }
  res.json({ success: true });
});

router.post("/disband_group", async (req, res) => {
  const u = req.user;
  if (!isChannelManager(u)) return res.status(403).json({ error: "Unauthorized" });
  const groupId = Number(req.body?.group_id);
  const g = await ctx.getChannelInContext(u, { channelId: groupId });
  if (!g) return res.status(404).json({ error: "Group not found" });
  await store.deleteAllGroupMembers(groupId);
  await supabaseDelChannelRoles(groupId);
  await store.deleteChannel(groupId);
  res.json({ success: true });
});

async function supabaseDelChannelRoles(channelId) {
  const { supabase } = await import("../database.js");
  await supabase.from("channel_role_permissions").delete().eq("channel_id", channelId);
}

router.get("/get_cross_ecosystem_dms", async (req, res) => {
  const u = req.user;
  const { supabase } = await import("../database.js");
  const { data: sent } = await supabase
    .from("messages")
    .select("receiver_id")
    .eq("sender_id", u.id)
    .is("channel_name", null);
  const { data: recv } = await supabase
    .from("messages")
    .select("sender_id")
    .eq("receiver_id", u.id)
    .is("channel_name", null);
  const uniqueIds = new Set();
  for (const r of sent || []) if (r.receiver_id) uniqueIds.add(r.receiver_id);
  for (const r of recv || []) if (r.sender_id) uniqueIds.add(r.sender_id);
  uniqueIds.delete(u.id);
  if (!uniqueIds.size) return res.json([]);

  const { data: waRows } = await supabase
    .from("workspace_access")
    .select("user_id")
    .eq("workspace_id", u.workspace_id);
  const activeInWorkspace = new Set((waRows || []).map((r) => r.user_id));

  const otherIds = [...uniqueIds].filter((id) => !activeInWorkspace.has(id));
  if (!otherIds.length) return res.json([]);

  const members = await store.listUsersByIds(otherIds);
  res.json(
    members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name || m.email.split("@")[0],
      profile_pic_url:
        m.profile_pic_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=ffffff&color=111827`,
      role: m.role,
      team_role: m.team_role,
      designation: m.designation || "SE",
      is_me: false,
      is_external: true,
      is_restricted: m.is_restricted,
    }))
  );
});

const stub = (msg) => (req, res) => res.status(501).json({ error: msg || "Not implemented in this build" });

router.post("/upload_voice", stub("Use Supabase Storage + signed URLs in production"));
router.post("/upload_image", stub());
router.post("/upload_attachment", stub());
router.post("/team_logo", stub());
router.post("/team_logo_upload", stub());
router.get("/get_channel_team_call_targets", async (req, res) => {
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  const channelName = req.query.channel_name || null;
  if (!channelId && !channelName) {
    return res.status(400).json({ error: "channel_id or channel_name required" });
  }
  const ch = await ctx.getChannelInContext(req.user, {
    channelId: channelId || undefined,
    channelName: channelName || undefined,
  });
  if (!ch || !(await ctx.canViewChannelResolved(req.user, ch))) {
    return res.status(404).json({ error: "Group not found" });
  }
  const ws = await store.getWorkspace(ch.workspace_id);
  const roster = await ctx.getClientWorkspaceRoster(req.user, ws);
  const targets = [];
  for (const m of roster) {
    if (Number(m.id) === Number(req.user.id)) continue;
    if (await ctx.canViewChannelResolved(m, ch)) {
      targets.push({ id: m.id, email: m.email });
    }
  }
  res.json({ targets });
});

router.get("/get_dm_allowlist_candidates", async (req, res) => {
  const subjectId = Number(req.query.subject_user_id);
  if (!Number.isFinite(subjectId)) {
    return res.status(400).json({ error: "subject_user_id required" });
  }
  const subject = (await store.listUsersByIds([subjectId]))[0];
  if (!subject || !canManageTargetUser(req.user, subject)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const ws = await store.getWorkspace(subject.workspace_id);
  if (!ws) {
    return res.json({
      subject: {
        id: subject.id,
        email: subject.email,
        dm_allowlist_only: !!subject.dm_allowlist_only,
        is_restricted: subject.is_restricted,
        team_role: subject.team_role,
        role: subject.role,
      },
      candidates: [],
    });
  }
  const tn = (subject.team_name || "").trim();
  let rows;
  if (tn) {
    rows = (await store.listUsersByWorkspaceId(ws.id)).filter((u) => u.team_name === tn);
  } else {
    rows = await store.listUsersByWorkspaceId(ws.id);
  }
  rows.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  const candidates = rows.filter((m) => m.id !== subject.id);
  res.json({
    subject: {
      id: subject.id,
      email: subject.email,
      dm_allowlist_only: !!subject.dm_allowlist_only,
      is_restricted: subject.is_restricted,
      team_role: subject.team_role,
      role: subject.role,
    },
    candidates: candidates.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name || m.email.split("@")[0],
      profile_pic_url:
        m.profile_pic_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=ffffff&color=111827`,
      role: m.role,
      team_role: m.team_role,
      designation: m.designation || "SE",
      is_me: Number(m.id) === Number(req.user.id),
      is_restricted: m.is_restricted,
      dm_allowlist_only: !!m.dm_allowlist_only,
      workspace_id: m.workspace_id,
    })),
  });
});


router.get("/get_group_visibility", async (req, res) => {
  const u = req.user;
  const channelId = Number(req.query.channel_id);
  if (!channelId) return res.status(400).json({ error: "channel_id required" });
  const g = await store.getChannelById(channelId);
  if (!g || !(await ctx.canViewChannelResolved(u, g))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const explicit = await store.listExplicitMemberIds(g.id);
  res.json([...explicit]);
});

router.post("/update_group_visibility", async (req, res) => {
  const u = req.user;
  const { channel_id: channelId, user_ids: userIds } = req.body || {};
  if (!channelId || !Array.isArray(userIds)) return res.status(400).json({ error: "Invalid payload" });
  
  const isLead = (u.team_role || "").toLowerCase() === "teamlead" || ["admin", "superadmin"].includes((u.role || "").toLowerCase());
  if (!isLead) return res.status(403).json({ error: "Only team leads can manage group visibility." });
  
  const g = await store.getChannelById(channelId);
  if (!g) return res.status(404).json({ error: "Group not found" });

  await store.replaceExplicitMembers(g.id, userIds.map(Number));
  res.json({ success: true });
});

router.post("/create_external_group", async (req, res) => {
  const u = req.user;
  const isLead = (u.team_role || "").toLowerCase() === "teamlead" || ["admin", "superadmin"].includes((u.role || "").toLowerCase());
  if (!isLead) return res.status(403).json({ error: "Only team leads can create external channels." });
  
  const { name, icon_url } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name required" });
  
  const slug = "ext-" + String(name).toLowerCase().replace(/\s+/g, "-") + "-" + Date.now();
  const g = await store.insertChannel({
    name: slug,
    display_name: name,
    icon_url: icon_url,
    team_name: "__EXTERNAL__",
    workspace_id: u.workspace_id,
    is_private_group: true,
    visibility: "all",
    post_permission_mode: "custom"
  });
  
  await store.addGroupMember(g.id, u.id);
  res.json({ success: true, group_id: g.id });
});

router.get("/get_ecosystem_directory", async (req, res) => {
  const u = req.user;
  const isLead = (u.team_role || "").toLowerCase() === "teamlead" || ["admin", "superadmin"].includes((u.role || "").toLowerCase());
  if (!isLead) return res.status(403).json({ error: "Forbidden" });
  
  const members = await store.listUsersByWorkspaceId(u.workspace_id);
  res.json(members.filter(m => (m.role || "").toLowerCase() !== "superadmin").map(m => ({
    id: m.id,
    email: m.email,
    name: m.name || m.email.split("@")[0],
    profile_pic_url: m.profile_pic_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name || m.email)}&background=ffffff&color=111827`,
  })));
});

export default router;
