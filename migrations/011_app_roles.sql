-- 011_app_roles.sql — Database-backed OWNER / ADMIN / USER hierarchy
-- Adds app_role column, single OWNER enforcement, and role audit log.
-- Safe to re-run: all statements idempotent.

-- 1. Add app_role column (default USER)
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_role TEXT NOT NULL DEFAULT 'USER';

-- 2. Enforce allowed values
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_app_role') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_app_role CHECK (app_role IN ('OWNER','ADMIN','USER'));
  END IF;
END $$;

-- 3. Ensure at most one OWNER (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(app_role) WHERE app_role = 'OWNER';

-- 4. Index for role lookups
CREATE INDEX IF NOT EXISTS idx_users_app_role ON users(app_role);

-- 5. Backfill: migrate existing accounts deterministically.
-- OWNER is the known existing Owner account: muniharikumar@gmail.com (the sole ADMIN_EMAILS entry).
-- Do NOT use "first matching row" or ORDER BY id — the Owner must be identified by email.
-- Existing permanent admins (status='active' AND access_expires_at IS NULL) that are not the Owner become ADMIN.
-- Ordinary users (pending / active with expiry / revoked) remain USER.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='app_role') THEN
    RETURN;
  END IF;

  -- Deterministically promote the existing Owner account to OWNER (idempotent)
  UPDATE users SET app_role = 'OWNER', updated_at = NOW()
  WHERE lower(email) = lower('muniharikumar@gmail.com')
    AND app_role != 'OWNER';

  -- Promote any other permanent admin accounts to ADMIN (idempotent, leaves USER untouched)
  -- Only rows that are still USER and match the permanent-admin shape (active + NULL expiry) are promoted.
  -- This preserves ADMIN where appropriate and never promotes ordinary users.
  UPDATE users SET app_role = 'ADMIN', updated_at = NOW()
  WHERE lower(email) != lower('muniharikumar@gmail.com')
    AND status = 'active' AND access_expires_at IS NULL
    AND app_role = 'USER';
END $$;

-- 6. Role audit log (who changed whom, when)
CREATE TABLE IF NOT EXISTS role_audit_log (
  id BIGSERIAL PRIMARY KEY,
  target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  previous_role TEXT,
  new_role TEXT,
  action TEXT NOT NULL CHECK (action IN ('grant_admin','revoke_admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_audit_target ON role_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS idx_role_audit_actor ON role_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_role_audit_created ON role_audit_log(created_at DESC);

COMMENT ON TABLE role_audit_log IS 'Audit trail for Owner-only role changes (grant/revoke ADMIN).';
COMMENT ON COLUMN users.app_role IS 'Application role: OWNER (single), ADMIN (multiple), USER (default).';
