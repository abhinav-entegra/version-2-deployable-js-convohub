import {
  canUserPostToChannel,
  canUserViewChannel,
  workspaceIsTeamIsolated,
  excludeSuperadminFromClientList,
  isPublicEcosystemWorkspace,
  canManagePublicGroupPostPolicy,
} from "../policy/chat_policy.js";
import * as store from "./org_store.js";

export async function getUserGroupChannelIdsSet(userId) {
  return store.listGroupIdsForUser(userId);
}

/** Base channel rows for user's workspace (matches get_channel_base_query). */
export async function getChannelBaseRows(user) {
  const wid = user.workspace_id;
  const rows = await store.listChannelsByWorkspace(wid);
  
  if (Number(wid) === 1 && user.team_name) {
    const explicit = await store.listGroupIdsForUser(user.id);
    const idList = [...explicit];
    return rows.filter((c) => {
      // Public channels (visibility="all" and NOT a private group) should be visible to everyone in the workspace
      if (!c.is_private_group && (c.visibility || "all") === "all") return true;
      
      const role = (user.role || "").toLowerCase();
      const isLead = (user.team_role || "").toLowerCase() === "teamlead";
      const isAdmin = ["admin", "superadmin"].includes(role);
      if ((isAdmin || isLead) && c.team_name === "__EXTERNAL__") return true;
      
      // Otherwise, enforce team isolation or explicit membership
      return c.team_name === user.team_name || idList.includes(Number(c.id));
    });
  }
  return rows;
}

export async function getChannelInContext(user, { channelName, channelId } = {}) {
  const base = await getChannelBaseRows(user);
  if (channelName != null) {
    return base.find((c) => c.name === channelName) || null;
  }
  if (channelId != null) {
    return base.find((c) => Number(c.id) === Number(channelId)) || null;
  }
  return null;
}

export async function channelPolicySets(channelId) {
  const [explicit, bulk] = await Promise.all([
    store.listExplicitMemberIds(channelId),
    store.listBulkRoles(channelId),
  ]);
  return { explicit, bulk };
}

export async function canViewChannelResolved(user, channel) {
  const groupIds = await getUserGroupChannelIdsSet(user.id);
  const explicit = await store.listExplicitMemberIds(channel.id);
  return canUserViewChannel(user, channel, explicit, groupIds);
}

export async function canPostResolved(user, channel) {
  const groupIds = await getUserGroupChannelIdsSet(user.id);
  const explicit = await store.listExplicitMemberIds(channel.id);
  const bulk = await store.listBulkRoles(channel.id);
  return canUserPostToChannel(user, channel, explicit, bulk, groupIds);
}

export async function getWorkspaceAccessUserIds(workspaceId) {
  return store.listWorkspaceAccessUserIds(workspaceId);
}

export async function getContextMemberQueryUsers(user, workspace) {
  if (!workspace) return [];
  let rows;
  if (workspaceIsTeamIsolated(workspace)) {
    rows = await store.listUsersByWorkspaceId(workspace.id);
  } else {
    const accessIds = await getWorkspaceAccessUserIds(workspace.id);
    rows = await store.listUsersByIds(accessIds);
  }

  const role = (user.role || "").toLowerCase();
  const isAdmin = ["admin", "superadmin"].includes(role);

  if (workspaceIsTeamIsolated(workspace) && user.team_name && !isAdmin) {
    rows = rows.filter((u) => u.team_name === user.team_name);
  }
  return rows;
}

export async function getEcosystemMembers(workspace, searchTerm, limit) {
  if (!workspace) return [];
  let rows;
  if (workspaceIsTeamIsolated(workspace)) {
    rows = await store.listUsersByWorkspaceId(workspace.id);
  } else {
    const ids = await getWorkspaceAccessUserIds(workspace.id);
    rows = ids.length ? await store.listUsersByIds(ids) : [];
  }
  if (searchTerm) {
    const p = searchTerm.toLowerCase();
    rows = rows.filter(
      (u) =>
        (u.email && u.email.toLowerCase().includes(p)) ||
        (u.name && String(u.name).toLowerCase().includes(p))
    );
  }
  rows.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

export async function getClientWorkspaceRoster(viewer, workspace) {
  if (!workspace) return [];
  let members;
  if (workspaceIsTeamIsolated(workspace)) {
    members = await getContextMemberQueryUsers(viewer, workspace);
  } else {
    members = await getEcosystemMembers(workspace);
  }
  return excludeSuperadminFromClientList(members);
}

export function workspaceFlags(user, ws) {
  return {
    isPublic: isPublicEcosystemWorkspace(ws),
    canManagePublic: ws ? canManagePublicGroupPostPolicy(user, ws) : false,
  };
}

/** Users who should receive an @all notification in this channel (excludes sender in caller). */
export async function getUsersForAllMention(channel, viewer, senderId) {
  const workspace = await store.getWorkspace(channel.workspace_id);
  if (!workspace) return [];
  const roster = await getClientWorkspaceRoster(viewer, workspace);
  const explicit = await store.listExplicitMemberIds(channel.id);
  const out = [];
  for (const u of roster) {
    if (Number(u.id) === Number(senderId)) continue;
    const gids = await store.listGroupIdsForUser(u.id);
    if (canUserViewChannel(u, channel, explicit, gids)) {
      out.push(u);
    }
  }
  return out;
}
