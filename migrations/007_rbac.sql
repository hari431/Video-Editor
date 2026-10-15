-- 007_rbac.sql — Role-Based Access Control for folder permissions
--
-- New tables: roles, user_roles, folder_roles
-- Modified:   folder_permissions (adds access_level, drops permission column)
-- Data:       Migrates existing user:<id> entries into roles + user_roles + folder_roles
-- Safe to re-run: all statements are idempotent.

-- ── 1. New tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS folder_roles (
  id          BIGSERIAL PRIMARY KEY,
  folder_path TEXT    NOT NULL,
  role_id     BIGINT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (folder_path, role_id)
);

-- ── 2. Add access_level to folder_permissions ──────────────────────

ALTER TABLE folder_permissions
  ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'all';

DO $$ BEGIN
  ALTER TABLE folder_permissions
    ADD CONSTRAINT folder_permissions_access_level_check
    CHECK (access_level IN ('all', 'admin', 'role'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Migrate existing permission data (only if permission column still exists) ──

DO $$
DECLARE
  rec RECORD;
  role_name TEXT;
  new_role_id BIGINT;
  target_user_id BIGINT;
  has_permission_col BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'folder_permissions' AND column_name = 'permission'
  ) INTO has_permission_col;

  IF NOT has_permission_col THEN
    RETURN;
  END IF;

  -- 'admin' rows → access_level = 'admin'
  UPDATE folder_permissions SET access_level = 'admin' WHERE permission = 'admin';

  -- 'user:<id>' rows → create role, assign user, create folder_roles, set access_level = 'role'
  FOR rec IN SELECT id, folder_path, permission
             FROM folder_permissions
             WHERE permission LIKE 'user:%'
  LOOP
    role_name := 'folder-user-' || rec.permission;
    target_user_id := REPLACE(rec.permission, 'user:', '')::bigint;

    IF NOT EXISTS (SELECT 1 FROM users WHERE id = target_user_id) THEN
      DELETE FROM folder_permissions WHERE id = rec.id;
      CONTINUE;
    END IF;

    INSERT INTO roles (name, description)
    VALUES (role_name, 'Auto-migrated from folder_permissions: ' || rec.permission)
    ON CONFLICT (name) DO NOTHING;

    SELECT id INTO new_role_id FROM roles WHERE name = role_name;

    INSERT INTO user_roles (user_id, role_id)
    VALUES (target_user_id, new_role_id)
    ON CONFLICT (user_id, role_id) DO NOTHING;

    INSERT INTO folder_roles (folder_path, role_id)
    VALUES (rec.folder_path, new_role_id)
    ON CONFLICT (folder_path, role_id) DO NOTHING;

    UPDATE folder_permissions SET access_level = 'role' WHERE id = rec.id;
  END LOOP;

  -- 'all' rows → set access_level = 'all'
  UPDATE folder_permissions SET access_level = 'all' WHERE permission = 'all';

  -- Drop the legacy permission column
  ALTER TABLE folder_permissions DROP COLUMN IF EXISTS permission;
END $$;

-- ── 4. Comments ────────────────────────────────────────────────────

COMMENT ON TABLE  folder_permissions IS 'Per-folder access level (all / admin / role).';
COMMENT ON COLUMN folder_permissions.access_level IS 'all = every authenticated user, admin = admins only, role = check folder_roles for granted role_ids.';
COMMENT ON TABLE  roles IS 'Named roles for RBAC folder access.';
COMMENT ON TABLE  user_roles IS 'User ↔ role assignments (many-to-many).';
COMMENT ON TABLE  folder_roles IS 'Folder ↔ role grants for role-based access.';
