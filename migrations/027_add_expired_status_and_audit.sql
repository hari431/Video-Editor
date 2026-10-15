-- 027: Add 'expired' to users.status CHECK constraint and 'expire' to access_audit_log.action CHECK constraint

-- 1. Update users.status check constraint to include 'expired'
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_status;

ALTER TABLE users ADD CONSTRAINT chk_users_status CHECK (status IN ('pending', 'active', 'revoked', 'expired'));

-- 2. Update access_audit_log.action check constraint to include 'expire'
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT conname 
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'access_audit_log' 
      AND c.contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE access_audit_log DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE access_audit_log ADD CONSTRAINT chk_access_audit_log_action CHECK (action IN ('approve', 'extend', 'revoke', 'reactivate', 'expire'));
