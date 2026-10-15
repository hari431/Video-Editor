CREATE TABLE IF NOT EXISTS video_progress (
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  video_path TEXT NOT NULL,
  progress_seconds NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, video_path)
);

CREATE INDEX IF NOT EXISTS idx_video_progress_video_path ON video_progress(video_path);
