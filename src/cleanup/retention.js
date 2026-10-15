// src/cleanup/retention.js — Batched retention cleanup for safe targets
// Never touches users/content_seen/item_likes/active discussions/RBAC/Guidewire content.
// Retention days come only from env (src/config/retention.js). No hardcoded fallbacks.
// Supports dry-run (counts only) and batched DELETE to avoid long locks.
// Idempotent: repeated runs converge to same state.

import { pool } from '../db/pool.js';
import { getRetentionConfig } from '../config/retention.js';

function logResult({ table, operation, cutoff, batchSize, dryRun, total }) {
  const payload = { table, operation, cutoff: cutoff ? cutoff.toISOString() : null, batchSize, dryRun: !!dryRun, count: total };
  console.log(`[retention] ${JSON.stringify(payload)}`);
}

function cutoffForDays(days) {
  if (!Number.isInteger(days) || days <= 0) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Generic batched delete helper using id-range pagination (safe for all tables with BIGINT PK)
// When `select` counts for dry-run, we COUNT(*). When deleting, we loop DELETE WHERE age < cutoff AND id IN (SELECT id ... LIMIT batch)
// Using `id` is indexed; avoids ctid which can be less stable. For daily_usage_stats (PK=day DATE) we use day directly.
// For user_sessions (PK=sid TEXT) we also use key-based pagination but still via subquery on sid.
async function countExpired(client, table, whereClause, params) {
  const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${table} WHERE ${whereClause}`, params);
  return Number(res.rows[0]?.cnt || 0);
}

async function batchedDeleteById({ client, table, idColumn, whereClause, params, batchSize, dryRun }) {
  // whereClause uses $1..$n placeholders; params holds cutoff etc. New $ placeholder for LIMIT is next index.
  if (dryRun) {
    const cnt = await countExpired(client, table, whereClause, params);
    return cnt;
  }
  let total = 0;
  while (true) {
    // Use a subquery to limit delete size: prevents long lock. ORDER BY id ensures deterministic.
    const limitIdx = params.length + 1;
    const sql = `DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${whereClause} ORDER BY ${idColumn} LIMIT $${limitIdx})`;
    const res = await client.query(sql, [...params, batchSize]);
    const deleted = res.rowCount || 0;
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

// --- Per-table cleaners (each: returns { table, count, dryRun, cutoffISO, skipped?, reason? }) ---

async function cleanupUserSessions({ client, batchSize, dryRun }) {
  const table = 'user_sessions';
  const idColumn = 'sid';
  const whereClause = 'expire < NOW()';
  // dryRun: count
  try {
    let total;
    if (dryRun) {
      total = await countExpired(client, table, whereClause, []);
      logResult({ table, operation: 'count_expired_sessions', cutoff: null, batchSize, dryRun, total });
      return { table, count: total, dryRun: true, cutoffISO: null };
    }
    // batched delete
    let deleted = 0;
    while (true) {
      const res = await client.query(`DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${whereClause} LIMIT $1)`, [batchSize]);
      const n = res.rowCount || 0;
      deleted += n;
      if (n < batchSize) break;
    }
    logResult({ table, operation: 'delete_expired_sessions', cutoff: null, batchSize, dryRun: false, total: deleted });
    return { table, count: deleted, dryRun: false, cutoffISO: null };
  } catch (err) {
    // table may not exist in fresh test env
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: err.message };
  }
}

async function cleanupQueryUsage({ client, days, batchSize, dryRun }) {
  const table = 'query_usage';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping query_usage: QUERY_USAGE_RETENTION_DAYS not set or invalid.');
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  const whereClause = 'created_at < $1';
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'id', whereClause, params, batchSize, dryRun });
    logResult({ table, operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table, count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

async function cleanupVideoViews({ client, days, batchSize, dryRun }) {
  const table = 'video_views';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping video_views: VIDEO_VIEWS_RETENTION_DAYS not set or invalid.');
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  const whereClause = 'viewed_at < $1';
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'id', whereClause, params, batchSize, dryRun });
    logResult({ table, operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table, count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

async function cleanupRecentlyViewed({ client, days, batchSize, dryRun }) {
  const table = 'recently_viewed';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping recently_viewed: RECENTLY_VIEWED_RETENTION_DAYS not set or invalid.');
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  const whereClause = 'last_viewed_at < $1';
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'id', whereClause, params, batchSize, dryRun });
    logResult({ table, operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table, count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

async function cleanupDailyUsageStats({ client, days, batchSize, dryRun }) {
  const table = 'daily_usage_stats';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping daily_usage_stats: DAILY_USAGE_STATS_RETENTION_DAYS not set or invalid.');
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  // day is DATE PK, compare to CURRENT_DATE - days
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffISODate = cutoffDate.toISOString().slice(0, 10);
  const whereClause = 'day < $1::date';
  const params = [cutoffISODate];
  // daily_usage_stats PK is `day` (DATE), use `day` as idColumn
  try {
    let total;
    if (dryRun) {
      total = await countExpired(client, table, whereClause, params);
    } else {
      total = 0;
      while (true) {
        const res = await client.query(`DELETE FROM ${table} WHERE day IN (SELECT day FROM ${table} WHERE ${whereClause} ORDER BY day LIMIT $2)`, [cutoffISODate, batchSize]);
        const n = res.rowCount || 0;
        total += n;
        if (n < batchSize) break;
      }
    }
    const cutoff = new Date(cutoffISODate + 'T00:00:00.000Z');
    logResult({ table, operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table, count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: cutoffISODate, skipped: true, reason: err.message };
  }
}

async function cleanupDeletedReplies({ client, days, batchSize, dryRun }) {
  const table = 'discussion_replies';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping discussion_replies (deleted): DELETED_REPLIES_RETENTION_DAYS not set or invalid.');
    return { table: 'discussion_replies(deleted)', count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  const whereClause = "status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < $1";
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'id', whereClause, params, batchSize, dryRun });
    logResult({ table: 'discussion_replies(deleted)', operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table: 'discussion_replies(deleted)', count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] discussion_replies(deleted) cleanup failed: ${err.message}`);
    return { table: 'discussion_replies(deleted)', count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

async function cleanupVideoProtectionSessions({ client, days, batchSize, dryRun }) {
  const table = 'video_protection_sessions';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping video_protection_sessions: VIDEO_PROTECTION_SESSIONS_RETENTION_DAYS not set or invalid.');
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  // last_seen_at (not created_at): idle sessions expire, active ones survive.
  const whereClause = 'last_seen_at < $1';
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'session_code', whereClause, params, batchSize, dryRun });
    logResult({ table, operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table, count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] ${table} cleanup failed: ${err.message}`);
    return { table, count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

async function cleanupDeletedDiscussions({ client, days, batchSize, dryRun }) {
  const table = 'discussions';
  if (!Number.isInteger(days) || days <= 0) {
    console.warn('[retention] Skipping discussions (deleted): DELETED_DISCUSSIONS_RETENTION_DAYS not set or invalid.');
    return { table: 'discussions(deleted)', count: 0, dryRun: !!dryRun, cutoffISO: null, skipped: true, reason: 'invalid_or_missing_retention' };
  }
  const cutoff = cutoffForDays(days);
  const whereClause = "status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < $1";
  const params = [cutoff];
  try {
    const total = await batchedDeleteById({ client, table, idColumn: 'id', whereClause, params, batchSize, dryRun });
    logResult({ table: 'discussions(deleted)', operation: dryRun ? 'count_expired' : 'delete_expired', cutoff, batchSize, dryRun, total });
    return { table: 'discussions(deleted)', count: total, dryRun: !!dryRun, cutoffISO: cutoff.toISOString() };
  } catch (err) {
    console.warn(`[retention] discussions(deleted) cleanup failed: ${err.message}`);
    return { table: 'discussions(deleted)', count: 0, dryRun: !!dryRun, cutoffISO: cutoff.toISOString(), skipped: true, reason: err.message };
  }
}

// Main entry: runs all safe targets in FK-safe order (children before parents).
// user_sessions has no FKs, query_usage/video_views/recently_viewed are independent.
// discussion_replies must be cleaned before discussions (replies have FK discussion_id CASCADE,
// but parent delete would cascade; cleaning replies first avoids relying on cascade and keeps batches explicit).
export async function runRetentionCleanup({ client = pool, config = null, dryRun = null } = {}) {
  const cfg = config || getRetentionConfig();
  // If caller explicitly passes dryRun bool, it overrides cfg.dryRun
  const effectiveDryRun = dryRun !== null && dryRun !== undefined ? !!dryRun : !!cfg.dryRun;

  if (!cfg.enabled) {
    console.log('[retention] Retention cleanup skipped: RETENTION_ENABLED != true');
    return { skipped: true, reason: 'retention_disabled', dryRun: effectiveDryRun, results: [] };
  }

  const batchSize = cfg.batchSize;
  const results = [];

  // 1. Expired sessions (no cutoff days needed, uses expire < NOW())
  results.push(await cleanupUserSessions({ client, batchSize, dryRun: effectiveDryRun }));

  // 2-4. Independent time-series
  results.push(await cleanupQueryUsage({ client, days: cfg.queryUsageDays, batchSize, dryRun: effectiveDryRun }));
  results.push(await cleanupVideoViews({ client, days: cfg.videoViewsDays, batchSize, dryRun: effectiveDryRun }));
  results.push(await cleanupVideoProtectionSessions({ client, days: cfg.videoProtectionSessionsDays, batchSize, dryRun: effectiveDryRun }));
  results.push(await cleanupRecentlyViewed({ client, days: cfg.recentlyViewedDays, batchSize, dryRun: effectiveDryRun }));

  // 5. Daily aggregates
  results.push(await cleanupDailyUsageStats({ client, days: cfg.dailyUsageDays, batchSize, dryRun: effectiveDryRun }));

  // 6. Soft-deleted replies FIRST (child), then discussions (parent) — FK-safe, idempotent
  results.push(await cleanupDeletedReplies({ client, days: cfg.deletedRepliesDays, batchSize, dryRun: effectiveDryRun }));
  results.push(await cleanupDeletedDiscussions({ client, days: cfg.deletedDiscussionsDays, batchSize, dryRun: effectiveDryRun }));

  const summary = {
    dryRun: effectiveDryRun,
    enabled: cfg.enabled,
    batchSize,
    totalDeleted: results.reduce((s, r) => s + (r.skipped ? 0 : (r.count || 0)), 0),
    results,
  };
  console.log(`[retention] Summary ${JSON.stringify({ dryRun: summary.dryRun, enabled: summary.enabled, total: summary.totalDeleted, details: results.map(r => ({ table: r.table, count: r.count, dryRun: r.dryRun, skipped: !!r.skipped })) })}`);
  // Keep log shape consistent: already logged per-table above; summary aids ops.
  return summary;
}

// Export per-table for targeted tests
export {
  cleanupUserSessions,
  cleanupQueryUsage,
  cleanupVideoViews,
  cleanupVideoProtectionSessions,
  cleanupRecentlyViewed,
  cleanupDailyUsageStats,
  cleanupDeletedDiscussions,
  cleanupDeletedReplies,
  cutoffForDays,
};
