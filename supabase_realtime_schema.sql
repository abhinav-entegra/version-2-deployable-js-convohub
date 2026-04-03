-- Production-ready baseline schema for event-driven realtime chat.
-- Compatible with Supabase Postgres + Realtime publication.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_created_at_desc on public.messages(created_at desc);
create index if not exists idx_messages_room_id on public.messages(room_id);
create index if not exists idx_messages_user_id on public.messages(user_id);
create index if not exists idx_messages_room_created on public.messages(room_id, created_at desc);

alter publication supabase_realtime add table public.messages;

-- Optional row-level security starter policy:
-- alter table public.messages enable row level security;
-- create policy "allow_select_messages" on public.messages for select using (true);
-- create policy "allow_insert_messages" on public.messages for insert with check (true);
