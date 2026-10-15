-- 004_video_views_likes.sql
-- Migration to add video views and likes tracking

-- video_views table: tracks individual video view events
-- Deduplication: one view per user per 24-hour window
-- viewed_at records when the view occurred
-- The 24-hour window is enforced by the recordView() function, not by a UNIQUE constraint.
-- Without the UNIQUE constraint, the same user can count another view after 24 hours have passed.
CREATE TABLE IF NOT EXISTS video_views (
  id BIGSERIAL PRIMARY KEY,
  video_path TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying views by video
CREATE INDEX IF NOT EXISTS idx_video_views_video_path ON video_views(video_path);
CREATE INDEX IF NOT EXISTS idx_video_views_user_id ON video_views(user_id);

/* video_likes table: tracks user likes on videos */
CREATE TABLE IF NOT EXISTS video_likes (
  id BIGSERIAL PRIMARY KEY,
  video_path TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_path, user_id)
);

-- Index for querying likes by video
CREATE INDEX IF NOT EXISTS idx_video_likes_video_path ON video_likes(video_path);
/* Index for querying likes by user */
CREATE INDEX IF NOT EXISTS idx_video_likes_user_id ON video_likes(user_id);