-- 040_add_last_activity_at.sql — Reliable activity tracking for inactive-user handling
-- last_login_at is only updated on OAuth login; persistent sessions allow continued use without re-login,
-- so a dedicated last_activity_at is required. Throttled to 24h to avoid per-request writes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Backfill safely: do not set existing users to NOW() (would hide truly inactive accounts).
-- Use the most recent timestamp already stored for the user, so no account is immediately considered inactive.
UPDATE users
SET last_activity_at = GREATEST(
  COALESCE(last_login_at, '1970-01-01'::timestamptz),
  COALESCE(updated_at, '1970-01-01'::timestamptz),
  COALESCE(created_at, '1970-01-01'::timestamptz),
  COALESCE(first_login_at, '1970-01-01'::timestamptz)
)
WHERE last_activity_at IS NULL;

-- Index for future inactive-user batch (status != 'active')
CREATE INDEX IF NOT EXISTS idx_users_last_activity_at ON users(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_users_last_activity_at_inactive ON users(last_activity_at) WHERE status != 'active';
