/**
 * One-off: create or reset a user for local/dev login.
 *
 * Member (client dashboard at /dashboard), email + password both set explicitly:
 *   $env:SEED_EMAIL="abhinav@entegraportal.com"; $env:SEED_PASSWORD="abhinav@entegraportal.com"; $env:SEED_ROLE="user"; node scripts/ensure-login-user.mjs
 *
 * Admin example:
 *   $env:SEED_EMAIL="abhinav.entegrasources@gmail.com"; $env:SEED_PASSWORD="Hero@hero0012"; $env:SEED_ROLE="superadmin"; node scripts/ensure-login-user.mjs
 * Sign in at http://localhost:8000/admin/login for admin/superadmin.
 *
 * If SEED_PASSWORD is omitted, SEED_EMAIL is used as password.
 * SEED_ROLE: user | admin | superadmin (default user)
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const email = (process.env.SEED_EMAIL || "").trim().toLowerCase();
const password = (process.env.SEED_PASSWORD || process.env.SEED_EMAIL || "").trim();
const roleRaw = (process.env.SEED_ROLE || "user").trim().toLowerCase();
const role = ["superadmin", "admin", "user"].includes(roleRaw) ? roleRaw : "user";

if (!email || !password) {
  console.error("Set SEED_EMAIL (and optionally SEED_PASSWORD).");
  process.exit(1);
}
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const hash = await bcrypt.hash(password, 10);

const { data: existing, error: selErr } = await supabase
  .from("users")
  .select("id")
  .eq("email", email)
  .maybeSingle();

if (selErr) {
  console.error(selErr);
  process.exit(1);
}

const row = {
  email,
  password: hash,
  role,
  workspace_id: 1,
  team_name: "Hub Team",
};

if (existing) {
  const { error } = await supabase.from("users").update(row).eq("id", existing.id);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log("Updated user:", email);
} else {
  const { error } = await supabase.from("users").insert([row]);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log("Created user:", email);
}

console.log("Role:", role);
console.log("Member: http://localhost:8000/  |  Admin: http://localhost:8000/admin/login");
