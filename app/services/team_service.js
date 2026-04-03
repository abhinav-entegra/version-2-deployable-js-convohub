import { supabase } from "../database.js";

export async function createTeam(name, workspaceId) {
  const { data, error } = await supabase
    .from("teams")
    .insert([{ name, workspace_id: workspaceId }])
    .select()
    .single();
  if (error) throw error;
  return data;
}
