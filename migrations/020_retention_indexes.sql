-- 020_retention_indexes.sql — Indexes to support retention cleanup batching
-- video_views.viewed_at had no index; retention WHERE viewed_at < cutoff would seq-scan.
-- Safe to re-run: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_video_views_viewed_at ON video_views(viewed_at);
