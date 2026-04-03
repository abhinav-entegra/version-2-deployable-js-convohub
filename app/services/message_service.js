import { supabase } from "../database.js";

export async function sendMessage(teamId, senderId, content) {
  const { data, error } = await supabase
    .from("messages")
    .insert([{ team_id: teamId, sender_id: senderId, content }])
    .select()
    .single();
  if (error) throw error;
  return data;
}
