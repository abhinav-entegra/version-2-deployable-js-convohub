import { canManageTargetUser } from "../policy/chat_policy.js";
import * as store from "./org_store.js";

export async function workspaceName(wsId) {
  const ws = await store.getWorkspace(wsId);
  return ws?.name || "Unknown workspace";
}

export async function destinationTeamLeadIds(toTeamName, workspaceId) {
  const users = await store.listUsersByTeamName(toTeamName);
  return users
    .filter(
      (u) =>
        Number(u.workspace_id) === Number(workspaceId) &&
        (u.team_role || "").toLowerCase() === "teamlead"
    )
    .map((u) => u.id);
}

export async function teamMemberUserIds(teamName, workspaceId) {
  const users = await store.listUsersByTeamName(teamName);
  return users.filter((u) => Number(u.workspace_id) === Number(workspaceId)).map((u) => u.id);
}

export function canInitiateTeamTransfer(actor, member) {
  if (!member || member.id === actor.id) {
    return { ok: false, err: "Invalid member." };
  }
  if ((member.team_role || "").trim().toLowerCase() === "teamlead") {
    return { ok: false, err: "Cannot transfer a team lead. Assign another lead first." };
  }
  const r = (actor.role || "").toLowerCase();
  if (r === "admin" || r === "superadmin") {
    if (Number(member.workspace_id) !== Number(actor.workspace_id)) {
      return { ok: false, err: "Member is not in your workspace." };
    }
    return { ok: true, err: null };
  }
  if ((actor.team_role || "").trim().toLowerCase() !== "teamlead") {
    return { ok: false, err: "Only team leads (or admins) can start a transfer." };
  }
  if (!canManageTargetUser(actor, member)) {
    return { ok: false, err: "You can only transfer members of your own team." };
  }
  return { ok: true, err: null };
}

export function canRespondTeamTransfer(actor, req) {
  if (req.status !== "pending") return false;
  const r = (actor.role || "").toLowerCase();
  if (r === "admin" || r === "superadmin") {
    return Number(actor.workspace_id) === Number(req.workspace_id);
  }
  if ((actor.team_role || "").trim().toLowerCase() === "teamlead") {
    return (
      Number(actor.workspace_id) === Number(req.workspace_id) &&
      (actor.team_name || "") === (req.to_team_name || "")
    );
  }
  return false;
}

export async function notifyTransferActivity(userIds, senderId, content, notifType) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  const msg = await store.insertMessage({
    sender_id: senderId,
    receiver_id: null,
    channel_name: null,
    content,
    msg_type: notifType,
    file_path: null,
    timestamp: new Date().toISOString(),
  });
  for (const uid of ids) {
    await store.insertNotification({
      user_id: uid,
      message_id: msg.id,
      type: notifType,
      is_seen: false,
      timestamp: new Date().toISOString(),
    });
  }
}

export async function collectTransferChatBackup(memberId, oldTeamName, workspaceId, maxItems = 1200) {
  const channels = (await store.listChannelsByWorkspace(workspaceId)).filter(
    (c) => c.team_name === oldTeamName
  );
  const rows = [];
  const senderCache = new Map();
  async function senderEmail(id) {
    if (senderCache.has(id)) return senderCache.get(id);
    const u = (await store.listUsersByIds([id]))[0];
    const e = u?.email || "";
    senderCache.set(id, e);
    return e;
  }
  for (const ch of channels) {
    if (rows.length >= maxItems) break;
    const msgs = await store.listMessagesForChannel(ch.name, workspaceId, workspaceId);
    for (const m of msgs) {
      if (rows.length >= maxItems) break;
      rows.push({
        kind: "channel",
        channel: m.channel_name,
        from_email: await senderEmail(m.sender_id),
        ts: m.timestamp,
        preview: (m.content || "").slice(0, 800),
        msg_type: m.msg_type || "text",
      });
    }
  }
  const teamUsers = await store.listUsersByTeamName(oldTeamName);
  const teamIds = teamUsers
    .filter((u) => Number(u.workspace_id) === Number(workspaceId) && u.id !== memberId)
    .map((u) => u.id);
  for (const otherId of teamIds) {
    if (rows.length >= maxItems) break;
    const dms = await store.listDmMessages(memberId, otherId);
    for (const m of dms.slice(0, 400)) {
      if (rows.length >= maxItems) break;
      const other = m.sender_id === memberId ? m.receiver_id : m.sender_id;
      rows.push({
        kind: "dm",
        channel: "(Direct message)",
        from_email: await senderEmail(other),
        ts: m.timestamp,
        preview: (m.content || "").slice(0, 800),
        msg_type: m.msg_type || "text",
      });
    }
  }
  return JSON.stringify(rows);
}

