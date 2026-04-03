import {
  ACCESS_TOKEN_EXPIRE_MINUTES,
  REFRESH_TOKEN_DAYS,
} from "../config.js";

const ACCESS = "access_token";
const REFRESH = "refresh_token";

/** Browsers ignore Set-Cookie with Secure=true on http:// — breaks local login if NODE_ENV=production. */
function cookieSecure() {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false" || process.env.ALLOW_INSECURE_COOKIES === "true") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

export function setAccessTokenCookie(res, token) {
  const maxAge = ACCESS_TOKEN_EXPIRE_MINUTES * 60 * 1000;
  res.cookie(ACCESS, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: cookieSecure(),
  });
}

export function setRefreshTokenCookie(res, rawRefresh) {
  const maxAge = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH, rawRefresh, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge,
    secure: cookieSecure(),
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS, { path: "/" });
  res.clearCookie(REFRESH, { path: "/" });
}

export { ACCESS, REFRESH };
