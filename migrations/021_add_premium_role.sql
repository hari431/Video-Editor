-- 021_add_premium_role.sql
-- Add PREMIUM to chk_users_app_role constraint on users and update action check on role_audit_log.

-- 1. Alter chk_users_app_role constraint on users
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_app_role;
ALTER TABLE users ADD CONSTRAINT chk_users_app_role CHECK (app_role IN ('OWNER', 'ADMIN', 'USER', 'PREMIUM'));

-- 2. Alter action constraint on role_audit_log
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Find and drop any check constraints on role_audit_log's 'action' column safely
  FOR r IN (
    SELECT conname 
    FROM pg_constraint 
    WHERE conrelid = to_regclass('role_audit_log')
      AND contype = 'c' 
      AND pg_get_constraintdef(oid) LIKE '%action%'
  ) LOOP
    EXECUTE 'ALTER TABLE role_audit_log DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE role_audit_log ADD CONSTRAINT role_audit_log_action_check CHECK (action IN ('grant_admin', 'revoke_admin', 'grant_premium', 'revoke_premium'));