export async function stripOldTeamPrivateGroups(memberId, oldTeamName, workspaceId) {
  const groups = (await store.listChannelsByWorkspace(workspaceId)).filter(
    (c) => c.team_name === oldTeamName && c.is_private_group
  );
  for (const g of groups) {
    await store.removeGroupMember(g.id, memberId);
  }
}
export async function initiateTeamTransfer(actor, memberId, toTeamName) {
  const member = await store.getUserById(memberId);
  const check = canInitiateTeamTransfer(actor, member);
  if (!check.ok) throw new Error(check.err);

  const existing = await store.findPendingTransferByMember(memberId);
  if (existing) throw new Error("A transfer request is already pending for this member.");

  const request = await store.insertTransferRequest({
    workspace_id: actor.workspace_id,
    member_user_id: memberId,
    initiator_id: actor.id,
    from_team_name: member.team_name,
    to_team_name: toTeamName,
    status: "pending",
    created_at: new Date().toISOString(),
  });

  const leadIds = await destinationTeamLeadIds(toTeamName, actor.workspace_id);
  const content = `Transfer request: ${member.name || member.email} from ${member.team_name} to your team (${toTeamName}).`;
  await notifyTransferActivity(leadIds, actor.id, content, "transfer_request");

  return request;
}

export async function processTransferDecision(actor, requestId, decision) {
  const req = await store.getTransferRequestById(requestId);
  if (!req) throw new Error("Transfer request not found.");
  if (!canRespondTeamTransfer(actor, req)) {
    throw new Error("You do not have permission to respond to this transfer request.");
  }

  if (decision === "reject") {
    await store.updateTransferRequest(requestId, { status: "rejected", resolved_at: new Date().toISOString() });
    await notifyTransferActivity([req.initiator_id], actor.id, `Transfer request for member rejected by ${actor.name || actor.email}.`, "transfer_rejected");
    return { status: "rejected" };
  }

  if (decision === "approve") {
    const member = await store.getUserById(req.member_user_id);
    if (!member) throw new Error("Member no longer exists.");

    // 1. Chat Backup
    const backupJson = await collectTransferChatBackup(member.id, member.team_name, actor.workspace_id);
    await store.insertTransferBackup({
      user_id: member.id,
      workspace_id: actor.workspace_id,
      old_team_name: member.team_name,
      new_team_name: req.to_team_name,
      backup_json: backupJson,
      created_at: new Date().toISOString()
    });

    // 2. Strip old team private groups
    await stripOldTeamPrivateGroups(member.id, member.team_name, actor.workspace_id);

    // 3. Update User Team
    await store.updateUser(member.id, { team_name: req.to_team_name });

    // 4. Update Request
    await store.updateTransferRequest(requestId, { status: "approved", resolved_at: new Date().toISOString() });

    // 5. Notifications
    const timeStr = new Date().toLocaleString();
    const content = `Member ${member.name || member.email} transfer to ${req.to_team_name} APPROVED at ${timeStr}.`;
    
    // Notify Approver (actor)
    await notifyTransferActivity([actor.id], actor.id, `You approved the transfer of ${member.name || member.email} to your team.`, "transfer_approved");
    
    // Notify Sender (initiator)
    await notifyTransferActivity([req.initiator_id], actor.id, content, "transfer_approved");
    
    // Notify Member
    await notifyTransferActivity([member.id], actor.id, `You have been transferred to team ${req.to_team_name}. Welcome!`, "transfer_approved");

    return { status: "approved" };
  }

  throw new Error("Invalid decision.");
}
