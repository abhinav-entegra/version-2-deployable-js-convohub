/**
 * Idempotent seed: teams + directory users for admin “Admins & team leads” demo.
 *
 *   node scripts/seed-admin-directory.mjs
 *
 * Requires .env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY).
 * Optional: SEED_ABC_PASSWORD (default TempAbc123!) for abc@gmail.com when creating.
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
const abcPw = (process.env.SEED_ABC_PASSWORD || "TempAbc123!").trim();

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const WS = 1;

async function ensureTeam(name) {
  const { data: ex, error: sErr } = await supabase.from("teams").select("id").eq("name", name).maybeSingle();
  if (sErr) throw sErr;
  if (ex) return;
  const { error } = await supabase.from("teams").insert([{ name, workspace_id: WS }]);
  if (error) throw error;
  console.log("Created team:", name);
}

/**
 * @param {object} spec
 * @param {string} spec.email
 * @param {string} [spec.password] — required when creating a new user
 * @param {string} spec.role
 * @param {string} spec.team_name
 * @param {string} spec.team_role
 * @param {string} [spec.name]
 */
async function upsertUser(spec) {
  const email = String(spec.email).trim().toLowerCase();
  const row = {
    email,
    role: spec.role,
    team_name: spec.team_name,
    team_role: spec.team_role,
    workspace_id: WS,
    updated_at: new Date().toISOString(),
  };
  if (spec.name != null && spec.name !== "") row.name = spec.name;

  const { data: existing, error: selErr } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabase.from("users").update(row).eq("id", existing.id);
    if (error) throw error;
    console.log("Updated user:", email);
    return;
  }

  const plain = spec.password;
  if (!plain || String(plain).length < 6) {
    throw new Error(`password required (min 6 chars) to create ${email}`);
  }
  row.password = await bcrypt.hash(String(plain), 10);
  const { error } = await supabase.from("users").insert([row]);
  if (error) throw error;
  console.log("Created user:", email);
}

await ensureTeam("abc");
await ensureTeam("Sales Alpha Core");

await upsertUser({
  email: "abhinav.entegrasources@gmail.com",
  role: "superadmin",
  team_name: "Sales Alpha Core",
  team_role: "member",
  name: "Abhinav Superadmin",
});

await upsertUser({
  email: "abhinav@entegraportal.com",
  role: "user",
  team_name: "abc",
  team_role: "teamlead",
  name: "Abhinav Team lead",
});

await upsertUser({
  email: "abc@gmail.com",
  password: abcPw,
  role: "user",
  team_name: "abc",
  team_role: "teamlead",
  name: "Abc Team lead",
});

console.log("Done. abc@gmail.com password:", abcPw);
console.log("Admin: /admin/login  |  Member: /");
