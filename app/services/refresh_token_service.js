import crypto from "crypto";
import { supabase } from "../database.js";

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** @param {string} rawRefresh base64url from client */
export async function storeRefreshToken(userId, rawRefresh, expiresAt) {
  const token_hash = hashToken(rawRefresh);
  const { error } = await supabase.from("refresh_tokens").insert([
    {
      user_id: userId,
      token_hash,
      expires_at: expiresAt.toISOString(),
    },
  ]);
  if (error) {
    console.warn("[auth] Could not store refresh token (run supabase migration 002).", error.message);
  }
}

export async function consumeRefreshToken(rawRefresh) {
  const token_hash = hashToken(rawRefresh);
  const { data, error } = await supabase
    .from("refresh_tokens")
    .select("*")
    .eq("token_hash", token_hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  await supabase
    .from("refresh_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", data.id);
  return data;
}

export async function revokeAllRefreshTokensForUser(userId) {
  const { error } = await supabase
    .from("refresh_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) {
    console.warn("[auth] refresh_tokens revoke:", error.message);
  }
}

export function newRefreshTokenValue() {
  return crypto.randomBytes(48).toString("base64url");
}
