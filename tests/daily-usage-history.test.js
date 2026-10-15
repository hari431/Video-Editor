import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetMetrics, recordRequest, recordContentAccess, recordPdfPreview, recordPdfDownload, getMetrics } from '../src/monitoring/metrics.js';
import { flushDailyUsage, getDailyHistory, resetFlushState, computeDeltas } from '../src/monitoring/history.js';

const { app } = await import('../src/server.js');

// Helper to create mock pool for history tests without real DB
function createHistoryMockPool() {
  // In-memory store for daily_usage_stats
  const store = new Map(); // day -> row
  let queryLog = [];
  const mock = async (sql, params=[]) => {
    queryLog.push({ sql, params });
    const s = sql.trim();
    if (s.includes('daily_usage_stats') && s.includes('ORDER BY day DESC')) {
      // SELECT history
      const limit = params[0] || 30;
      const rows = Array.from(store.values()).sort((a,b)=> b.day.localeCompare(a.day)).slice(0, limit).map(r=> ({
        day: r.day,
        total_requests: r.total_requests,
        count_2xx: r.count_2xx,
        count_3xx: r.count_3xx,
        count_4xx: r.count_4xx,
        count_5xx: r.count_5xx,
        total_errors: r.total_errors,
        content_views: r.content_views,
        pdf_previews: r.pdf_previews,
        pdf_downloads: r.pdf_downloads,
        response_count: r.response_count,
        total_response_time_ms: r.total_response_time_ms,
        peak_heap_used_mb: r.peak_heap_used_mb,
        created_at: r.created_at,
        updated_at: r.updated_at
      }));
      return { rows };
    }
    if (s.includes('INSERT INTO daily_usage_stats')) {
      // Upsert: params: total_requests, c2,c3,c4,c5, total_errors, content_views, pdf_previews, pdf_downloads, response_count, total_response_time_ms, peak_heap_used_mb
      // Use CURRENT_DATE simulated as today ISO
      const today = new Date().toISOString().slice(0,10);
      const row = store.get(today) || {
        day: today,
        total_requests: 0, count_2xx:0, count_3xx:0, count_4xx:0, count_5xx:0, total_errors:0,
        content_views:0, pdf_previews:0, pdf_downloads:0, response_count:0, total_response_time_ms:0, peak_heap_used_mb:0,
        created_at: new Date(), updated_at: new Date()
      };
      row.total_requests += Number(params[0]||0);
      row.count_2xx += Number(params[1]||0);
      row.count_3xx += Number(params[2]||0);
      row.count_4xx += Number(params[3]||0);
      row.count_5xx += Number(params[4]||0);
      row.total_errors += Number(params[5]||0);
      row.content_views += Number(params[6]||0);
      row.pdf_previews += Number(params[7]||0);
      row.pdf_downloads += Number(params[8]||0);
      row.response_count += Number(params[9]||0);
      row.total_response_time_ms += Number(params[10]||0);
      row.peak_heap_used_mb = Math.max(Number(row.peak_heap_used_mb)||0, Number(params[11]||0));
      row.updated_at = new Date();
      store.set(today, row);
      return { rows: [] };
    }
    if (/SELECT EXISTS/.test(s) && /information_schema/.test(s)) {
      // for migration check tableExists
      if (s.includes('daily_usage_stats')) return { rows: [{ exists: true }] };
      return { rows: [{ exists: false }] };
    }
    // generic fallback for other queries (auth, folder_permissions etc)
    return { rows: [] };
  };
  mock.store = store;
  mock.queryLog = queryLog;
  mock.clearLog = () => { queryLog.length = 0; };
  return mock;
}

