import dotenv from "dotenv";

dotenv.config();

/** Optional: same as subdomain in SUPABASE_URL (for logs / ops only). */
export const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "";

export const SUPABASE_URL = process.env.SUPABASE_URL;
/** Prefer service role on the server so RLS never blocks org API operations. */
export const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
export const SECRET_KEY = process.env.SECRET_KEY || "supersecret";
export const ALGORITHM = process.env.ALGORITHM || "HS256";
/** Access JWT lifetime (minutes). Spec default: 15. */
export const ACCESS_TOKEN_EXPIRE_MINUTES = Number(
  process.env.ACCESS_TOKEN_EXPIRE_MINUTES || 15
);
/** Short-lived token for Socket.IO / WebSocket auth. */
export const SOCKET_TOKEN_EXPIRE_MINUTES = Number(
  process.env.SOCKET_TOKEN_EXPIRE_MINUTES || 120
);
/** Refresh token cookie lifetime (days). */
export const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 7);

const authDisabledRaw = String(process.env.AUTH_DISABLED ?? "").trim().toLowerCase();
/**
 * When true, page and API routes accept requests without a JWT and attach `GUEST_USER_ID`.
 * Default: off (login required). Set AUTH_DISABLED=1 for local guest mode only.
 */
export const AUTH_DISABLED =
  authDisabledRaw === "1" ||
  authDisabledRaw === "true" ||
  authDisabledRaw === "yes";

/** User row used when AUTH_DISABLED is true and no valid token is present. */
export const GUEST_USER_ID = Number(process.env.GUEST_USER_ID || 1);
