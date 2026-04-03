import * as store from "./org_store.js";

/**
 * Server payload for admin console HTML (legacy Flask admin parity: workspace + team ops).
 */
export async function buildAdminBoot(user) {
  const r = (user.role || "").toLowerCase();
  const isSuper = r === "superadmin";
  let workspaces;
  if (isSuper) {
    workspaces = await store.listAllWorkspaces();
  } else {
    const ws = await store.getWorkspace(user.workspace_id);
    workspaces = ws ? [ws] : [];
  }
  const wid = user.workspace_id || 1;
  const teams = await store.listTeamsByWorkspace(wid);
  const currentWs = await store.getWorkspace(wid);
  const { count } = await store.countUsersInWorkspace(wid);
  const workspaceUsers = await store.listUsersByWorkspaceId(wid);
  const directory_users = workspaceUsers.map((u) => ({
    id: u.id,
    email: u.email || "",
    name: u.name || "",
    role: u.role || "",
    team_role: u.team_role || "",
    team_name: u.team_name || "",
    profile_pic_url: u.profile_pic_url || "",
  }));
  directory_users.sort((a, b) => Number(a.id) - Number(b.id));

  return {
    user: {
      id: user.id,
      email: user.email || "",
      role: user.role || "",
      team_role: user.team_role || "",
      workspace_id: wid,
      team_name: user.team_name || "",
    },
    is_superadmin: isSuper,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      is_private: w.is_private !== false,
      allow_group_creation: w.allow_group_creation !== false,
      theme_color: w.theme_color,
    })),
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      workspace_id: t.workspace_id,
      can_deploy_publicly: !!t.can_deploy_publicly,
    })),
    current_workspace: currentWs
      ? {
          id: currentWs.id,
          name: currentWs.name,
          is_private: currentWs.is_private !== false,
          allow_group_creation: currentWs.allow_group_creation !== false,
        }
      : null,
    stats: { users_in_current_workspace: count },
    directory_users,
  };
}
