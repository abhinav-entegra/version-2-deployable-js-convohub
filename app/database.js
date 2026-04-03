/**
 * Supabase Postgres client (server-side only).
 * This app does not CREATE/DROP schemas on startup — data persists in your project
 * until you change it in the Supabase SQL editor or Dashboard.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from Supabase → Settings → API) in .env"
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
