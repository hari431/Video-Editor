// src/monitoring/history.js — Phase 4 lightweight daily aggregate persistence
// No per-request DB writes. Relies on Phase 1 in-memory metrics, flushed periodically.
// One row per day, idempotent upsert, no PII, resilient to restarts (delta-based).

import { pool } from '../db/pool.js';
import { getMetrics } from './metrics.js';

// Track what we have already flushed to compute deltas.
// Reset on process start; after restart deltas are computed against 0, correctly adding only new activity.
let lastFlushed = {
  total_requests: 0,
  count_2xx: 0,
  count_3xx: 0,
  count_4xx: 0,
  count_5xx: 0,
  total_errors: 0,
  content_views: 0,
  pdf_previews: 0,
  pdf_downloads: 0,
  response_count: 0,
  total_response_time_ms: 0
};

export function resetFlushState() {
  lastFlushed = {
    total_requests: 0,
    count_2xx: 0,
    count_3xx: 0,
    count_4xx: 0,
    count_5xx: 0,
    total_errors: 0,
    content_views: 0,
    pdf_previews: 0,
    pdf_downloads: 0,
    response_count: 0,
    total_response_time_ms: 0
  };
}

function delta(current, previous) {
  // If current < previous due to resetMetrics or process restart handling, treat delta as current (no negative).
  if (current < previous) return current;
  return current - previous;
}

export function computeDeltas(metrics) {
  const m = metrics || getMetrics();
  return {
    total_requests: delta(m.requests.total, lastFlushed.total_requests),
    count_2xx: delta(m.requests.byStatus['2xx'], lastFlushed.count_2xx),
    count_3xx: delta(m.requests.byStatus['3xx'], lastFlushed.count_3xx),
    count_4xx: delta(m.requests.byStatus['4xx'], lastFlushed.count_4xx),
    count_5xx: delta(m.requests.byStatus['5xx'], lastFlushed.count_5xx),
    total_errors: delta(m.errors.total, lastFlushed.total_errors),
    content_views: delta(m.content.views, lastFlushed.content_views),
    pdf_previews: delta(m.content.pdfPreviews, lastFlushed.pdf_previews),
    pdf_downloads: delta(m.content.pdfDownloads, lastFlushed.pdf_downloads),
    response_count: delta(m.responseTime.count, lastFlushed.response_count),
    total_response_time_ms: delta(Math.round(m.responseTime.totalMs), lastFlushed.total_response_time_ms),
    peak_heap_used_mb: Number(m.heapUsedMb) || 0
  };
}

function isZeroDelta(d) {
  return d.total_requests === 0 && d.count_2xx === 0 && d.count_3xx === 0 && d.count_4xx === 0 && d.count_5xx === 0
    && d.total_errors === 0 && d.content_views === 0 && d.pdf_previews === 0 && d.pdf_downloads === 0
    && d.response_count === 0 && d.total_response_time_ms === 0;
}

