-- 002: explicit admin-controlled access status + audit log

-- Add an authorization status. Default 'pending' so a user created without an
-- explicit status (or by any future code path) is NOT granted library access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

-- Backfill existing users created under the previous auto-grant model.
-- Every legacy row has access_expires_at set (the old column was NOT NULL), so all
-- existing users are migrated to 'active' with their existing expiry preserved --
-- including users whose expiry is already in the past (they render as Expired).
-- Rows without an expiry (new 'pending' users) are intentionally left 'pending'.
-- Existing expiry dates are NOT modified.
UPDATE users SET status = 'active' WHERE status = 'pending' AND access_expires_at IS NOT NULL;

-- Enforce allowed values at the database level.
-- Extra DEFAULT/no-op constraint guard keeps this migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_status') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_status CHECK (status IN ('pending', 'active', 'revoked'));
  END IF;
END $$;

-- Audit log: records who granted, extended, revoked, or reactivated access, and when.
CREATE TABLE IF NOT EXISTS access_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'extend', 'revoke', 'reactivate')),
  previous_status TEXT,
  new_status TEXT,
  previous_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_audit_log_user_id ON access_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_log_created_at ON access_audit_log(created_at);