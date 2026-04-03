-- Organization-level chat schema (parity with unified Flask/SQLAlchemy models).
-- Run in Supabase SQL editor or via CLI. Use service role from Node; RLS optional.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Workspaces (id 1 = team hub / special ecosystem in legacy app)
CREATE TABLE IF NOT EXISTS workspaces (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Entegrasources',
  logo_url TEXT,
  theme_color TEXT NOT NULL DEFAULT '#666666',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_private BOOLEAN NOT NULL DEFAULT TRUE,
  creator_id BIGINT,
  allow_group_creation BOOLEAN NOT NULL DEFAULT TRUE
);

-- Users (custom auth; password hashed by app)
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name TEXT,
  profile_pic_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  team_name TEXT,
  team_role TEXT,
  designation TEXT DEFAULT 'SE',
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  dm_allowlist_only BOOLEAN NOT NULL DEFAULT FALSE,
  workspace_id BIGINT REFERENCES workspaces (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_creator_id_fkey;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_creator_id_fkey
  FOREIGN KEY (creator_id) REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_workspace ON users (workspace_id);
CREATE INDEX IF NOT EXISTS idx_users_team_name ON users (team_name);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS teams (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id BIGINT REFERENCES workspaces (id),
  can_deploy_publicly BOOLEAN NOT NULL DEFAULT FALSE,
  logo_url TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  icon_url TEXT,
  team_name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'all',
  workspace_id BIGINT REFERENCES workspaces (id),
  post_permission_mode TEXT NOT NULL DEFAULT 'all_visible',
  is_private_group BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_channel_workspace_name ON channels (workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_channel_workspace_private ON channels (workspace_id, is_private_group);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users (id),
  receiver_id BIGINT REFERENCES users (id),
  channel_name TEXT,
  content TEXT NOT NULL DEFAULT '',
  msg_type TEXT NOT NULL DEFAULT 'text',
  file_path TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_read BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_message_channel_timestamp ON messages (channel_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_message_sender_receiver_timestamp ON messages (sender_id, receiver_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_message_receiver_is_read ON messages (receiver_id, is_read);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'mention',
  is_seen BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_user_timestamp ON notifications (user_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS channel_visits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  channel_name TEXT NOT NULL,
  last_visit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, channel_name)
);

CREATE INDEX IF NOT EXISTS idx_channel_visit_user_channel ON channel_visits (user_id, channel_name);

CREATE TABLE IF NOT EXISTS dm_permissions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  target_id BIGINT NOT NULL REFERENCES users (id),
  UNIQUE (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS group_members (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_member_group_user ON group_members (group_id, user_id);

CREATE TABLE IF NOT EXISTS channel_role_permissions (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  team_role TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, team_role)
);

CREATE INDEX IF NOT EXISTS idx_channel_role_channel_role ON channel_role_permissions (channel_id, team_role);

CREATE TABLE IF NOT EXISTS workspace_access (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id BIGINT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_access_user_workspace ON workspace_access (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_access_workspace_user ON workspace_access (workspace_id, user_id);

CREATE TABLE IF NOT EXISTS member_transfer_requests (
  id BIGSERIAL PRIMARY KEY,
  member_user_id BIGINT NOT NULL REFERENCES users (id),
  from_team_name TEXT NOT NULL,
  to_team_name TEXT NOT NULL,
  workspace_id BIGINT NOT NULL REFERENCES workspaces (id),
  initiator_id BIGINT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolver_id BIGINT REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS transfer_chat_backups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  transfer_request_id BIGINT REFERENCES member_transfer_requests (id),
  from_team_name TEXT NOT NULL,
  to_team_name TEXT NOT NULL,
  workspace_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default workspace (hub) — matches legacy workspace_id = 1 semantics
INSERT INTO workspaces (id, name, is_private, allow_group_creation)
VALUES (1, 'Team Ecosystem', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('workspaces', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM workspaces), 1)
);

-- RLS: enable in Supabase dashboard if you expose anon key to browsers.
-- Node.js should use SUPABASE_SERVICE_ROLE_KEY so policies are not required for server writes.