// ---------- Migration idempotency ----------
test('migration file exists and is idempotent', async () => {
  const migPath = fileURLToPath(new URL('../migrations/018_daily_usage_history.sql', import.meta.url));
  assert.ok(fs.existsSync(migPath), 'migration file exists');
  const sql = fs.readFileSync(migPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS daily_usage_stats/, 'must be idempotent');
  assert.match(sql, /PRIMARY KEY/, 'should have primary key day');
  assert.match(sql, /total_requests/, 'should track total requests');
  assert.match(sql, /count_2xx/, 'should track 2xx');
  assert.match(sql, /total_errors/, 'should track errors');
  assert.match(sql, /content_views/, 'should track content views');
  assert.match(sql, /pdf_previews/, 'should track pdf previews');
  assert.match(sql, /pdf_downloads/, 'should track pdf downloads');
  assert.match(sql, /total_response_time_ms/, 'should track total response time');
  assert.match(sql, /response_count/, 'should track response count');
  assert.match(sql, /peak_heap_used_mb/, 'optionally peak heap');
  assert.ok(!/INSERT INTO daily_usage_stats.*user_id/i.test(sql), 'must not store personal/user info');
});

test('migrate helper detects new table', async () => {
  const { isMigrationAppliedBySchema } = await import('../scripts/migrate.js');
  // mock client that says table exists
  const mockClientExists = { query: async (sql, params) => {
    if (/information_schema\.tables/.test(sql) && params[0]==='daily_usage_stats') return { rows: [{ exists: true }] };
    return { rows: [{ exists: false }] };
  }};
  assert.equal(await isMigrationAppliedBySchema(mockClientExists, '018_daily_usage_history.sql'), true);
  const mockClientMissing = { query: async (sql, params) => {
    if (/information_schema\.tables/.test(sql)) return { rows: [{ exists: false }] };
    return { rows: [{ exists: false }] };
  }};
  assert.equal(await isMigrationAppliedBySchema(mockClientMissing, '018_daily_usage_history.sql'), false);
});

// ---------- Daily aggregation correctness ----------
test('daily aggregation/persistence works and calculates avg correctly', async () => {
  const mock = createHistoryMockPool();
  const orig = pool.query;
  pool.query = mock;
  try {
    resetMetrics();
    resetFlushState();
    // simulate activity
    recordRequest(200, 100);
    recordRequest(200, 200);
    recordRequest(500, 300);
    recordContentAccess();
    recordPdfPreview();
    // flush once
    const r1 = await flushDailyUsage();
    assert.equal(r1.flushed, true, 'first flush should write');
    const history1 = await getDailyHistory(30);
    assert.equal(history1.length, 1);
    const row = history1[0];
    assert.equal(row.total_requests, 3);
    assert.equal(row.count_2xx, 2);
    assert.equal(row.count_5xx, 1);
    assert.equal(row.total_errors, 1);
    assert.equal(row.content_views, 1);
    assert.equal(row.pdf_previews, 1);
    assert.equal(row.response_count, 3);
    assert.equal(row.total_response_time_ms, 600); // 100+200+300
    assert.equal(row.avg_response_ms, 200);
  } finally {
    pool.query = orig;
    resetFlushState();
    resetMetrics();
  }
});

test('repeated persistence does not duplicate same daily record (idempotent day)', async () => {
  const mock = createHistoryMockPool();
  const orig = pool.query;
  pool.query = mock;
  try {
    resetMetrics();
    resetFlushState();
    recordRequest(200, 50);
    const r1 = await flushDailyUsage();
    assert.equal(r1.flushed, true);
    const h1 = await getDailyHistory(30);
    assert.equal(h1[0].total_requests, 1);
    // flush again without new activity -> should not write (zero delta)
    const r2 = await flushDailyUsage();
    assert.equal(r2.flushed, false, 'second flush with no delta should be no-op');
    const h2 = await getDailyHistory(30);
    assert.equal(h2.length, 1, 'still one row');
    assert.equal(h2[0].total_requests, 1, 'not duplicated');
    // add more activity and flush -> should add delta, not duplicate row
    recordRequest(200, 50);
    recordRequest(404, 50);
    const r3 = await flushDailyUsage();
    assert.equal(r3.flushed, true);
    const h3 = await getDailyHistory(30);
    assert.equal(h3.length, 1, 'still one row for same day');
    assert.equal(h3[0].total_requests, 3, 'added delta correctly');
    assert.equal(h3[0].count_2xx, 2);
    assert.equal(h3[0].count_4xx, 1);
  } finally {
    pool.query = orig;
    resetFlushState();
    resetMetrics();
  }
});

