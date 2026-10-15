// src/config/retention.js — Retention env parsing (no hardcoded day fallbacks)
//
// Every retention period MUST come from environment. Missing/invalid => skip table (never delete).
// No global DELETE_AFTER_DAYS — each table has its own var.

function parsePositiveIntEnv(name, raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || String(n) !== trimmed) return null;
  // Strict integer check: reject floats/decimals via trimmed comparison
  if (n <= 0) return null;
  return n;
}

function parseRetentionDays(name, raw) {
  const v = parsePositiveIntEnv(name, raw);
  if (v === null) {
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      console.warn(`[retention] Invalid ${name}="${String(raw)}" — must be positive integer days. Skipping cleanup for this table.`);
    }
    return null;
  }
  return v;
}

function parseBatchSize(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 500;
  const trimmed = String(raw).trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
    console.warn(`[retention] Invalid RETENTION_BATCH_SIZE="${String(raw)}" — must be positive integer. Using default 500.`);
    return 500;
  }
  // Cap to avoid absurd batch sizes locking table
  return Math.min(n, 10000);
}

export function getRetentionConfig(env = process.env) {
  const enabledRaw = env.RETENTION_ENABLED;
  const enabled = String(enabledRaw || '').trim().toLowerCase() === 'true';

  const dryRunRaw = env.RETENTION_DRY_RUN;
  const dryRun = String(dryRunRaw || '').trim().toLowerCase() === 'true';

  const batchSize = parseBatchSize(env.RETENTION_BATCH_SIZE);

  const config = {
    enabled,
    dryRun,
    batchSize,
    // Per-table retention days — null means skip cleanup for that table
    queryUsageDays: parseRetentionDays('QUERY_USAGE_RETENTION_DAYS', env.QUERY_USAGE_RETENTION_DAYS),
    videoViewsDays: parseRetentionDays('VIDEO_VIEWS_RETENTION_DAYS', env.VIDEO_VIEWS_RETENTION_DAYS),
    recentlyViewedDays: parseRetentionDays('RECENTLY_VIEWED_RETENTION_DAYS', env.RECENTLY_VIEWED_RETENTION_DAYS),
    dailyUsageDays: parseRetentionDays('DAILY_USAGE_STATS_RETENTION_DAYS', env.DAILY_USAGE_STATS_RETENTION_DAYS),
    deletedDiscussionsDays: parseRetentionDays('DELETED_DISCUSSIONS_RETENTION_DAYS', env.DELETED_DISCUSSIONS_RETENTION_DAYS),
    deletedRepliesDays: parseRetentionDays('DELETED_REPLIES_RETENTION_DAYS', env.DELETED_REPLIES_RETENTION_DAYS),
    videoProtectionSessionsDays: parseRetentionDays('VIDEO_PROTECTION_SESSIONS_RETENTION_DAYS', env.VIDEO_PROTECTION_SESSIONS_RETENTION_DAYS),
  };
  return config;
}

// Helper for scheduler: whether global cleanup should run
export function isRetentionEnabled(env = process.env) {
  return getRetentionConfig(env).enabled === true;
}

// For tests: pure parsers
export { parsePositiveIntEnv, parseRetentionDays, parseBatchSize };
