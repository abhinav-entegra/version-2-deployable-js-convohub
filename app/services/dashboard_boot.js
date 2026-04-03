import {
  canManagePublicGroupPostPolicy,
  isPublicEcosystemWorkspace,
} from "../policy/chat_policy.js";
import { createAccessTokenFromUser } from "../utils/security.js";
import { SOCKET_TOKEN_EXPIRE_MINUTES } from "../config.js";
import * as store from "./org_store.js";

function dashboardBrandLogoUrl(user, ws, team) {
  if (!ws) {
    return "https://ui-avatars.com/api/?name=Workspace&background=f1f5f9&color=475569&bold=true&format=png";
  }
  const teamName = (user.team_name || "").trim();
  if (Number(ws.id) === 1 && teamName && team?.logo_url) {
    return team.logo_url;
  }
  if (ws.logo_url) return ws.logo_url;
  const name = encodeURIComponent(teamName || ws.name || "Team");
  return `https://ui-avatars.com/api/?name=${name}&background=f1f5f9&color=475569&bold=true&format=png`;
}

/**
 * Payload injected into dashboard.template.html.
 */
export async function buildDashboardBoot(user) {
  const ws = await store.getWorkspace(user.workspace_id);
  const team = user.team_name ? await store.getTeamByName(user.team_name) : null;
  const can_deploy_publicly = !!(team && team.can_deploy_publicly);
  const can_manage_public = canManagePublicGroupPostPolicy(user, ws);
  const dashboard_brand_logo = dashboardBrandLogoUrl(user, ws, team);
  const can_edit_team_logo = !!(
    ws &&
    Number(ws.id) === 1 &&
    (user.team_name || "").trim() &&
    ((user.team_role || "").toLowerCase() === "teamlead" ||
      ["admin", "superadmin"].includes((user.role || "").toLowerCase()))
  );
  const signaling_public_url = process.env.SIGNALING_PUBLIC_URL || "";
  const socket_bootstrap_token = createAccessTokenFromUser(user, SOCKET_TOKEN_EXPIRE_MINUTES);

  let team_directory = { team_name: null, members: [] };
  const tn = (user.team_name || "").trim();
  if (tn) {
    const mates = await store.listUsersByTeamName(tn);
    team_directory = {
      team_name: tn,
      members: mates.map((m) => ({
        id: m.id,
        email: m.email || "",
        name: m.name || "",
        profile_pic_url: m.profile_pic_url || "",
        team_role: m.team_role || "",
      })),
    };
    team_directory.members.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  }

  return {
    user: {
      id: user.id,
      email: user.email || "",
      name: user.name || "",
      profile_pic_url: user.profile_pic_url || "",
      workspace_id: user.workspace_id || 1,
      role: user.role || "",
      team_role: user.team_role || "",
      team_name: user.team_name || "",
      is_restricted: !!user.is_restricted,
      can_deploy_publicly,
      workspace_is_private: !!(ws && ws.is_private),
      workspace_is_public_ecosystem: isPublicEcosystemWorkspace(ws),
      can_manage_public_group_policy: can_manage_public,
      dm_allowlist_only: !!user.dm_allowlist_only,
    },
    workspace: ws
      ? { id: ws.id, name: ws.name, is_private: ws.is_private, allow_group_creation: ws.allow_group_creation }
      : null,
    dashboard_brand_logo,
    can_edit_team_logo,
    signaling_public_url,
    socket_bootstrap_token,
    team_directory,
  };
}