test('resilient to process restarts (delta handles reset)', async () => {
  const mock = createHistoryMockPool();
  const orig = pool.query;
  pool.query = mock;
  try {
    resetMetrics();
    resetFlushState();
    recordRequest(200, 10);
    recordRequest(200, 10);
    await flushDailyUsage(); // 2 requests persisted
    let h = await getDailyHistory(30);
    assert.equal(h[0].total_requests, 2);
    // simulate process restart: metrics reset to 0, lastFlushed remains? Actually after restart, lastFlushed is reinitialized to 0 (new process).
    // Our module would reset lastFlushed to 0 on new process, but in test we simulate by resetting metrics and also resetting flush state to 0
    // But to test resilience, we want lastFlushed to be 0 while DB already has 2 persisted.
    // In real restart, lastFlushed is 0, DB has 2, metrics is 0. Next activity 1 request should add 1 to make total 3.
    resetMetrics(); // metrics now 0
    resetFlushState(); // simulate new process: lastFlushed 0
    recordRequest(200, 10); // 1 new request
    const r = await flushDailyUsage();
    assert.equal(r.flushed, true);
    h = await getDailyHistory(30);
    assert.equal(h[0].total_requests, 3, 'after restart, added only new requests, not double counted nor lost');
  } finally {
    pool.query = orig;
    resetFlushState();
    resetMetrics();
  }
});

test('history does not store personal info and is lightweight', async () => {
  const mock = createHistoryMockPool();
  const orig = pool.query;
  pool.query = mock;
  try {
    resetMetrics();
    resetFlushState();
    recordRequest(200, 10);
    await flushDailyUsage();
    const h = await getDailyHistory(30);
    const json = JSON.stringify(h[0]);
    assert.ok(!/email/i.test(json));
    assert.ok(!/user_id/i.test(json));
    assert.ok(!/password/i.test(json));
    // check history file
    const histSrc = fs.readFileSync(new URL('../src/monitoring/history.js', import.meta.url), 'utf8');
    assert.ok(!/user_id|email/.test(histSrc) || /no PII/i.test(histSrc));
    assert.ok(!/pool\.query.*INSERT.*per request/i.test(histSrc));
  } finally {
    pool.query = orig;
    resetFlushState();
    resetMetrics();
  }
});

// ---------- Dashboard display ----------
const OWNER = { id: 40, google_user_id: 'google-owner4', email: 'owner4@example.com', name: 'Owner4', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 41, google_user_id: 'google-admin4', email: 'admin4@example.com', name: 'Admin4', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 42, google_user_id: 'google-user4', email: 'user4@example.com', name: 'User4', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };
const SID_OWNER = 'hist-owner-sid';
const SID_ADMIN = 'hist-admin-sid';
const SID_USER = 'hist-user-sid';
const COOKIE_OWNER = `connect.sid=s:${cookieSignature.sign(SID_OWNER, process.env.SESSION_SECRET)}`;
const COOKIE_ADMIN = `connect.sid=s:${cookieSignature.sign(SID_ADMIN, process.env.SESSION_SECRET)}`;
const COOKIE_USER = `connect.sid=s:${cookieSignature.sign(SID_USER, process.env.SESSION_SECRET)}`;
const sessionToUser = { [SID_OWNER]: OWNER, [SID_ADMIN]: ADMIN, [SID_USER]: USER };

let server, port, originalQuery;
let historyMockForServer; // allow server route to read history

