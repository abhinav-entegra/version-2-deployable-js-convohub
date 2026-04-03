import { supabase } from "../database.js";

export async function startCall(teamId) {
  const { data, error } = await supabase
    .from("calls")
    .insert([{ team_id: teamId, started_at: new Date().toISOString() }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function endCall(callId) {
  const { data, error } = await supabase
    .from("calls")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", callId)
    .select()
    .single();
  if (error) throw error;
  return data;
}
