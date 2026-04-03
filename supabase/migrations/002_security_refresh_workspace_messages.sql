-- Refresh token rotation, message workspace scope, user updated_at

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_active ON refresh_tokens (token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE messages ADD COLUMN IF NOT EXISTS workspace_id BIGINT REFERENCES workspaces (id);

UPDATE messages m
SET workspace_id = u.workspace_id
FROM users u
WHERE m.sender_id = u.id AND m.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_workspace_channel ON messages (workspace_id, channel_name)
  WHERE channel_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_workspace_ts ON messages (workspace_id, timestamp DESC);
