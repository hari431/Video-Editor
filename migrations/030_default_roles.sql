-- 030_default_roles.sql — Add default_role setting to roles table

ALTER TABLE roles ADD COLUMN IF NOT EXISTS default_role BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN roles.default_role IS 'When enabled, this role is automatically assigned to new pending users upon activation.';
