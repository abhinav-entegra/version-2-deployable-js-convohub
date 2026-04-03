/**
 * Channel / DM permission helpers — ported from Flask chat_policy.py + unified_app.py
 * (can_user_post_to_channel, get_channel_member_records logic uses these primitives).
 */

export function isChannelManager(user) {
  const r = (user.role || "").toLowerCase();
  return r === "admin" || r === "superadmin" || (user.team_role || "").toLowerCase() === "teamlead";
}

export function isPublicEcosystemWorkspace(ws) {
  if (!ws) return false;
  return Number(ws.id) !== 1 && !ws.is_private;
}

export function workspaceIsTeamIsolated(ws) {
  if (!ws) return false;
  return Number(ws.id) === 1 || !!ws.is_private;
}

export function excludeSuperadminFromClientList(users) {
  return users.filter((u) => (u.role || "").trim().toLowerCase() !== "superadmin");
}

/** @param {Set<number|string>} userGroupChannelIds */
export function channelPassesVisibilityFilter(channel, user, userGroupChannelIds) {
  if (isChannelManager(user)) return true;

  const vis = (channel.visibility || "").trim().toLowerCase();
  const des = (user.designation || "SE").toUpperCase();
  const inCustom =
    userGroupChannelIds.has(Number(channel.id)) || userGroupChannelIds.has(String(channel.id));

  if (des === "SE") {
    return (
      ["all", "se_sse_tl", "se_tl"].includes(vis) || (vis === "custom" && inCustom)
    );
  }
  if (des === "SSE") {
    return (
      ["all", "se_sse_tl", "sse_tl"].includes(vis) || (vis === "custom" && inCustom)
    );
  }
  return vis === "all" || (vis === "custom" && inCustom);
}

export function canUserViewChannel(user, channel, explicitMemberIds, userGroupChannelIds) {
  if (user.is_restricted) return false;

  const role = (user.role || "").toLowerCase();
  const explicit = explicitMemberIds instanceof Set ? explicitMemberIds : new Set(explicitMemberIds || []);
  const priv = !!channel.is_private_group;
  const vis = (channel.visibility || "").trim().toLowerCase();

  if (priv) {
    if (role === "admin" || role === "superadmin") return true;
    const isLead = (user.team_role || "").toLowerCase() === "teamlead";
    if (isLead && (user.team_name || "").trim() === (channel.team_name || "").trim()) return true;
    if (isLead && channel.team_name === "__EXTERNAL__") return true; // Externals are globally manageable by leads
    return explicit.has(Number(user.id)) || explicit.has(String(user.id));
  }
  if (vis === "custom") {
    if (role === "admin" || role === "superadmin") return true;
    return explicit.has(Number(user.id)) || explicit.has(String(user.id));
  }
  const gids =
    userGroupChannelIds instanceof Set ? userGroupChannelIds : new Set(userGroupChannelIds || []);
  return channelPassesVisibilityFilter(channel, user, gids);
}

export function canUserPostToChannel(
  user,
  channel,
  explicitMemberIds,
  bulkRoles,
  userGroupChannelIds
) {
  const explicit = explicitMemberIds instanceof Set ? explicitMemberIds : new Set(explicitMemberIds || []);
  const bulk = bulkRoles instanceof Set ? bulkRoles : new Set(bulkRoles || []);
  const gids =
    userGroupChannelIds instanceof Set ? userGroupChannelIds : new Set(userGroupChannelIds || []);

  if (!canUserViewChannel(user, channel, explicit, gids)) {
    return false;
  }

  const role = (user.role || "").toLowerCase();
  if (role === "admin" || role === "superadmin") return true;

  if (channel.post_permission_mode !== "custom") return true;

  if (explicit.has(Number(user.id)) || explicit.has(String(user.id))) return true;

  const isLead = (user.team_role || "").toLowerCase() === "teamlead";
  if (isLead && channel.is_private_group && (user.team_name || "").trim() === (channel.team_name || "").trim()) return true;

  const tr = user.team_role || "";
  if (tr && bulk.has(tr)) return true;

  return false;
}

export function getChannelPostBlockReason(user, channel) {
  if (user.is_restricted) {
    return "Your communication privileges have been revoked.";
  }
  if (channel.post_permission_mode === "custom") {
    return "You can view this group, but only selected members can send messages here.";
  }
  return "You do not have permission to send messages in this group.";
}

/**
 * DM policy — mirrors can_user_dm_target (requires workspace row for sender workspace when checking private hub rules).
 * @param {{ id: any, role?: string, team_role?: string, workspace_id?: any, dm_allowlist_only?: boolean }} sender
 * @param {{ id: any, role?: string, team_role?: string, workspace_id?: any }} target
 * @param {boolean} hasGrant — row exists in dm_permissions
 * @param {{ id: any, is_private?: boolean } | null} senderWorkspace
 */
export function canUserDmTarget(sender, target, hasGrant, senderWorkspace) {
  if (!target) return false;

  const sRole = (sender.role || "").toLowerCase();
  const isLead = (sender.team_role || "").trim().toLowerCase() === "teamlead";
  const isAdmin = sRole === "admin" || sRole === "superadmin";

  // Admins and Team Leads have no restrictions
  if (isAdmin || isLead) return true;

  const targetIsLead =
    (target.team_role || "").trim().toLowerCase() === "teamlead" ||
    ["admin", "superadmin"].includes((target.role || "").toLowerCase());

  // Can always chat with a lead
  if (targetIsLead) return true;

  // Check if sender has explicit grant
  if (hasGrant) return true;

  const allowlistOnly = !!sender.dm_allowlist_only;
  if (allowlistOnly) return false;

  // Fallback to same-team logic if not restricted
  const st = (sender.team_name || "").trim();
  const tt = (target.team_name || "").trim();
  if (st && tt && st === tt && Number(sender.workspace_id) === Number(target.workspace_id)) {
    return true;
  }

  const sw = Number(sender.workspace_id);
  const tw = Number(target.workspace_id);
  if (sw === 1 && tw === 1) return false;
  if (sw === tw && senderWorkspace && senderWorkspace.is_private && sw !== 1) {
    return false;
  }
  return true;
}

export function canManageTargetUser(actor, target) {
  if (!target) return false;
  if (actor.role === "superadmin") return true;
  if (actor.role === "admin") {
    return Number(actor.workspace_id) === Number(target.workspace_id);
  }
  if ((actor.team_role || "").trim().toLowerCase() === "teamlead") {
    return (
      Number(actor.workspace_id) === Number(target.workspace_id) &&
      (actor.team_name || "") === (target.team_name || "")
    );
  }
  return false;
}

export function canManagePublicGroupPostPolicy(user, workspace) {
  if (!isPublicEcosystemWorkspace(workspace)) return false;
  if ((user.team_role || "").trim().toLowerCase() !== "teamlead") return false;
  const tn = (user.team_name || "").trim().toLowerCase();
  return tn.includes("espl") || tn.includes("admin apple");
}
