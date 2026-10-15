-- Phase 1: Discussion moderation audit + restore support
-- Dedicated audit table for hide/unhide/delete/restore actions
-- Keep existing soft-delete columns (deleted_at, deleted_by) for quick status display,
-- but use audit table as authoritative history.

CREATE TABLE IF NOT EXISTS discussion_moderation_actions (
  id              BIGSERIAL PRIMARY KEY,
  target_type     TEXT NOT NULL CHECK (target_type IN ('question', 'reply')),
  target_id       BIGINT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('delete', 'restore', 'hide', 'unhide')),
  actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discussion_moderation_target ON discussion_moderation_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_discussion_moderation_target_action ON discussion_moderation_actions(target_type, target_id, action);
CREATE INDEX IF NOT EXISTS idx_discussion_moderation_actor ON discussion_moderation_actions(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_discussion_moderation_created ON discussion_moderation_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussion_moderation_target_created ON discussion_moderation_actions(target_type, target_id, created_at DESC);
