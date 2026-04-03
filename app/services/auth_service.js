import { supabase } from "../database.js";
import { decryptUserRow, encryptMaybe } from "../utils/field_crypto.js";
import { hashPassword, verifyPassword } from "../utils/security.js";

export async function createUser(email, password, role = "user", name = null) {
  const hashed = await hashPassword(password);
  const row = {
    email: String(email).trim().toLowerCase(),
    password: hashed,
    role: role === "client" ? "user" : role,
    workspace_id: 1,
    team_name: "Hub Team",
  };
  if (name) row.name = encryptMaybe(name);
  const { data, error } = await supabase.from("users").insert([row]).select().single();

  if (error) throw error;
  return decryptUserRow(data);
}

export async function getUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", normalized)
    .maybeSingle();
  if (error) throw error;
  return data ? decryptUserRow(data) : null;
}

export async function authenticateUser(email, password) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  const isValid = await verifyPassword(password, user.password || "");
  if (!isValid) return null;
  return user;
}

export async function getUserById(id) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? decryptUserRow(data) : null;
}

/** Admin invite: full row insert with optional encrypted display name. */
export async function createInvitedUserRow({
  email,
  password,
  role,
  team_role,
  team_name,
  workspace_id,
  name,
}) {
  const hashed = await hashPassword(String(password));
  const row = {
    email: String(email).trim().toLowerCase(),
    password: hashed,
    role: role || "user",
    workspace_id: Number(workspace_id) || 1,
    team_name: team_name && String(team_name).trim() ? String(team_name).trim() : null,
    team_role: team_role && String(team_role).trim() ? String(team_role).trim() : null,
    updated_at: new Date().toISOString(),
  };
  if (name != null && String(name).trim()) row.name = encryptMaybe(String(name).trim());
  const { data, error } = await supabase.from("users").insert([row]).select().single();
  if (error) throw error;
  return decryptUserRow(data);
}
