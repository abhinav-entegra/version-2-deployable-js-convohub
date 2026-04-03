import express from "express";
import { requireAdmin, requireAuth } from "../dependencies.js";
import { createTeam } from "../services/team_service.js";
import { requireFields } from "../schemas.js";
import * as store from "../services/org_store.js";
import { buildAdminBoot } from "../services/admin_boot.js";
import { createInvitedUserRow, getUserByEmail, getUserById } from "../services/auth_service.js";
import { hashPassword } from "../utils/security.js";

const router = express.Router();

router.get("/api/overview", requireAuth, requireAdmin, async (req, res) => {
  try {
    const boot = await buildAdminBoot(req.user);
    res.json(boot);
  } catch (e) {
    res.status(500).json({ detail: String(e.message || e) });
  }
});

router.post("/api/update_own_password", requireAuth, requireAdmin, async (req, res) => {
  try {
    const p = req.body?.new_password ?? req.body?.password;
    if (!p || String(p).length < 6) {
      return res.status(400).json({ detail: "new_password required (min 6 characters)" });
    }
    const hashed = await hashPassword(String(p));
    await store.updateUser(req.user.id, { password: hashed });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Reset another user’s password (same workspace, or superadmin). Only superadmin may reset admin/superadmin accounts. */
router.post("/api/reset_user_password", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    const password = req.body?.password;
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ detail: "user_id required" });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ detail: "password required (min 6 characters)" });
    }
    const target = await getUserById(userId);
    if (!target) return res.status(404).json({ detail: "User not found" });
    const adminR = (req.user.role || "").toLowerCase();
    if (
      adminR !== "superadmin" &&
      Number(target.workspace_id) !== Number(req.user.workspace_id || 0)
    ) {
      return res.status(403).json({ detail: "Cannot reset users outside your workspace" });
    }
    const targetR = (target.role || "").toLowerCase();
    if (adminR !== "superadmin" && (targetR === "admin" || targetR === "superadmin")) {
      return res.status(403).json({ detail: "Only superadmin can reset passwords for admins" });
    }
    const hashed = await hashPassword(String(password));
    await store.updateUser(userId, { password: hashed });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Members of a team (by exact team name). Team must belong to caller’s workspace unless superadmin. */
router.get("/api/team_members", requireAuth, requireAdmin, async (req, res) => {
  try {
    const teamName = String(req.query.team_name || "").trim();
    if (!teamName) return res.status(400).json({ detail: "team_name query required" });
    const team = await store.getTeamByName(teamName);
    if (!team) return res.status(404).json({ detail: "Team not found" });
    const adminR = (req.user.role || "").toLowerCase();
    const wid = req.user.workspace_id || 1;
    if (adminR !== "superadmin" && Number(team.workspace_id) !== Number(wid)) {
      return res.status(403).json({ detail: "Team not in your workspace" });
    }
    const rows = await store.listUsersByTeamName(teamName);
    const members = rows.map((u) => ({
      id: u.id,
      email: u.email || "",
      name: u.name || "",
      role: u.role || "",
      team_role: u.team_role || "",
      profile_pic_url: u.profile_pic_url || "",
    }));
    members.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    return res.json({ team_name: team.name, members });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/**
 * Invite / create account. Body: email, password, role (member | teamlead | admin | superadmin), team_name optional, name optional.
 * Superadmin-only for role superadmin.
 */
router.post("/api/invite_user", requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    const kind = String(req.body?.role || "member").toLowerCase().replace(/\s+/g, "");
    let teamRaw = req.body?.team_name != null ? String(req.body.team_name).trim() : "";
    if (!email || !email.includes("@")) {
      return res.status(400).json({ detail: "Valid email required" });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ detail: "password required (min 6 characters)" });
    }
    if (kind === "superadmin" && (req.user.role || "").toLowerCase() !== "superadmin") {
      return res.status(403).json({ detail: "Only superadmin can assign superadmin" });
    }
    const allowed = ["member", "teamlead", "admin", "superadmin"];
    if (!allowed.includes(kind)) {
      return res.status(400).json({ detail: "role must be member, teamlead, admin, or superadmin" });
    }

    const wid = targetWorkspaceId(req);
    let teamName = null;
    if (teamRaw && teamRaw.toLowerCase() !== "unassigned") {
      const team = await store.getTeamByName(teamRaw);
      if (!team || Number(team.workspace_id) !== Number(wid)) {
        return res.status(400).json({ detail: "Team not found in this workspace" });
      }
      teamName = team.name;
    }

    let appRole = "user";
    let teamRole = "member";
    if (kind === "member") {
      appRole = "user";
      teamRole = "member";
    } else if (kind === "teamlead") {
      appRole = "user";
      teamRole = "teamlead";
    } else if (kind === "admin") {
      appRole = "admin";
      teamRole = "member";
    } else if (kind === "superadmin") {
      appRole = "superadmin";
      teamRole = "member";
    }

    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ detail: "That email is already registered" });

    const created = await createInvitedUserRow({
      email,
      password,
      role: appRole,
      team_role: teamRole,
      team_name: teamName,
      workspace_id: wid,
      name: req.body?.name,
    });
    return res.json({ ok: true, user: { id: created.id, email: created.email } });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

