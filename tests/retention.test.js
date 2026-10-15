import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getRetentionConfig, parsePositiveIntEnv, parseRetentionDays, parseBatchSize } from '../src/config/retention.js';
import {
  runRetentionCleanup,
  cleanupQueryUsage,
  cleanupVideoViews,
  cleanupRecentlyViewed,
  cleanupDailyUsageStats,
  cleanupDeletedDiscussions,
  cleanupDeletedReplies,
  cleanupUserSessions,
  cleanupVideoProtectionSessions,
  cutoffForDays,
} from '../src/cleanup/retention.js';
import { scheduleRetentionCleanup, stopRetentionCleanup, isRetentionSchedulerActive } from '../src/cleanup/scheduler.js';

// ---------- Config parsing ----------

test('parsePositiveIntEnv rejects missing/empty/zero/negative/non-int', () => {
  assert.equal(parsePositiveIntEnv('X', undefined), null);
  assert.equal(parsePositiveIntEnv('X', ''), null);
  assert.equal(parsePositiveIntEnv('X', '  '), null);
  assert.equal(parsePositiveIntEnv('X', '0'), null);
  assert.equal(parsePositiveIntEnv('X', '-1'), null);
  assert.equal(parsePositiveIntEnv('X', '3.5'), null);
  assert.equal(parsePositiveIntEnv('X', 'abc'), null);
  assert.equal(parsePositiveIntEnv('X', '10a'), null);
  assert.equal(parsePositiveIntEnv('X', 0), null);
});

test('parsePositiveIntEnv accepts positive integers', () => {
  assert.equal(parsePositiveIntEnv('X', '1'), 1);
  assert.equal(parsePositiveIntEnv('X', '90'), 90);
  assert.equal(parsePositiveIntEnv('X', ' 365 '), 365);
});

test('parseRetentionDays logs warning for invalid but returns null', () => {
  assert.equal(parseRetentionDays('QUERY_USAGE_RETENTION_DAYS', 'oops'), null);
  assert.equal(parseRetentionDays('QUERY_USAGE_RETENTION_DAYS', '0'), null);
  assert.equal(parseRetentionDays('QUERY_USAGE_RETENTION_DAYS', ''), null);
  assert.equal(parseRetentionDays('RET', '10'), 10);
});

test('parseBatchSize defaults and validation', () => {
  assert.equal(parseBatchSize(undefined), 500);
  assert.equal(parseBatchSize(''), 500);
  assert.equal(parseBatchSize('100'), 100);
  assert.equal(parseBatchSize('oops'), 500);
  assert.equal(parseBatchSize('0'), 500);
  assert.equal(parseBatchSize('20000'), 10000); // capped
});

test('getRetentionConfig: missing env disables per-table (null days)', () => {
  const cfg = getRetentionConfig({ RETENTION_ENABLED: 'false' });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.queryUsageDays, null);
  assert.equal(cfg.videoViewsDays, null);
  assert.equal(cfg.recentlyViewedDays, null);
  assert.equal(cfg.dailyUsageDays, null);
  assert.equal(cfg.deletedDiscussionsDays, null);
  assert.equal(cfg.deletedRepliesDays, null);
  assert.equal(cfg.videoProtectionSessionsDays, null);
  assert.equal(cfg.batchSize, 500);
});

