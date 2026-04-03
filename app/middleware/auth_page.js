import { attachUserFromRequest } from "../dependencies.js";

function isAdminLoginPath(req) {
  const p = req.path || "";
  const base = String(req.originalUrl || "").split("?")[0];
  return p === "/admin/login" || base === "/admin/login";
}

function redirectUnauthenticated(req, res) {
  const adminArea =
    (req.path.startsWith("/admin") || String(req.originalUrl || "").startsWith("/admin")) &&
    !isAdminLoginPath(req);
  res.redirect(302, adminArea ? "/admin/login" : "/");
}

/**
 * Browser navigation: redirect to login pages if not authenticated (instead of JSON 401).
 */
export async function requireAuthPage(req, res, next) {
  try {
    const ok = await attachUserFromRequest(req);
    if (!ok) {
      return redirectUnauthenticated(req, res);
    }
    return next();
  } catch {
    return redirectUnauthenticated(req, res);
  }
}

/** After requireAuthPage — workspace admin / superadmin only. */
export function requireAdminPage(req, res, next) {
  const r = (req.user?.role || "").toLowerCase();
  if (r !== "admin" && r !== "superadmin") {
    return res.redirect(302, "/dashboard");
  }
  return next();
}

/** Member workspace only (not admin / superadmin portal). */
export function requireClientPage(req, res, next) {
  const r = (req.user?.role || "").toLowerCase();
  if (r === "admin" || r === "superadmin") {
    return res.redirect(302, "/admin/dashboard");
  }
  return next();
}