function targetWorkspaceId(req) {
  const bodyWid = req.body?.workspace_id != null ? Number(req.body.workspace_id) : null;
  const r = (req.user?.role || "").toLowerCase();
  if (r === "superadmin" && Number.isFinite(bodyWid)) return bodyWid;
  return req.user.workspace_id || 1;
}

router.post("/create-team", requireAuth, requireAdmin, async (req, res) => {
  try {
    const missing = requireFields(req.body, ["name"]);
    if (missing) return res.status(400).json({ detail: missing });

    const wsId = targetWorkspaceId(req);
    const team = await createTeam(req.body.name, wsId);
    return res.json({ status: "ok", data: team });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Master prompt: POST /admin/api/update_workspace */
router.post("/api/update_workspace", requireAuth, requireAdmin, async (req, res) => {
  try {
    const wid = targetWorkspaceId(req);
    const ws = await store.getWorkspace(wid);
    if (!ws) return res.status(404).json({ detail: "Workspace not found" });
    const patch = {};
    if (req.body?.name != null) patch.name = req.body.name;
    if (req.body?.logo_url != null) patch.logo_url = req.body.logo_url;
    if (req.body?.theme_color != null) patch.theme_color = req.body.theme_color;
    const updated = await store.updateWorkspace(wid, patch);
    return res.json({ status: "ok", data: updated });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

router.post("/toggle_ecosystem_visibility", requireAuth, requireAdmin, async (req, res) => {
  try {
    const wid = targetWorkspaceId(req);
    if (req.body?.is_private === undefined) {
      return res.status(400).json({ detail: "is_private boolean required" });
    }
    const updated = await store.updateWorkspace(wid, { is_private: !!req.body.is_private });
    return res.json({ status: "ok", data: updated });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

router.post("/toggle_group_creation", requireAuth, requireAdmin, async (req, res) => {
  try {
    const wid = targetWorkspaceId(req);
    if (req.body?.allow_group_creation === undefined) {
      return res.status(400).json({ detail: "allow_group_creation boolean required" });
    }
    const updated = await store.updateWorkspace(wid, {
      allow_group_creation: !!req.body.allow_group_creation,
    });
    return res.json({ status: "ok", data: updated });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

router.post("/update_team_deployment", requireAuth, requireAdmin, async (req, res) => {
  try {
    const missing = requireFields(req.body, ["team_name"]);
    if (missing) return res.status(400).json({ detail: missing });
    const team = await store.getTeamByName(req.body.team_name);
    if (!team) return res.status(404).json({ detail: "Team not found" });
    const r = (req.user.role || "").toLowerCase();
    if (
      r !== "superadmin" &&
      Number(team.workspace_id) !== Number(req.user.workspace_id)
    ) {
      return res.status(403).json({ detail: "Team not in your workspace" });
    }
    const can_deploy_publicly = !!req.body?.can_deploy_publicly;
    const { supabase } = await import("../database.js");
    const { data, error } = await supabase
      .from("teams")
      .update({ can_deploy_publicly })
      .eq("id", team.id)
      .select()
      .single();
    if (error) throw error;
    return res.json({ status: "ok", data });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

import * as transferService from "../services/transfer_service.js";

router.post("/api/transfer/initiate", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { member_user_id, to_team_name } = req.body;
    if (!member_user_id || !to_team_name) {
      return res.status(400).json({ detail: "member_user_id and to_team_name required" });
    }
    const result = await transferService.initiateTeamTransfer(req.user, member_user_id, to_team_name);
    return res.json({ ok: true, request: result });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

router.get("/api/transfer/pending", requireAuth, requireAdmin, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    const teamRole = (req.user.team_role || "").toLowerCase();
    const isTeamLead = teamRole === "teamlead";
    const wid = req.user.workspace_id || 1;

    let requests = [];
    if (role === "admin" || role === "superadmin") {
      requests = await store.listPendingTransfersInWorkspace(wid);
    } else if (isTeamLead) {
      // Inbound for their team
      requests = await store.listTransferRequestsPendingForTeam(req.user.team_name, wid);
    }
    return res.json({ requests });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

router.post("/api/transfer/respond", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { request_id, decision } = req.body;
    if (!request_id || !decision) {
      return res.status(400).json({ detail: "request_id and decision required" });
    }
    const result = await transferService.processTransferDecision(req.user, request_id, decision);
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

export default router;
