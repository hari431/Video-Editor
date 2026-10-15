-- 014_recently_viewed.sql — Recently Viewed content per user
-- Tracks the most recently viewed individual content items (not folders) per user.
-- Supports all content types via canonical item_path.
-- Per-user isolation, unique constraint, max 20 history enforced in application logic with DB cleanup.

CREATE TABLE IF NOT EXISTS recently_viewed (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_path TEXT NOT NULL,
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, item_path)
);

-- Efficient lookup by user ordered by most recent
CREATE INDEX IF NOT EXISTS idx_recently_viewed_user_last_viewed ON recently_viewed(user_id, last_viewed_at DESC);
-- Lookup by item path (admin/debug, cleanup)
CREATE INDEX IF NOT EXISTS idx_recently_viewed_item_path ON recently_viewed(item_path);
-- Covering index for user + path uniqueness is already provided by UNIQUE constraint
