-- Idempotent message delivery migration.
-- Run this in Supabase SQL editor before/after app deploy.

alter table public.messages
  add column if not exists client_msg_id text;

create unique index if not exists idx_messages_sender_client_msg_id_unique
  on public.messages (sender_id, client_msg_id)
  where client_msg_id is not null;

create index if not exists idx_messages_client_msg_id
  on public.messages (client_msg_id)
  where client_msg_id is not null;
