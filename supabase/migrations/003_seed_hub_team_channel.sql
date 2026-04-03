-- Default team + #general for workspace 1 (dashboard needs at least one channel).
-- Run in Supabase SQL Editor after 001/RUN_ONCE if sidebar is empty.

INSERT INTO teams (name, workspace_id, can_deploy_publicly)
VALUES ('Hub Team', 1, false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO channels (
  name,
  display_name,
  team_name,
  workspace_id,
  visibility,
  post_permission_mode,
  is_private_group
)
VALUES (
  'general',
  'General',
  'Hub Team',
  1,
  'all',
  'all_visible',
  false
)
ON CONFLICT (workspace_id, name) DO NOTHING;

-- Attach existing users in workspace 1 to Hub Team so hub filtering shows #general
UPDATE users
SET team_name = 'Hub Team'
WHERE workspace_id = 1 AND (team_name IS NULL OR TRIM(team_name) = '');
