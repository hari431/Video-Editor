-- 044_reviews_premium_knowledge.sql
-- Restricted Reviews / Premium Knowledge folder for explicitly assigned users.
--
-- The folder is intentionally role-restricted and the dedicated role starts
-- with no user assignments. Administrators retain the existing admin bypass.
-- Access is then granted only to selected users through /admin/folders.

INSERT INTO roles (name, description)
VALUES (
  'Reviews - Premium Knowledge',
  'Restricted access role for Reviews/Premium Knowledge content.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO folder_permissions (folder_path, access_level)
VALUES ('Reviews/Premium Knowledge', 'role')
ON CONFLICT (folder_path)
DO UPDATE SET access_level = 'role';

INSERT INTO folder_roles (folder_path, role_id)
SELECT 'Reviews/Premium Knowledge', id
FROM roles
WHERE name = 'Reviews - Premium Knowledge'
ON CONFLICT (folder_path, role_id) DO NOTHING;

COMMENT ON TABLE folder_roles IS
  'Folder ↔ role grants for role-based access. Reviews/Premium Knowledge uses an explicit dedicated role.';
