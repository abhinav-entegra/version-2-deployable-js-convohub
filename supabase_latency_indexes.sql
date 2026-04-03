-- Performance indexes for the current app schema/query patterns.
-- Run in Supabase SQL editor.

create index if not exists idx_messages_workspace_channel_ts
  on public.messages (workspace_id, channel_name, timestamp desc);

create index if not exists idx_messages_dm_pair_ts_sender_receiver
  on public.messages (sender_id, receiver_id, timestamp desc)
  where channel_name is null;

create index if not exists idx_messages_dm_pair_ts_receiver_sender
  on public.messages (receiver_id, sender_id, timestamp desc)
  where channel_name is null;

create index if not exists idx_messages_receiver_unread_dm
  on public.messages (receiver_id, is_read, timestamp desc)
  where channel_name is null;

create index if not exists idx_messages_channel_ts
  on public.messages (channel_name, timestamp desc);

create index if not exists idx_channel_visits_user_channel
  on public.channel_visits (user_id, channel_name);

create index if not exists idx_notifications_user_seen_ts
  on public.notifications (user_id, is_seen, timestamp desc);
