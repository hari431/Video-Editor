CREATE TABLE IF NOT EXISTS folder_permissions (
  id         BIGSERIAL PRIMARY KEY,
  folder_path TEXT    NOT NULL,
  permission  TEXT    NOT NULL DEFAULT 'all',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (folder_path)
);

COMMENT ON TABLE  folder_permissions IS 'Per-folder access-control overrides.';
COMMENT ON COLUMN folder_permissions.folder_path IS 'Relative path inside queries root (e.g. Internal, Guidewire/Gosu/PC/Config).';

DO $$ BEGIN
  COMMENT ON COLUMN folder_permissions.permission IS 'all = every authenticated user, admin = admins only, user:<id> = single user.';
EXCEPTION WHEN undefined_column THEN NULL;
END $$;
