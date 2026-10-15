-- 015_content_seen.sql — Per-user seen state for New / Missed Content notifications
-- Tracks which individual content items (not folders) a user has actually opened.
-- Separate from recently_viewed: recently_viewed is a capped 20-item recency
-- history (evicted), while content_seen is persistent acknowledgement state that
-- must survive across logins until the user opens the item. Never overload
-- recently_viewed for this purpose.
-- Eligibility uses filesystem mtime vs users.first_login_at (see new-content.js).

CREATE TABLE IF NOT EXISTS content_seen (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_path TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, item_path)
);

-- Efficient lookup: all seen paths for a user
CREATE INDEX IF NOT EXISTS idx_content_seen_user ON content_seen(user_id);
-- Lookup by item path (cleanup/debug)
CREATE INDEX IF NOT EXISTS idx_content_seen_item_path ON content_seen(item_path);
-- Covering lookup for user + path membership check
CREATE INDEX IF NOT EXISTS idx_content_seen_user_path ON content_seen(user_id, item_path);
