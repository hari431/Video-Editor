-- 018_daily_usage_history.sql — Lightweight daily aggregate usage history
-- No per-request writes: application flushes in-memory aggregates periodically (in-memory metrics remain primary).
-- One row per day, idempotent upsert, no personal data.
-- Safe to re-run: all statements idempotent.

CREATE TABLE IF NOT EXISTS daily_usage_stats (
  day DATE PRIMARY KEY,
  total_requests INT NOT NULL DEFAULT 0,
  count_2xx INT NOT NULL DEFAULT 0,
  count_3xx INT NOT NULL DEFAULT 0,
  count_4xx INT NOT NULL DEFAULT 0,
  count_5xx INT NOT NULL DEFAULT 0,
  total_errors INT NOT NULL DEFAULT 0,
  content_views INT NOT NULL DEFAULT 0,
  pdf_previews INT NOT NULL DEFAULT 0,
  pdf_downloads INT NOT NULL DEFAULT 0,
  response_count INT NOT NULL DEFAULT 0,
  total_response_time_ms BIGINT NOT NULL DEFAULT 0,
  peak_heap_used_mb NUMERIC(6,1) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_stats_day_desc ON daily_usage_stats(day DESC);

COMMENT ON TABLE daily_usage_stats IS 'Daily aggregate usage stats (no per-request writes, one row per day, no PII).';
COMMENT ON COLUMN daily_usage_stats.total_requests IS 'Aggregate total requests for the day';
COMMENT ON COLUMN daily_usage_stats.peak_heap_used_mb IS 'Peak heap used MB observed that day (informational)';