test.before(async () => {
  historyMockForServer = createHistoryMockPool();
  // Pre-populate history for dashboard test
  // Insert a fake row directly via mock store for 2 days
  const today = new Date().toISOString().slice(0,10);
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  historyMockForServer.store.set(today, {
    day: today, total_requests: 42, count_2xx: 35, count_3xx: 2, count_4xx: 3, count_5xx: 2, total_errors: 2,
    content_views: 15, pdf_previews: 5, pdf_downloads: 2, response_count: 42, total_response_time_ms: 8400, peak_heap_used_mb: 123.4,
    created_at: new Date(), updated_at: new Date()
  });
  historyMockForServer.store.set(yesterday, {
    day: yesterday, total_requests: 30, count_2xx: 28, count_3xx: 1, count_4xx: 1, count_5xx: 0, total_errors: 0,
    content_views: 10, pdf_previews: 3, pdf_downloads: 1, response_count: 30, total_response_time_ms: 6000, peak_heap_used_mb: 110.2,
    created_at: new Date(Date.now()-86400000), updated_at: new Date(Date.now()-86400000)
  });

  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    if (/daily_usage_stats/.test(sql)) {
      return historyMockForServer(sql, params);
    }
    return { rows: [] };
  };
  // need to import app after mock setup but app already imported; server will use mocked pool.query
  server = await new Promise(r=> { const s=app.listen(0,()=>r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('dashboard displays historical data (Usage History section)', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Usage History/);
  assert.match(html, /persisted daily aggregates/i);
  assert.match(html, /42/); // today's total_requests
  assert.match(html, /30/); // yesterday
  // check distinct sections
  assert.match(html, /Current in-memory metrics vs persisted history/i);
  assert.match(html, /in-memory.*persisted/i);
});

test('OWNER can access history dashboard and API', async () => {
  const dash = await http('/admin/system', { headers:{ Cookie: COOKIE_OWNER } });
  assert.equal(dash.status, 200);
  const api = await http('/api/system/history', { headers:{ Cookie: COOKIE_OWNER } });
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.ok(Array.isArray(body.history));
  assert.equal(body.history.length, 2);
  assert.ok('avg_response_ms' in body.history[0]);
});

test('ADMIN can access history', async () => {
  const api = await http('/api/system/history', { headers:{ Cookie: COOKIE_ADMIN } });
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.ok(body.history.length >= 1);
});

test('USER must not access history data/API', async () => {
  const dash = await http('/admin/system', { headers:{ Cookie: COOKIE_USER } });
  assert.equal(dash.status, 403);
  const api = await http('/api/system/history', { headers:{ Cookie: COOKIE_USER } });
  assert.equal(api.status, 403);
  const apiBody = await api.text();
  assert.equal(apiBody, 'Forbidden');
});

test('unauthenticated blocked from history', async () => {
  const dash = await http('/admin/system', { redirect:'manual' });
  assert.equal(dash.status, 302);
  const api = await http('/api/system/history', { redirect:'manual' });
  assert.equal(api.status, 302);
});

test('history shows avg response time correctly', async () => {
  const api = await http('/api/system/history', { headers:{ Cookie: COOKIE_ADMIN } });
  const body = await api.json();
  const today = body.history.find(r=> r.total_requests===42);
  assert.ok(today);
  assert.equal(today.avg_response_ms, 200); // 8400/42
});

test('dashboard distinguishes in-memory vs persisted', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  const html = await res.text();
  assert.match(html, /Current in-memory metrics/);
  assert.match(html, /persisted daily aggregates/i);
  assert.match(html, /Usage History/);
  // ensure in-memory section still present
  assert.match(html, /Total requests/);
});

test('existing Phase 1-3 dashboard still works with history', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  const html = await res.text();
  assert.match(html, /System Health & Scaling Indicators/);
  assert.match(html, /Overall system status/);
  assert.match(html, /Application uptime/);
});
