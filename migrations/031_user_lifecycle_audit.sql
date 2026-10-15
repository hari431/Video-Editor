-- 031_user_lifecycle_audit.sql
-- Expand access_audit_log for User Lifecycle Auditing:
-- 1. Support additional lifecycle actions ('register', 'activate', 'default_roles_assigned', 'delete')
-- 2. Make user_id nullable and set ON DELETE SET NULL to preserve audit history on user deletion
-- 3. Add target_email and details columns for persistent audit context

-- 1. Drop existing action check constraint and add expanded constraint
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

ALTER TABLE access_audit_log ADD CONSTRAINT chk_access_audit_log_action CHECK (
  action IN ('approve', 'extend', 'revoke', 'reactivate', 'expire', 'register', 'activate', 'default_roles_assigned', 'delete')
);

-- 2. Make user_id nullable so audit records survive user deletion
ALTER TABLE access_audit_log ALTER COLUMN user_id DROP NOT NULL;

-- 3. Update foreign key on user_id to ON DELETE SET NULL instead of CASCADE
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT conname 
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'access_audit_log' 
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) LIKE '%user_id%'
  LOOP
    EXECUTE 'ALTER TABLE access_audit_log DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE access_audit_log ADD CONSTRAINT fk_access_audit_log_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- 4. Add target_email and details columns
ALTER TABLE access_audit_log ADD COLUMN IF NOT EXISTS target_email TEXT;
ALTER TABLE access_audit_log ADD COLUMN IF NOT EXISTS details TEXT;

CREATE INDEX IF NOT EXISTS idx_access_audit_log_action ON access_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_access_audit_log_target_email ON access_audit_log(target_email);
