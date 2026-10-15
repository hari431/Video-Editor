-- 026_role_ads_available.sql — Add ads_available setting to roles table

ALTER TABLE roles ADD COLUMN IF NOT EXISTS ads_available BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN roles.ads_available IS 'When enabled, content protected by this role may show ads to eligible normal/expired users.';
