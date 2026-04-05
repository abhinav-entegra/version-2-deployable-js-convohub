-- ============================================================
-- supabase_perf_final.sql
-- Run this in Supabase SQL editor (safe to re-run — all idempotent)
-- ============================================================

-- 1. Composite index for channel message history (the most common query)
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts_cover
  ON public.messages (channel_name, timestamp DESC)
  INCLUDE (id, sender_id, content, type, file_path, client_msg_id, is_read)
  WHERE channel_name IS NOT NULL;

-- 2. DM pair indexes (both directions)
CREATE INDEX IF NOT EXISTS idx_messages_dm_fwd
  ON public.messages (sender_id, receiver_id, timestamp DESC)
  WHERE channel_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_dm_rev
  ON public.messages (receiver_id, sender_id, timestamp DESC)
  WHERE channel_name IS NULL;

-- 3. Unread DM count (hit on every sidebar render)
CREATE INDEX IF NOT EXISTS idx_messages_unread_dm
  ON public.messages (receiver_id, is_read, timestamp DESC)
  WHERE channel_name IS NULL AND is_read = 0;

-- 4. client_msg_id dedup (prevents double-inserts from retried sends)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_dedup
  ON public.messages (sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

-- 5. workspace_id scoped channel query
CREATE INDEX IF NOT EXISTS idx_messages_workspace_channel
  ON public.messages (workspace_id, channel_name, timestamp DESC)
  WHERE channel_name IS NOT NULL;

-- 6. Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_unseen
  ON public.notifications (user_id, is_seen, timestamp DESC)
  WHERE is_seen = false;

-- 7. Channel visits (unread badge calculation)
CREATE INDEX IF NOT EXISTS idx_channel_visits_user
  ON public.channel_visits (user_id, channel_name, visited_at DESC);

-- 8. Add client_msg_id column if missing (idempotent)
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS client_msg_id TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'text';
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_path TEXT;

-- 9. Supabase Realtime — DISABLE for messages table if you switched to socket-only delivery.
--    Comment this out if you still want Realtime as a backup.
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;

-- 10. Vacuum + analyze so query planner uses the new indexes immediately
VACUUM ANALYZE public.messages;
VACUUM ANALYZE public.notifications;
VACUUM ANALYZE public.channel_visits;
