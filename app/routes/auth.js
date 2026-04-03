import express from "express";
import {
  authenticateUser,
  createUser,
  getUserById,
} from "../services/auth_service.js";
import { createAccessTokenFromUser, decodeAccessToken } from "../utils/security.js";
import {
  clearAuthCookies,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  REFRESH,
} from "../utils/auth_cookies.js";
import { ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_DAYS } from "../config.js";
import {
  consumeRefreshToken,
  newRefreshTokenValue,
  revokeAllRefreshTokensForUser,
  storeRefreshToken,
} from "../services/refresh_token_service.js";
import { requireFields, validateEmail } from "../schemas.js";
import { getTokenFromRequest } from "../dependencies.js";

const router = express.Router();

function roleNorm(r) {
  return String(r || "").toLowerCase();
}

async function issueSession(res, user) {
  await revokeAllRefreshTokensForUser(user.id);
  const access = createAccessTokenFromUser(user);
  setAccessTokenCookie(res, access);
  try {
    const raw = newRefreshTokenValue();
    const exp = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
    await storeRefreshToken(user.id, raw, exp);
    setRefreshTokenCookie(res, raw);
  } catch {
    /* optional until DB migration 002 */
  }
  return access;
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    workspace_id: u.workspace_id,
    team_name: u.team_name,
    team_role: u.team_role,
    designation: u.designation,
    profile_pic_url: u.profile_pic_url,
  };
}

router.post("/register", async (req, res) => {
  try {
    const missing = requireFields(req.body, ["email", "password"]);
    if (missing) return res.status(400).json({ detail: missing });
    if (!validateEmail(req.body.email)) {
      return res.status(400).json({ detail: "Invalid email format" });
    }

    /** Public registration is always a member account; admins are promoted in DB or by ops. */
    const user = await createUser(req.body.email, req.body.password, "user", req.body.name || null);
    return res.json({ status: "ok", data: user });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

async function runLogin(req, res, policy) {
  const missing = requireFields(req.body, ["email", "password"]);
  if (missing) return res.status(400).json({ detail: missing });

  const user = await authenticateUser(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ detail: "Invalid email or password" });

  const r = roleNorm(user.role);
  if (policy === "client" && (r === "admin" || r === "superadmin")) {
    return res.status(403).json({
      detail: "Use administrator sign-in for this account.",
      code: "use_admin_portal",
    });
  }
  if (policy === "admin" && r !== "admin" && r !== "superadmin") {
    return res.status(403).json({ detail: "Administrator role required", code: "not_admin" });
  }

  const access = await issueSession(res, user);
  return res.json({
    access_token: access,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    user: publicUser(user),
  });
}

/** Any role — backward compatible */
/** Cookie + optional localStorage sync for home page bootstrap. */
router.get("/session", async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ ok: false });

    const payload = decodeAccessToken(token);
    if (!payload?.sub) return res.status(401).json({ ok: false });

    const uid = Number(payload.sub);
    if (!Number.isFinite(uid)) return res.status(401).json({ ok: false });

    const user = await getUserById(uid);
    if (!user) return res.status(401).json({ ok: false });

    const access = createAccessTokenFromUser(user);
    setAccessTokenCookie(res, access);
    return res.json({
      ok: true,
      user: publicUser(user),
      access_token: access,
    });
  } catch {
    return res.status(401).json({ ok: false });
  }
});

router.post("/login", async (req, res) => {
  try {
    return await runLogin(req, res, "any");
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Member login — rejects workspace admins (use /login/admin). */
router.post("/login/client", async (req, res) => {
  try {
    return await runLogin(req, res, "client");
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Admin / superadmin only */
router.post("/login/admin", async (req, res) => {
  try {
    return await runLogin(req, res, "admin");
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

/** Master-prompt aliases (same as /auth/login/*) */
export async function postLoginClientRoot(req, res) {
  try {
    return await runLogin(req, res, "client");
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
}

export async function postLoginAdminRoot(req, res) {
  try {
    return await runLogin(req, res, "admin");
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
}

router.post("/refresh", async (req, res) => {
  try {
    const raw = req.cookies?.[REFRESH] || req.body?.refresh_token;
    if (!raw) return res.status(401).json({ detail: "No refresh token" });

    const row = await consumeRefreshToken(raw);
    if (!row) {
      clearAuthCookies(res);
      return res.status(401).json({ detail: "Invalid or expired refresh token" });
    }

    const user = await getUserById(row.user_id);
    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ detail: "User not found" });
    }

    const access = createAccessTokenFromUser(user);
    setAccessTokenCookie(res, access);
    const newRaw = newRefreshTokenValue();
    const exp = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
    await storeRefreshToken(user.id, newRaw, exp);
    setRefreshTokenCookie(res, newRaw);

    return res.json({
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    });
  } catch (error) {
    return res.status(400).json({ detail: String(error.message || error) });
  }
});

export async function revokeSession(req, res) {
  const token = getTokenFromRequest(req);
  let uid = null;
  if (token) {
    const p = decodeAccessToken(token);
    if (p?.sub) uid = Number(p.sub);
  }
  clearAuthCookies(res);
  if (Number.isFinite(uid)) {
    await revokeAllRefreshTokensForUser(uid).catch(() => {});
  }
}

router.post("/logout", async (req, res) => {
  await revokeSession(req, res);
  res.json({ ok: true });
});

router.get("/logout", async (req, res) => {
  await revokeSession(req, res);
  res.redirect(302, "/");
});

export default router;
