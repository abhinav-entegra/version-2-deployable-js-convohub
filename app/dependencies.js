import { getUserById } from "./services/auth_service.js";
import { decodeAccessToken } from "./utils/security.js";
import { AUTH_DISABLED, GUEST_USER_ID } from "./config.js";

function getBearerToken(authHeader) {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/** Bearer header OR HttpOnly cookie (same as Flask session for /api/*). */
export function getTokenFromRequest(req) {
  const bearer = getBearerToken(req.headers.authorization);
  if (bearer) return bearer;
  const c = req.cookies?.access_token;
  if (c && typeof c === "string") return c;
  return null;
}

/** Valid JWT or, when AUTH_DISABLED, guest user. */
export async function attachUserFromRequest(req) {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = decodeAccessToken(token);
      if (payload?.sub) {
        const uid = Number(payload.sub);
        if (Number.isFinite(uid)) {
          const user = await getUserById(uid);
          if (user) {
            req.user = user;
            return true;
          }
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (AUTH_DISABLED) {
    const user = await getUserById(GUEST_USER_ID);
    if (user) {
      req.user = user;
      return true;
    }
  }
  return false;
}

export async function requireAuth(req, res, next) {
  try {
    const ok = await attachUserFromRequest(req);
    if (!ok) return res.status(401).json({ detail: "Missing authorization token" });
    return next();
  } catch (error) {
    return res.status(401).json({ detail: "Unauthorized", error: String(error) });
  }
}

export function requireAdmin(req, res, next) {
  const r = (req.user?.role || "").toLowerCase();
  if (!req.user || (r !== "admin" && r !== "superadmin")) {
    return res.status(403).json({ detail: "Admin role required" });
  }
  return next();
}

export function requireSuperAdmin(req, res, next) {
  const r = (req.user?.role || "").toLowerCase();
  if (!req.user || r !== "superadmin") {
    return res.status(403).json({ detail: "Superadmin role required" });
  }
  return next();
}

export function requireClient(req, res, next) {
  if (!req.user) {
    return res.status(403).json({ detail: "Client role required" });
  }
  const r = (req.user.role || "").toLowerCase();
  if (["user", "admin", "superadmin"].includes(r)) {
    return next();
  }
  return res.status(403).json({ detail: "Client role required" });
}
