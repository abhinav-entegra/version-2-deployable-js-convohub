import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  ACCESS_TOKEN_EXPIRE_MINUTES,
  ALGORITHM,
  SECRET_KEY,
} from "../config.js";

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

/**
 * Full access token: sub, email, workspace id, role, team_role (master prompt parity).
 */
export function createAccessTokenFromUser(user, expiresMinutes = ACCESS_TOKEN_EXPIRE_MINUTES) {
  const payload = {
    sub: String(user.id),
    email: user.email,
    wid: user.workspace_id != null ? Number(user.workspace_id) : null,
    role: user.role || "user",
    team_role: user.team_role || "",
    typ: "access",
  };
  return jwt.sign(payload, SECRET_KEY, {
    algorithm: ALGORITHM,
    expiresIn: `${expiresMinutes}m`,
  });
}

/** @deprecated Prefer createAccessTokenFromUser when user row is available */
export function createAccessToken(
  subject,
  email = null,
  expiresMinutes = ACCESS_TOKEN_EXPIRE_MINUTES
) {
  return createAccessTokenFromUser(
    {
      id: subject,
      email,
      workspace_id: null,
      role: "user",
      team_role: "",
    },
    expiresMinutes
  );
}

export function decodeAccessToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY, {
      algorithms: [ALGORITHM],
    });
  } catch {
    return null;
  }
}