export async function flushDailyUsage() {
  let metrics;
  try {
    metrics = getMetrics();
  } catch {
    return { flushed: false, reason: 'no_metrics' };
  }
  const d = computeDeltas(metrics);
  // If no activity delta and no meaningful heap to update, skip DB write to stay lightweight.
  // However we still want to ensure heap peak is updated even if other deltas zero? We check if heap is 0 skip.
  // If zero delta, we still want to avoid unnecessary writes.
  if (isZeroDelta(d)) {
    // Still update lastFlushed heap? No, heap peak is not delta-based, so we only flush if there's activity.
    // To avoid empty rows for idle days, skip.
    return { flushed: false, reason: 'no_delta', deltas: d };
  }

  const sql = `
    INSERT INTO daily_usage_stats (
      day, total_requests, count_2xx, count_3xx, count_4xx, count_5xx, total_errors,
      content_views, pdf_previews, pdf_downloads, response_count, total_response_time_ms, peak_heap_used_mb
    ) VALUES (
      CURRENT_DATE, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
    ) ON CONFLICT (day) DO UPDATE SET
      total_requests = daily_usage_stats.total_requests + EXCLUDED.total_requests,
      count_2xx = daily_usage_stats.count_2xx + EXCLUDED.count_2xx,
      count_3xx = daily_usage_stats.count_3xx + EXCLUDED.count_3xx,
      count_4xx = daily_usage_stats.count_4xx + EXCLUDED.count_4xx,
      count_5xx = daily_usage_stats.count_5xx + EXCLUDED.count_5xx,
      total_errors = daily_usage_stats.total_errors + EXCLUDED.total_errors,
      content_views = daily_usage_stats.content_views + EXCLUDED.content_views,
      pdf_previews = daily_usage_stats.pdf_previews + EXCLUDED.pdf_previews,
      pdf_downloads = daily_usage_stats.pdf_downloads + EXCLUDED.pdf_downloads,
      response_count = daily_usage_stats.response_count + EXCLUDED.response_count,
      total_response_time_ms = daily_usage_stats.total_response_time_ms + EXCLUDED.total_response_time_ms,
      peak_heap_used_mb = GREATEST(daily_usage_stats.peak_heap_used_mb, EXCLUDED.peak_heap_used_mb),
      updated_at = NOW()
  `;

  const params = [
    d.total_requests, d.count_2xx, d.count_3xx, d.count_4xx, d.count_5xx, d.total_errors,
    d.content_views, d.pdf_previews, d.pdf_downloads, d.response_count, d.total_response_time_ms, d.peak_heap_used_mb
  ];

  try {
    await pool.query(sql, params);
  } catch (err) {
    // If table does not exist yet (migration not run), fail gracefully — in-memory metrics remain primary.
    return { flushed: false, reason: 'db_error', error: err.message, deltas: d };
  }

  // Update lastFlushed to current snapshot after successful persist.
  lastFlushed = {
    total_requests: metrics.requests.total,
    count_2xx: metrics.requests.byStatus['2xx'],
    count_3xx: metrics.requests.byStatus['3xx'],
    count_4xx: metrics.requests.byStatus['4xx'],
    count_5xx: metrics.requests.byStatus['5xx'],
    total_errors: metrics.errors.total,
    content_views: metrics.content.views,
    pdf_previews: metrics.content.pdfPreviews,
    pdf_downloads: metrics.content.pdfDownloads,
    response_count: metrics.responseTime.count,
    total_response_time_ms: Math.round(metrics.responseTime.totalMs)
  };

  return { flushed: true, deltas: d, day: new Date().toISOString().slice(0, 10) };
}

export async function getDailyHistory(limit = 30) {
  const capped = Math.min(Math.max(Number(limit) || 30, 1), 90);
  try {
    const result = await pool.query(
      `SELECT day, total_requests, count_2xx, count_3xx, count_4xx, count_5xx, total_errors,
              content_views, pdf_previews, pdf_downloads, response_count, total_response_time_ms,
              peak_heap_used_mb, created_at, updated_at
       FROM daily_usage_stats
       ORDER BY day DESC
       LIMIT $1`,
      [capped]
    );
    return result.rows.map(r => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      total_requests: Number(r.total_requests),
      count_2xx: Number(r.count_2xx),
      count_3xx: Number(r.count_3xx),
      count_4xx: Number(r.count_4xx),
      count_5xx: Number(r.count_5xx),
      total_errors: Number(r.total_errors),
      content_views: Number(r.content_views),
      pdf_previews: Number(r.pdf_previews),
      pdf_downloads: Number(r.pdf_downloads),
      response_count: Number(r.response_count),
      total_response_time_ms: Number(r.total_response_time_ms),
      avg_response_ms: Number(r.response_count) > 0 ? Number(r.total_response_time_ms) / Number(r.response_count) : null,
      peak_heap_used_mb: Number(r.peak_heap_used_mb),
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  } catch {
    return [];
  }
}

// Periodic flush helper — lightweight interval, not per-request.
let intervalHandle = null;

export function scheduleDailyFlush(intervalMs = 5 * 60 * 1000) {
  if (intervalHandle) return intervalHandle;
  // Do not schedule in test env to keep tests deterministic.
  if (process.env.NODE_ENV === 'test') return null;
  intervalHandle = setInterval(() => {
    flushDailyUsage().catch(() => {});
  }, intervalMs);
  // Allow process to exit even if interval is active.
  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

export function stopDailyFlush() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