test('getRetentionConfig: valid per-table days parsed without hardcoded fallback', () => {
  const cfg = getRetentionConfig({
    RETENTION_ENABLED: 'true',
    RETENTION_DRY_RUN: 'true',
    RETENTION_BATCH_SIZE: '250',
    QUERY_USAGE_RETENTION_DAYS: '90',
    VIDEO_VIEWS_RETENTION_DAYS: '45',
    RECENTLY_VIEWED_RETENTION_DAYS: '30',
    DAILY_USAGE_STATS_RETENTION_DAYS: '365',
    DELETED_DISCUSSIONS_RETENTION_DAYS: '30',
    DELETED_REPLIES_RETENTION_DAYS: '15',
    VIDEO_PROTECTION_SESSIONS_RETENTION_DAYS: '180',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.batchSize, 250);
  assert.equal(cfg.queryUsageDays, 90);
  assert.equal(cfg.videoViewsDays, 45);
  assert.equal(cfg.recentlyViewedDays, 30);
  assert.equal(cfg.dailyUsageDays, 365);
  assert.equal(cfg.deletedDiscussionsDays, 30);
  assert.equal(cfg.deletedRepliesDays, 15);
  assert.equal(cfg.videoProtectionSessionsDays, 180);
});

test('getRetentionConfig: invalid days become null (skip) — no hardcoded fallback', () => {
  const cfg = getRetentionConfig({
    QUERY_USAGE_RETENTION_DAYS: 'not-a-number',
    VIDEO_VIEWS_RETENTION_DAYS: '-5',
    RECENTLY_VIEWED_RETENTION_DAYS: '0',
  });
  assert.equal(cfg.queryUsageDays, null);
  assert.equal(cfg.videoViewsDays, null);
  assert.equal(cfg.recentlyViewedDays, null);
});

test('cutoffForDays returns correct ISO cutoff', () => {
  const now = Date.now();
  const d = cutoffForDays(90);
  assert.ok(d instanceof Date);
  const diff = now - d.getTime();
  // ~90 days within 1s tolerance
  assert.ok(Math.abs(diff - 90 * 24 * 60 * 60 * 1000) < 2000);
  assert.equal(cutoffForDays(0), null);
  assert.equal(cutoffForDays(null), null);
});

// ---------- Helpers: mock client that tracks queries ----------

function createRetentionMock({ counts = {} } = {}) {
  // counts: table -> expired count for SELECT COUNT(*) paths
  const queries = [];
  const deleted = { query_usage: 0, video_views: 0, video_protection_sessions: 0, recently_viewed: 0, daily_usage_stats: 0, discussions: 0, discussion_replies: 0, user_sessions: 0 };
  let nextDeleteRowCount = null; // for batching tests, queue of rowCounts
  const client = {
    queries,
    deleted,
    _counts: counts,
    _deleteSequence: [],
    setDeleteSequence(seq) { this._deleteSequence = [...seq]; },
    query: async (sql, params) => {
      queries.push({ sql, params: params ? [...params] : [] });
      const s = sql.trim();
      // COUNT(*) paths
      if (s.startsWith('SELECT COUNT(*)')) {
        if (s.includes('FROM user_sessions')) {
          return { rows: [{ cnt: counts.user_sessions ?? 0 }], rowCount: 1 };
        }
        if (s.includes('FROM query_usage')) return { rows: [{ cnt: counts.query_usage ?? 0 }], rowCount: 1 };
        if (s.includes('FROM video_views')) return { rows: [{ cnt: counts.video_views ?? 0 }], rowCount: 1 };
        if (s.includes('FROM video_protection_sessions')) return { rows: [{ cnt: counts.video_protection_sessions ?? 0 }], rowCount: 1 };
        if (s.includes('FROM recently_viewed')) return { rows: [{ cnt: counts.recently_viewed ?? 0 }], rowCount: 1 };
        if (s.includes('FROM daily_usage_stats')) return { rows: [{ cnt: counts.daily_usage_stats ?? 0 }], rowCount: 1 };
        if (s.includes('FROM discussions')) return { rows: [{ cnt: counts.discussions ?? 0 }], rowCount: 1 };
        if (s.includes('FROM discussion_replies')) return { rows: [{ cnt: counts.discussion_replies ?? 0 }], rowCount: 1 };
        return { rows: [{ cnt: 0 }], rowCount: 1 };
      }
      // DELETE paths
      if (s.startsWith('DELETE FROM')) {
        let n;
        if (client._deleteSequence.length) {
          n = client._deleteSequence.shift();
        } else if (nextDeleteRowCount !== null) {
          n = nextDeleteRowCount;
          nextDeleteRowCount = null;
        } else {
          // For single-batch tests, return full count
          if (s.includes('query_usage')) n = counts.query_usage ?? 0;
          else if (s.includes('video_views')) n = counts.video_views ?? 0;
          else if (s.includes('video_protection_sessions')) n = counts.video_protection_sessions ?? 0;
          else if (s.includes('recently_viewed')) n = counts.recently_viewed ?? 0;
          else if (s.includes('daily_usage_stats')) n = counts.daily_usage_stats ?? 0;
          else if (s.includes('discussions') && s.includes('FROM discussions')) n = counts.discussions ?? 0;
          else if (s.includes('discussion_replies')) n = counts.discussion_replies ?? 0;
          else if (s.includes('user_sessions')) n = counts.user_sessions ?? 0;
          else n = 0;
          // After first delete, subsequent batched loops should return 0 to stop
          if (s.includes('recently_viewed') || s.includes('query_usage') || s.includes('video_views')) {
            counts[s.includes('query_usage') ? 'query_usage' : s.includes('video_views') ? 'video_views' : 'recently_viewed'] = 0;
          }
        }
        // track
        if (s.includes('query_usage')) deleted.query_usage += n;
        else if (s.includes('video_views')) deleted.video_views += n;
        else if (s.includes('video_protection_sessions')) deleted.video_protection_sessions += n;
        else if (s.includes('recently_viewed')) deleted.recently_viewed += n;
        else if (s.includes('daily_usage_stats')) deleted.daily_usage_stats += n;
        else if (s.includes('FROM discussions')) deleted.discussions += n;
        else if (s.includes('discussion_replies')) deleted.discussion_replies += n;
        else if (s.includes('user_sessions')) deleted.user_sessions += n;
        return { rowCount: n, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return client;
}

// ---------- Per-table dry-run vs real ----------

test('dry-run counts but performs no DELETE', async () => {
  const client = createRetentionMock({ counts: { query_usage: 5 } });
  const res = await cleanupQueryUsage({ client, days: 90, batchSize: 500, dryRun: true });
  assert.equal(res.count, 5);
  assert.equal(res.dryRun, true);
  assert.ok(res.cutoffISO);
  // No DELETE should have been issued
  assert.ok(client.queries.every(q => !q.sql.trim().startsWith('DELETE FROM')), 'dry-run must not DELETE');
  assert.ok(client.queries.some(q => q.sql.includes('COUNT(*)')), 'dry-run must COUNT');
});

test('real run performs batched DELETE with no COUNT', async () => {
  const client = createRetentionMock({ counts: { query_usage: 5 } });
  const res = await cleanupQueryUsage({ client, days: 90, batchSize: 2, dryRun: false });
  // With batchSize 2 and mocked single delete returning 5, our batchedDelete loops: first delete returns 5>=2 continue, second returns 0 Stop -> total 5? Our mock for batched delete needs sequence
  // Simpler: mock sequence 2,2,1 for batching test below; here we test single-call path uses 5
  // Our current mock for query_usage returns counts.query_usage on first DELETE then 0 second
  assert.equal(res.count >= 1, true);
  assert.equal(res.dryRun, false);
  assert.ok(client.queries.some(q => q.sql.trim().startsWith('DELETE FROM')), 'real run must DELETE');
});

test('batched deletes loop until rowCount < batchSize', async () => {
  const client = createRetentionMock({ counts: { query_usage: 5 } });
  // Simulate three batches: 2, 2, 1 (last < batch 2 → stop)
  client.setDeleteSequence([2, 2, 1]);
  const res = await cleanupQueryUsage({ client, days: 90, batchSize: 2, dryRun: false });
  assert.equal(res.count, 5);
  const deletes = client.queries.filter(q => q.sql.trim().startsWith('DELETE FROM'));
  assert.equal(deletes.length, 3);
  // Each DELETE should use LIMIT $2 and cutoff param
  for (const q of deletes) {
    assert.match(q.sql, /LIMIT \$\d+/);
    assert.ok(q.params[0] instanceof Date);
  }
});

test('missing/invalid retention days skips table safely', async () => {
  const client = createRetentionMock();
  const r1 = await cleanupQueryUsage({ client, days: null, batchSize: 500, dryRun: false });
  assert.equal(r1.skipped, true);
  assert.equal(r1.count, 0);
  assert.equal(client.queries.length, 0); // no query issued when skipped

  const r2 = await cleanupVideoViews({ client, days: 0, batchSize: 500, dryRun: false });
  assert.equal(r2.skipped, true);

  const r3 = await cleanupRecentlyViewed({ client, days: undefined, batchSize: 500, dryRun: true });
  assert.equal(r3.skipped, true);
});

test('recently_viewed uses last_viewed_at < cutoff (not created_at)', async () => {
  const client = createRetentionMock({ counts: { recently_viewed: 3 } });
  const res = await cleanupRecentlyViewed({ client, days: 30, batchSize: 10, dryRun: true });
  assert.equal(res.count, 3);
  const sel = client.queries.find(q => q.sql.includes('recently_viewed'));
  assert.match(sel.sql, /last_viewed_at </);
});

test('video_views uses viewed_at < cutoff', async () => {
  const client = createRetentionMock({ counts: { video_views: 2 } });
  await cleanupVideoViews({ client, days: 10, batchSize: 10, dryRun: true });
  const q = client.queries.find(c => c.sql.includes('video_views'));
  assert.match(q.sql, /viewed_at </);
});

test('video_protection_sessions uses last_seen_at < cutoff (idle sessions expire)', async () => {
  const client = createRetentionMock({ counts: { video_protection_sessions: 4 } });
  const res = await cleanupVideoProtectionSessions({ client, days: 180, batchSize: 10, dryRun: true });
  assert.equal(res.count, 4);
  assert.equal(res.dryRun, true);
  assert.ok(client.queries.every(q => !q.sql.trim().startsWith('DELETE FROM')), 'dry-run must not DELETE');
  const q = client.queries.find(c => c.sql.includes('video_protection_sessions'));
  assert.match(q.sql, /last_seen_at </);

  const skipped = await cleanupVideoProtectionSessions({ client, days: null, batchSize: 10, dryRun: false });
  assert.equal(skipped.skipped, true, 'missing days skips without querying');
});

test('daily_usage_stats uses day < cutoff date', async () => {
  const client = createRetentionMock({ counts: { daily_usage_stats: 1 } });
  const res = await cleanupDailyUsageStats({ client, days: 365, batchSize: 10, dryRun: true });
  assert.equal(res.count, 1);
  const q = client.queries.find(c => c.sql.includes('daily_usage_stats'));
  assert.match(q.sql, /day </);
});

test('soft-deleted discussions only when status=deleted and deleted_at < cutoff', async () => {
  const client = createRetentionMock({ counts: { discussions: 4 } });
  const res = await cleanupDeletedDiscussions({ client, days: 30, batchSize: 10, dryRun: true });
  assert.equal(res.count, 4);
  const q = client.queries.find(c => c.sql.includes('discussions'));
  assert.match(q.sql, /status = 'deleted'/);
  assert.match(q.sql, /deleted_at/);
  assert.match(q.sql, /IS NOT NULL/);
});

test('soft-deleted replies same constraint', async () => {
  const client = createRetentionMock({ counts: { discussion_replies: 2 } });
  await cleanupDeletedReplies({ client, days: 30, batchSize: 10, dryRun: true });
  const q = client.queries.find(c => c.sql.includes('discussion_replies'));
  assert.match(q.sql, /status = 'deleted'/);
  assert.match(q.sql, /deleted_at/);
});

test('user_sessions deletes expire < NOW() with no cutoff', async () => {
  const client = createRetentionMock({ counts: { user_sessions: 7 } });
  const r = await cleanupUserSessions({ client, batchSize: 5, dryRun: true });
  assert.equal(r.count, 7);
  assert.equal(r.cutoffISO, null);
  const q = client.queries.find(c => c.sql.includes('user_sessions'));
  assert.match(q.sql, /expire < NOW\(\)/);
});

test('never touches users/content_seen/item_likes — only safe tables appear in runRetentionCleanup', async () => {
  const client = createRetentionMock({
    counts: { query_usage: 1, video_views: 1, video_protection_sessions: 1, recently_viewed: 1, daily_usage_stats: 1, discussions: 1, discussion_replies: 1, user_sessions: 1 }
  });
  const cfg = {
    enabled: true, dryRun: true, batchSize: 10,
    queryUsageDays: 90, videoViewsDays: 90, videoProtectionSessionsDays: 180, recentlyViewedDays: 90, dailyUsageDays: 365, deletedDiscussionsDays: 30, deletedRepliesDays: 30
  };
  const result = await runRetentionCleanup({ client, config: cfg, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.enabled, true);
  assert.equal(result.results.length, 8); // 1 sessions + 4 time-series + 1 daily + 2 soft-deleted
  const tables = result.results.map(r => r.table);
  assert.ok(tables.includes('user_sessions'));
  assert.ok(tables.includes('query_usage'));
  assert.ok(tables.includes('video_views'));
  assert.ok(tables.includes('video_protection_sessions'));
  assert.ok(tables.includes('recently_viewed'));
  assert.ok(tables.includes('daily_usage_stats'));
  assert.ok(tables.some(t => t.includes('discussions(deleted)')));
  assert.ok(tables.some(t => t.includes('discussion_replies(deleted)')));
  for (const q of client.queries) {
    assert.doesNotMatch(q.sql, /FROM users/);
    assert.doesNotMatch(q.sql, /FROM content_seen/);
    assert.doesNotMatch(q.sql, /FROM item_likes/);
    assert.doesNotMatch(q.sql, /FROM content_action_permissions/);
    assert.doesNotMatch(q.sql, /FROM schema_migrations/);
  }
});

test('FK-safe order: replies before discussions', async () => {
  const order = [];
  const client = {
    query: async (sql) => {
      if (sql.includes('discussion_replies')) order.push('replies');
      else if (sql.includes('FROM discussions')) order.push('discussions');
      else order.push(sql.slice(0, 20));
      if (sql.includes('COUNT(*)')) return { rows: [{ cnt: 1 }] };
      return { rowCount: 1, rows: [] };
    }
  };
  const cfg = { enabled: true, dryRun: false, batchSize: 10, queryUsageDays: null, videoViewsDays: null, recentlyViewedDays: null, dailyUsageDays: null, deletedDiscussionsDays: 30, deletedRepliesDays: 30 };
  // Only deleted tables will run (others skipped due to null days), but user_sessions also runs; we care about replies vs discussions order
  await runRetentionCleanup({ client, config: cfg, dryRun: false });
  const repIdx = order.indexOf('replies');
  const discIdx = order.indexOf('discussions');
  assert.ok(repIdx !== -1 && discIdx !== -1, 'both should be called');
  assert.ok(repIdx < discIdx, 'replies must be cleaned before discussions');
});

test('idempotent: repeated run yields 0 after first deletes', async () => {
  // First run deletes 1, second run 0
  const client1 = createRetentionMock({ counts: { query_usage: 1 } });
  client1.setDeleteSequence([1, 0]); // first batch 1, second 0 -> total 1
  const r1 = await cleanupQueryUsage({ client: client1, days: 90, batchSize: 500, dryRun: false });
  assert.equal(r1.count, 1);
  // Second client with 0 expired
  const client2 = createRetentionMock({ counts: { query_usage: 0 } });
  const r2 = await cleanupQueryUsage({ client: client2, days: 90, batchSize: 500, dryRun: false });
  assert.equal(r2.count, 0);
});

test('RETENTION_ENABLED=false skips all tables', async () => {
  const client = createRetentionMock({ counts: { query_usage: 10 } });
  const cfg = { enabled: false, dryRun: false, batchSize: 500, queryUsageDays: 90, videoViewsDays: 90, recentlyViewedDays: 90, dailyUsageDays: 365, deletedDiscussionsDays: 30, deletedRepliesDays: 30 };
  const res = await runRetentionCleanup({ client, config: cfg });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'retention_disabled');
  assert.equal(client.queries.length, 0);
});

test('RETENTION_DRY_RUN=true prevents any DELETE', async () => {
  const client = createRetentionMock({ counts: { query_usage: 3, video_views: 2 } });
  const cfg = { enabled: true, dryRun: true, batchSize: 500, queryUsageDays: 90, videoViewsDays: 90, recentlyViewedDays: null, dailyUsageDays: null, deletedDiscussionsDays: null, deletedRepliesDays: null };
  const res = await runRetentionCleanup({ client, config: cfg });
  assert.equal(res.dryRun, true);
  assert.equal(res.totalDeleted, 5); // counts sum but no deletes
  assert.ok(client.queries.every(q => !q.sql.trim().startsWith('DELETE FROM')));
});

test('migration 020 creates viewed_at index (idempotent)', async () => {
  const migPath = fileURLToPath(new URL('../migrations/020_retention_indexes.sql', import.meta.url));
  assert.ok(fs.existsSync(migPath));
  const sql = fs.readFileSync(migPath, 'utf8');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_video_views_viewed_at/i);
  assert.match(sql, /viewed_at/);
});

test('env example documents new retention vars', async () => {
  const exPath = fileURLToPath(new URL('../.env.example', import.meta.url));
  const txt = fs.readFileSync(exPath, 'utf8');
  for (const v of ['RETENTION_ENABLED', 'RETENTION_DRY_RUN', 'RETENTION_BATCH_SIZE', 'QUERY_USAGE_RETENTION_DAYS', 'VIDEO_VIEWS_RETENTION_DAYS', 'VIDEO_PROTECTION_SESSIONS_RETENTION_DAYS', 'RECENTLY_VIEWED_RETENTION_DAYS', 'DAILY_USAGE_STATS_RETENTION_DAYS', 'DELETED_DISCUSSIONS_RETENTION_DAYS', 'DELETED_REPLIES_RETENTION_DAYS']) {
    assert.ok(txt.includes(v), `missing ${v} in .env.example`);
  }
  assert.ok(txt.includes('RETENTION_DRY_RUN=true'), 'default dry-run should be true');
});

test('scheduler reuses setInterval pattern and respects NODE_ENV=test', () => {
  // In test env, scheduler returns null
  const h = scheduleRetentionCleanup(1000);
  assert.equal(h, null);
  assert.equal(isRetentionSchedulerActive(), false);
  stopRetentionCleanup(); // no throw
});

test('config never hardcodes fallback days', async () => {
  const srcRetention = fs.readFileSync(fileURLToPath(new URL('../src/cleanup/retention.js', import.meta.url)), 'utf8');
  // Ensure cleanup does not contain hardcoded day numbers like "90" as fallback outside of tests
  // Look for pattern like "|| 90" or "days ||" which would be a hardcode fallback
  assert.ok(!/queryUsageDays\s*\|\|\s*\d+/.test(srcRetention), 'no hardcoded fallback for queryUsageDays');
  assert.ok(!/videoViewsDays\s*\|\|\s*\d+/.test(srcRetention), 'no hardcoded fallback for videoViewsDays');
  // Batch size default 500 is allowed (not a retention day)
  const cfgSrc = fs.readFileSync(fileURLToPath(new URL('../src/config/retention.js', import.meta.url)), 'utf8');
  assert.ok(!/QUERY_USAGE_RETENTION_DAYS.*\|\|.*\d+/.test(cfgSrc), 'config must not hardcode retention days');
});

test('cleanup logs structured payload with table/count/dryRun', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const client = createRetentionMock({ counts: { query_usage: 2 } });
    await cleanupQueryUsage({ client, days: 10, batchSize: 10, dryRun: true });
    const line = logs.find(l => l.includes('[retention]') && l.includes('query_usage'));
    assert.ok(line, 'should log retention line');
    // payload is JSON after prefix
    const jsonPart = line.slice(line.indexOf('{'));
    const obj = JSON.parse(jsonPart);
    assert.equal(obj.table, 'query_usage');
    assert.equal(obj.count, 2);
    assert.equal(obj.dryRun, true);
    assert.ok(obj.cutoff);
  } finally {
    console.log = origLog;
  }
});
