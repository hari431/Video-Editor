-- Enable nested replies and track likes for discussions/replies separately
ALTER TABLE discussion_replies ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES discussion_replies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_discussion_replies_parent_id ON discussion_replies (parent_id);

CREATE TABLE IF NOT EXISTS discussion_likes (
  discussion_id BIGINT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (discussion_id, user_id)
);

CREATE TABLE IF NOT EXISTS reply_likes (
  reply_id BIGINT NOT NULL REFERENCES discussion_replies(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reply_id, user_id)
);
