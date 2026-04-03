import { supabase } from "../database.js";
import { decryptMessageRow, decryptUserRow, encryptMaybe } from "../utils/field_crypto.js";

export async function getWorkspace(id) {
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listWorkspacesByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("workspaces").select("*").in("id", ids);
  if (error) throw error;
  return data || [];
}

export async function listWorkspaceAccessRows(userId) {
  const { data, error } = await supabase
    .from("workspace_access")
    .select("workspace_id")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

export async function grantWorkspaceAccess(userId, workspaceId) {
  const { error } = await supabase
    .from("workspace_access")
    .upsert({ user_id: userId, workspace_id: workspaceId }, { onConflict: "user_id,workspace_id" });
  if (error) throw error;
}

export async function removeWorkspaceAccessForUsers(workspaceId, userIds) {
  if (!userIds.length) return;
  const { error } = await supabase
    .from("workspace_access")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("user_id", userIds);
  if (error) throw error;
}

export async function listPublicWorkspaces() {
  const { data, error } = await supabase.from("workspaces").select("*").eq("is_private", false);
  if (error) throw error;
  return data || [];
}

/** Superadmin / admin tooling — all workspaces (ordered by id). */
export async function listAllWorkspaces() {
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .order("id", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function listWorkspacesCreatedBy(userId) {
  const { data, error } = await supabase.from("workspaces").select("*").eq("creator_id", userId);
  if (error) throw error;
  return data || [];
}

export async function insertWorkspace(row) {
  const { data, error } = await supabase.from("workspaces").insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateWorkspace(id, patch) {
  const { data, error } = await supabase.from("workspaces").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteWorkspace(id) {
  const { error } = await supabase.from("workspaces").delete().eq("id", id);
  if (error) throw error;
}

export async function listUsersByWorkspaceId(workspaceId) {
  const { data, error } = await supabase.from("users").select("*").eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data || []).map((u) => decryptUserRow(u));
}

export async function countUsersInWorkspace(workspaceId) {
  const { count, error } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return { count: count ?? 0 };
}

export async function listUsersByTeamName(teamName) {
  const { data, error } = await supabase.from("users").select("*").eq("team_name", teamName);
  if (error) throw error;
  return (data || []).map((u) => decryptUserRow(u));
}

export async function searchUsers(workspaceIds, teamName, pattern, limit = 50) {
  let q = supabase.from("users").select("*").limit(limit);
  if (teamName) q = q.eq("team_name", teamName);
  if (workspaceIds?.length) q = q.in("workspace_id", workspaceIds);
  const { data, error } = await q;
  if (error) throw error;
  let rows = (data || []).map((u) => decryptUserRow(u));
  if (pattern) {
    const p = pattern.toLowerCase();
    rows = rows.filter(
      (u) =>
        (u.email && u.email.toLowerCase().includes(p)) ||
        (u.name && String(u.name).toLowerCase().includes(p))
    );
  }
  rows.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  return rows;
}

export async function updateUser(id, patch) {
  const enc = { ...patch };
  if (patch.name != null) enc.name = encryptMaybe(patch.name);
  if (patch.profile_pic_url != null) enc.profile_pic_url = encryptMaybe(patch.profile_pic_url);
  enc.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("users").update(enc).eq("id", id).select().single();
  if (error) throw error;
  return decryptUserRow(data);
}

export async function getTeamByName(name) {
  const { data, error } = await supabase.from("teams").select("*").eq("name", name).maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertTeam(row) {
  const { data, error } = await supabase.from("teams").insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function listTeamsByWorkspace(workspaceId) {
  const { data, error } = await supabase
    .from("teams")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function insertChannel(row) {
  const { data, error } = await supabase.from("channels").insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function deleteChannel(id) {
  const { error } = await supabase.from("channels").delete().eq("id", id);
  if (error) throw error;
}

export async function updateChannel(id, patch) {
  const { data, error } = await supabase.from("channels").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

export async function listChannelsByWorkspace(workspaceId) {
  const { data, error } = await supabase.from("channels").select("*").eq("workspace_id", workspaceId);
  if (error) throw error;
  return data || [];
}

export async function listPrivateGroupsFast(workspaceId, teamName, userId, isAdmin) {
  let q = supabase
    .from("channels")
    .select("id,name,display_name,icon_url,post_permission_mode,team_name,is_private_group,workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("is_private_group", true);

  if (teamName) q = q.eq("team_name", teamName);

  const { data, error } = await q.order("id", { ascending: true });
  if (error) throw error;

  if (isAdmin || !userId) return data || [];

  // Filter by membership if not an admin
  const memberIds = await listGroupIdsForUser(userId);
  return (data || []).filter((g) => memberIds.has(Number(g.id)));
}


export async function getChannelByWorkspaceAndName(workspaceId, name) {
  const { data, error } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getChannelById(id) {
  const { data, error } = await supabase.from("channels").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listGroupIdsForUser(userId) {
  const { data, error } = await supabase.from("group_members").select("group_id").eq("user_id", userId);
  if (error) throw error;
  return new Set((data || []).map((r) => Number(r.group_id)));
}

export async function listExplicitMemberIds(channelId) {
  const { data, error } = await supabase.from("group_members").select("user_id").eq("group_id", channelId);
  if (error) throw error;
  return new Set((data || []).map((r) => Number(r.user_id)));
}

export async function addGroupMember(groupId, userId) {
  const { error } = await supabase.from("group_members").insert([{ group_id: groupId, user_id: userId }]);
  if (error) throw error;
}

export async function removeGroupMember(groupId, userId) {
  const { error } = await supabase
    .from("group_members")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteAllGroupMembers(groupId) {
  const { error } = await supabase.from("group_members").delete().eq("group_id", groupId);
  if (error) throw error;
}

export async function listBulkRoles(channelId) {
  const { data, error } = await supabase
    .from("channel_role_permissions")
    .select("team_role")
    .eq("channel_id", channelId);
  if (error) throw error;
  return new Set((data || []).map((r) => r.team_role));
}

export async function replaceBulkRoles(channelId, roles) {
  await supabase.from("channel_role_permissions").delete().eq("channel_id", channelId);
  if (!roles.length) return;
  const { error } = await supabase
    .from("channel_role_permissions")
    .insert(roles.map((team_role) => ({ channel_id: channelId, team_role })));
  if (error) throw error;
}

export async function replaceExplicitMembers(channelId, userIds) {
  await deleteAllGroupMembers(channelId);
  for (const uid of userIds) {
    await addGroupMember(channelId, uid);
  }
}

export async function insertMessage(row) {
  let wid = row.workspace_id;
  if (wid == null && row.sender_id) {
    const { data: urow } = await supabase
      .from("users")
      .select("workspace_id")
      .eq("id", row.sender_id)
      .maybeSingle();
    wid = urow?.workspace_id ?? null;
  }
  const plainContent = row.content ?? "";
  const payload = {
    ...row,
    workspace_id: wid,
    content: encryptMaybe(plainContent),
    file_path: row.file_path != null ? encryptMaybe(row.file_path) : null,
  };
  const { data, error } = await supabase.from("messages").insert([payload]).select().single();
  if (!error) return decryptMessageRow(data);
  // Backward-compatibility: if DB column client_msg_id is not present yet,
  // retry insert without it so deployments keep working before migration is run.
  if (String(error?.message || "").toLowerCase().includes("client_msg_id")) {
    const fallback = { ...payload };
    delete fallback.client_msg_id;
    const { data: data2, error: error2 } = await supabase
      .from("messages")
      .insert([fallback])
      .select()
      .single();
    if (error2) throw error2;
    return decryptMessageRow(data2);
  }
  throw error;
}

export async function findMessageByClientMsgId(senderId, clientMsgId) {
  if (!clientMsgId) return null;
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("sender_id", senderId)
      .eq("client_msg_id", clientMsgId)
      .maybeSingle();
    if (error) throw error;
    return data ? decryptMessageRow(data) : null;
  } catch {
    // If schema is not migrated yet (no client_msg_id column), act as unsupported.
    return null;
  }
}

export async function listMessagesForChannel(channelName, workspaceId, viewerWorkspaceId, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const beforeTs = opts.beforeTs ? String(opts.beforeTs) : null;
  const afterTs = opts.afterTs ? String(opts.afterTs) : null;
  let q = supabase
    .from("messages")
    .select("*")
    .eq("channel_name", channelName)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lt("timestamp", beforeTs);
  if (afterTs) q = q.gt("timestamp", afterTs);
  q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []).map((m) => decryptMessageRow(m)).reverse();
  if (!rows.length) return [];
  const senderIds = [...new Set(rows.map((m) => m.sender_id))];
  const { data: senders } = await supabase.from("users").select("*").in("id", senderIds);
  const byId = Object.fromEntries((senders || []).map((u) => [u.id, decryptUserRow(u)]));
  return rows.filter((m) => {
    const s = byId[m.sender_id];
    return s && Number(s.workspace_id) === Number(viewerWorkspaceId);
  });
}

export async function listDmMessages(aId, bId, opts = {}) {
  const a = Number(aId);
  const b = Number(bId);
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const beforeTs = opts.beforeTs ? String(opts.beforeTs) : null;
  const afterTs = opts.afterTs ? String(opts.afterTs) : null;
  let q = supabase
    .from("messages")
    .select("*")
    .is("channel_name", null)
    .or(
      `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`
    )
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lt("timestamp", beforeTs);
  if (afterTs) q = q.gt("timestamp", afterTs);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((m) => decryptMessageRow(m)).reverse();
}

export async function markDmReadForReceiver(readerId, otherId) {
  const { error } = await supabase
    .from("messages")
    .update({ is_read: true })
    .eq("receiver_id", readerId)
    .eq("sender_id", otherId)
    .is("channel_name", null);
  if (error) throw error;
}

export async function countUnreadDmBySender(receiverId) {
  const { data, error } = await supabase
    .from("messages")
    .select("sender_id")
    .eq("receiver_id", receiverId)
    .eq("is_read", false)
    .is("channel_name", null)
    .not("sender_id", "is", null);
  if (error) throw error;
  const counts = {};
  for (const r of data || []) {
    const k = r.sender_id;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

export async function upsertChannelVisit(userId, channelName) {
  const { error } = await supabase.from("channel_visits").upsert(
    { user_id: userId, channel_name: channelName, last_visit: new Date().toISOString() },
    { onConflict: "user_id,channel_name" }
  );
  if (error) throw error;
}

export async function getChannelVisit(userId, channelName) {
  const { data, error } = await supabase
    .from("channel_visits")
    .select("*")
    .eq("user_id", userId)
    .eq("channel_name", channelName)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function countChannelUnread(userId, channelNames, viewerWorkspaceId) {
  if (!channelNames.length) return {};
  const { data: visits } = await supabase
    .from("channel_visits")
    .select("*")
    .eq("user_id", userId)
    .in("channel_name", channelNames);
  const visitMap = Object.fromEntries((visits || []).map((v) => [v.channel_name, new Date(v.last_visit)]));
  let mq = supabase
    .from("messages")
    .select("id, channel_name, timestamp, sender_id, workspace_id")
    .in("channel_name", channelNames);
  mq = mq.eq("workspace_id", viewerWorkspaceId);
  const { data: msgs, error } = await mq;
  if (error) throw error;
  const senderIds = [...new Set((msgs || []).map((m) => m.sender_id))];
  const { data: senders } = await supabase.from("users").select("id, workspace_id").in("id", senderIds);
  const wsMap = Object.fromEntries((senders || []).map((s) => [s.id, s.workspace_id]));
  const res = Object.fromEntries(channelNames.map((n) => [n, 0]));
  const defaultT = new Date("2000-01-01");
  for (const m of msgs || []) {
    if (Number(wsMap[m.sender_id]) !== Number(viewerWorkspaceId)) continue;
    const last = visitMap[m.channel_name] || defaultT;
    if (new Date(m.timestamp) > last) {
      res[m.channel_name] = (res[m.channel_name] || 0) + 1;
    }
  }
  return res;
}

export async function insertNotification(row) {
  const { error } = await supabase.from("notifications").insert([row]);
  if (error) throw error;
}

export async function listNotifications(userId, limit = 20) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function markNotificationsSeen(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from("notifications").update({ is_seen: true }).in("id", ids);
  if (error) throw error;
}

export async function getMessageById(id) {
  const { data, error } = await supabase.from("messages").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? decryptMessageRow(data) : null;
}

export async function notificationExists(userId, messageId, type) {
  const { data, error } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .eq("type", type)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function listDmPermissions(userId) {
  const { data, error } = await supabase.from("dm_permissions").select("*").eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

export async function upsertDmPermission(userId, targetId) {
  const { error } = await supabase
    .from("dm_permissions")
    .upsert({ user_id: userId, target_id: targetId }, { onConflict: "user_id,target_id" });
  if (error) throw error;
}

export async function deleteDmPermission(userId, targetId) {
  const { error } = await supabase
    .from("dm_permissions")
    .delete()
    .eq("user_id", userId)
    .eq("target_id", targetId);
  if (error) throw error;
}

export async function hasDmGrant(userId, targetId) {
  const { data, error } = await supabase
    .from("dm_permissions")
    .select("id")
    .eq("user_id", userId)
    .eq("target_id", targetId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function listTransferRequestsPendingForTeam(teamName, workspaceId) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .eq("to_team_name", teamName);
  if (error) throw error;
  return data || [];
}

export async function listTransferRequestsByMember(memberUserId) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("member_user_id", memberUserId);
  if (error) throw error;
  return data || [];
}

export async function insertTransferRequest(row) {
  const { data, error } = await supabase.from("member_transfer_requests").insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function findPendingTransferByMember(memberUserId) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("member_user_id", memberUserId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTransferRequestById(id) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listOutgoingTransfers(initiatorId, workspaceId) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .eq("initiator_id", initiatorId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listPendingTransfersInWorkspace(workspaceId) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateTransferRequest(id, patch) {
  const { data, error } = await supabase
    .from("member_transfer_requests")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function insertTransferBackup(row) {
  const { data, error } = await supabase.from("transfer_chat_backups").insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function listTransferBackups(userId) {
  const { data, error } = await supabase
    .from("transfer_chat_backups")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getTransferBackup(userId, backupId) {
  const { data, error } = await supabase
    .from("transfer_chat_backups")
    .select("*")
    .eq("id", backupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function countTeamleadsInGroup(groupId, excludeUserId) {
  const { data, error } = await supabase
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId);
  if (error) throw error;
  const ids = (data || []).map((r) => r.user_id).filter((id) => id !== excludeUserId);
  if (!ids.length) return 0;
  const { data: users } = await supabase.from("users").select("id, team_role").in("id", ids);
  return (users || []).filter((u) => (u.team_role || "").toLowerCase() === "teamlead").length;
}

export async function listWorkspaceAccessUserIds(workspaceId) {
  const { data, error } = await supabase
    .from("workspace_access")
    .select("user_id")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  const ids = new Set((data || []).map((r) => Number(r.user_id)));
  const ws = await getWorkspace(workspaceId);
  if (ws?.creator_id) ids.add(Number(ws.creator_id));
  return [...ids];
}

export async function listUsersByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("users").select("*").in("id", ids);
  if (error) throw error;
  return (data || []).map((u) => decryptUserRow(u));
}

export async function updateUserDmAllowlist(userId, allowlistOnly) {
  const { error } = await supabase.from("users").update({ dm_allowlist_only: allowlistOnly }).eq("id", userId);
  if (error) throw error;
}
