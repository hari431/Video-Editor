-- 017_content_action_permissions.sql — Configurable Content Action Permissions
-- OWNER / ADMIN always allowed; USER allowed only when explicitly granted.
-- Normalized structure with audit trail.
-- Safe to re-run: all statements idempotent.

CREATE TABLE IF NOT EXISTS content_action_permissions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('COPY_QUERY','DOWNLOAD_PDF')),
  granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_cap_user ON content_action_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_cap_permission ON content_action_permissions(permission);
CREATE INDEX IF NOT EXISTS idx_cap_user_permission ON content_action_permissions(user_id, permission);

CREATE TABLE IF NOT EXISTS content_permission_audit_log (
  id BIGSERIAL PRIMARY KEY,
  target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('COPY_QUERY','DOWNLOAD_PDF')),
  action TEXT NOT NULL CHECK (action IN ('GRANT','REVOKE')),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cpal_target ON content_permission_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS idx_cpal_actor ON content_permission_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_cpal_created ON content_permission_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cpal_permission ON content_permission_audit_log(permission);

COMMENT ON TABLE content_action_permissions IS 'Owner-granted per-user content action permissions (COPY_QUERY, DOWNLOAD_PDF).';
COMMENT ON TABLE content_permission_audit_log IS 'Audit trail for content permission changes (GRANT/REVOKE by Owner).';
