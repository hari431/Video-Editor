CREATE TABLE IF NOT EXISTS video_protection_events (
  id SERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  item_path TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'video',
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_protection_events_user ON video_protection_events(user_id);
CREATE INDEX IF NOT EXISTS idx_video_protection_events_item ON video_protection_events(item_path);
CREATE INDEX IF NOT EXISTS idx_video_protection_events_type ON video_protection_events(event_type);
CREATE INDEX IF NOT EXISTS idx_video_protection_events_created ON video_protection_events(created_at);
