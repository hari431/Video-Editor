-- Migration 042: replace per-event video protection rows with a lightweight
-- session mapping (one row per 8-character watermark session code).
-- The detailed video_protection_events trail is intentionally dropped:
-- signals now drive client-side behavior only and are never persisted.

CREATE TABLE IF NOT EXISTS video_protection_sessions (
  session_code TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_protection_sessions_user ON video_protection_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_video_protection_sessions_last_seen ON video_protection_sessions(last_seen_at);

DROP TABLE IF EXISTS video_protection_events;
