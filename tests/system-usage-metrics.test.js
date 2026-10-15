import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  resetMetrics,
  recordRequest,
  recordContentAccess,
  recordPdfPreview,
  recordPdfDownload,
  getMetrics,
  getHealth,
  metricsMiddleware
} from '../src/monitoring/metrics.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const SECRET = process.env.SESSION_SECRET;

// ---------- Unit tests ----------
test('resetMetrics clears aggregates but keeps structure', () => {
  resetMetrics();
  let m = getMetrics();
  assert.equal(m.requests.total, 0);
  assert.deepEqual(m.requests.byStatus, { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 });
  assert.equal(m.content.views, 0);
  assert.equal(m.content.pdfPreviews, 0);
  assert.equal(m.content.pdfDownloads, 0);
  recordRequest(200, 10);
  recordContentAccess();
  recordPdfPreview();
  recordPdfDownload();
  m = getMetrics();
  assert.equal(m.requests.total, 1);
  assert.equal(m.content.views, 1);
  assert.equal(m.content.pdfPreviews, 1);
  assert.equal(m.content.pdfDownloads, 1);
  resetMetrics();
  m = getMetrics();
  assert.equal(m.requests.total, 0);
  assert.equal(m.content.views, 0);
});

test('recordRequest aggregates by status category and errors', () => {
  resetMetrics();
  recordRequest(200, 5);
  recordRequest(201, 15);
  recordRequest(301, 20);
  recordRequest(404, 8);
  recordRequest(500, 30);
  recordRequest(503, 12);
  const m = getMetrics();
  assert.equal(m.requests.total, 6);
  assert.equal(m.requests.byStatus['2xx'], 2);
  assert.equal(m.requests.byStatus['3xx'], 1);
  assert.equal(m.requests.byStatus['4xx'], 1);
  assert.equal(m.requests.byStatus['5xx'], 2);
  assert.equal(m.errors.total, 2);
  assert.equal(m.errors.total5xx, 2);
  assert.equal(m.errors.total4xx, 1);
});

test('response timing aggregates avg/min/max', () => {
  resetMetrics();
  recordRequest(200, 10);
  recordRequest(200, 20);
  recordRequest(200, 30);
  const m = getMetrics();
  assert.equal(m.responseTime.count, 3);
  assert.equal(m.responseTime.totalMs, 60);
  assert.equal(m.responseTime.avgMs, 20);
  assert.equal(m.responseTime.minMs, 10);
  assert.equal(m.responseTime.maxMs, 30);
});

test('content and pdf counters increment independently', () => {
  resetMetrics();
  recordContentAccess();
  recordContentAccess();
  recordPdfPreview();
  recordPdfDownload();
  recordPdfDownload();
  const m = getMetrics();
  assert.equal(m.content.views, 2);
  assert.equal(m.content.pdfPreviews, 1);
  assert.equal(m.content.pdfDownloads, 2);
});

test('getHealth returns ok with uptime and counts', async () => {
  resetMetrics();
  recordRequest(200, 5);
  const h = getHealth();
  assert.equal(h.status, 'ok');
  assert.ok(typeof h.uptimeSeconds === 'number');
  assert.ok(h.uptimeSeconds >= 0);
  assert.ok(typeof h.startedAt === 'string');
  assert.equal(h.requests, 1);
  assert.equal(h.errors, 0);
  // after error
  recordRequest(500, 10);
  const h2 = getHealth();
  assert.equal(h2.errors, 1);
});

test('metrics contain no personal data', () => {
  resetMetrics();
  const m = getMetrics();
  const json = JSON.stringify(m);
  assert.ok(!/email/i.test(json), 'no email in metrics');
  assert.ok(!/password/i.test(json));
  assert.ok(!/google/i.test(json));
  assert.ok(!/ip/i.test(json) || json.includes('heapUsedMb')); // heap is ok, but no IP storage
  // ensure structure only has expected top-level keys
  assert.ok('requests' in m);
  assert.ok('content' in m);
  assert.ok('responseTime' in m);
  assert.ok('uptimeSeconds' in m);
});

test('metricsMiddleware increments on finish and records timing', async () => {
  resetMetrics();
  // simulate req/res with finish event
  let finishCb = null;
  const res = {
    statusCode: 200,
    on(event, cb) { if (event === 'finish' || event === 'close') finishCb = cb; },
    removeListener() {}
  };
  const req = {};
  let nextCalled = false;
  metricsMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.ok(finishCb, 'registered finish listener');
  // simulate status 404
  res.statusCode = 404;
  finishCb();
  // allow async? recordRequest is sync
  const m = getMetrics();
  assert.equal(m.requests.total, 1);
  assert.equal(m.requests.byStatus['4xx'], 1);
  assert.equal(m.responseTime.count, 1);
  assert.ok(m.responseTime.avgMs >= 0);
});

test('getMetrics uptime grows over time', async () => {
  resetMetrics();
  const m1 = getMetrics();
  await new Promise(r => setTimeout(r, 12));
  const m2 = getMetrics();
  assert.ok(m2.uptimeMs >= m1.uptimeMs);
});

// ---------- Integration tests via HTTP ----------
const OWNER = { id: 10, google_user_id: 'google-owner', email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 11, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 12, google_user_id: 'google-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };

function sidFor(id){ return `metrics-sid-${id}`; }
function cookieFor(id){ return `connect.sid=s:${cookieSignature.sign(sidFor(id), SECRET)}`; }

let server;
let port;
let originalQuery;

test.before(async () => {
  // create a small pdf fixture for /file and /download tests
  const base = path.join(QUERIES_DIR, '__metrics_test');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'sample.pdf'), randomBytes(64));
  // also a txt fixture
  await writeFile(path.join(base, 'note.txt'), 'hello world content');

  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const sid = params[0];
      const m = String(sid).match(/metrics-sid-(\d+)/);
      const uid = m ? Number(m[1]) : null;
      const user = [OWNER, ADMIN, USER].find(u=>u.id===uid);
      if (user) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: uid } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const uid = Number(params[0]);
      const u = [OWNER, ADMIN, USER].find(x=>x.id===uid);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return { rows: [{ folder_path: '__metrics_test', access_level: 'all', role_id: null }, { folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    }
    if (/content_action_permissions/.test(sql)) {
      // for pdf download test, allow USER to preview but not download? Here allow all for simplicity via ADMIN bypass; USER needs explicit but we stub allow
      if (/SELECT 1/.test(sql)) {
        const uid = params[0];
        // only ADMIN/OWNER are bypassed via isAdminUser, USER check will query. For __metrics_test we want USER to be able to download for metrics test, so grant
        if (uid === 12) return { rows: [{}], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    }
    if (/item_likes/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/recently_viewed/.test(sql) && /INSERT|DELETE|SELECT/.test(sql)) return { rows: [] };
    if (/content_seen/.test(sql)) return { rows: [] };
    if (/query_usage/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/SELECT COUNT/.test(sql) && /users/.test(sql)) return { rows: [{ total_users: 3 }] };
    return { rows: [] };
  };
  const { app } = await import('../src/server.js');
  // app is already imported elsewhere but we reuse imported instance; server from earlier import
  // We need to get app from previous import - import directly
  const mod = await import('../src/server.js');
  const application = mod.app;
  server = await new Promise(r=> { const s=application.listen(0,()=>r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) pool.query = originalQuery;
  await rm(path.join(QUERIES_DIR,'__metrics_test'), { recursive:true, force:true });
});

test('health endpoint returns ok plus uptime and is counted', async () => {
  resetMetrics();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(typeof body.uptimeSeconds === 'number');
  assert.ok(typeof body.startedAt === 'string');
  // metrics middleware should have counted this request
  // allow event loop to flush finish handler
  await new Promise(r=> setTimeout(r, 10));
  const m = getMetrics();
  assert.ok(m.requests.total >= 1, 'health request counted');
  assert.ok(m.responseTime.count >= 1);
});

test('public system health endpoint works without auth', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/system/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(typeof body.uptimeSeconds === 'number');
});

test('system metrics endpoint requires admin (user gets 403, admin/owner 200)', async () => {
  resetMetrics();
  const userRes = await fetch(`http://127.0.0.1:${port}/api/system/metrics`, { headers:{ Cookie: cookieFor(USER.id) } });
  assert.equal(userRes.status, 403);
  const adminRes = await fetch(`http://127.0.0.1:${port}/api/system/metrics`, { headers:{ Cookie: cookieFor(ADMIN.id) } });
  assert.equal(adminRes.status, 200);
  const adminBody = await adminRes.json();
  assert.ok('requests' in adminBody);
  assert.ok('content' in adminBody);
  assert.ok('responseTime' in adminBody);
  assert.ok('uptimeSeconds' in adminBody);

  const ownerRes = await fetch(`http://127.0.0.1:${port}/api/system/metrics`, { headers:{ Cookie: cookieFor(OWNER.id) } });
  assert.equal(ownerRes.status, 200);

  const unauthRes = await fetch(`http://127.0.0.1:${port}/api/system/metrics`, { redirect:'manual' });
  assert.equal(unauthRes.status, 302);
  assert.equal(unauthRes.headers.get('location'), '/login');
});

test('metrics endpoint exposes aggregates without PII', async () => {
  resetMetrics();
  const res = await fetch(`http://127.0.0.1:${port}/api/system/metrics`, { headers:{ Cookie: cookieFor(ADMIN.id) } });
  const body = await res.json();
  const json = JSON.stringify(body);
  assert.ok(!/owner@example.com/i.test(json));
  assert.ok(!/google/i.test(json));
  assert.ok('requests' in body);
  assert.ok('errors' in body);
  assert.ok('content' in body);
  assert.ok('responseTime' in body);
  assert.ok('memory' in body || 'heapUsedMb' in body);
});

test('request/error counting works via http (4xx increments)', async () => {
  resetMetrics();
  // make a 404 request via missing file
  const bad = await fetch(`http://127.0.0.1:${port}/item/${encodeURIComponent('__metrics_test/missing.pdf')}`, { headers:{ Cookie: cookieFor(USER.id) } });
  assert.equal(bad.status, 404);
  await new Promise(r=> setTimeout(r, 10));
  let m = getMetrics();
  assert.ok(m.requests.byStatus['4xx'] >= 1, '404 counted as 4xx');
  // make a successful request
  const ok = await fetch(`http://127.0.0.1:${port}/item/${encodeURIComponent('__metrics_test/sample.pdf')}`, { headers:{ Cookie: cookieFor(USER.id) } });
  assert.equal(ok.status, 200);
  await new Promise(r=> setTimeout(r, 15));
  m = getMetrics();
  assert.ok(m.requests.byStatus['2xx'] >= 1);
  assert.ok(m.content.views >= 1, 'content view counted via HTTP');
});

test('pdf preview and download counters increment via http', async () => {
  resetMetrics();
  const enc = v=> v.split('/').map(encodeURIComponent).join('/');
  const preview = await fetch(`http://127.0.0.1:${port}/file/${enc('__metrics_test/sample.pdf')}`, { headers:{ Cookie: cookieFor(USER.id) } });
  assert.equal(preview.status, 200);
  await new Promise(r=> setTimeout(r, 10));
  let m = getMetrics();
  assert.equal(m.content.pdfPreviews, 1, 'pdf preview counted');

  const dl = await fetch(`http://127.0.0.1:${port}/download/${enc('__metrics_test/sample.pdf')}`, { headers:{ Cookie: cookieFor(USER.id) } });
  assert.equal(dl.status, 200);
  await new Promise(r=> setTimeout(r, 10));
  m = getMetrics();
  assert.equal(m.content.pdfDownloads, 1, 'pdf download counted');
});

test('response timing is recorded for http requests', async () => {
  resetMetrics();
  await fetch(`http://127.0.0.1:${port}/health`);
  await fetch(`http://127.0.0.1:${port}/health`);
  await new Promise(r=> setTimeout(r, 10));
  const m = getMetrics();
  assert.ok(m.responseTime.count >= 2);
  assert.ok(m.responseTime.avgMs >= 0);
  assert.ok(m.responseTime.maxMs >= m.responseTime.minMs);
});

test('metrics are in-memory and lightweight (no DB writes per request)', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/monitoring/metrics.js', import.meta.url), 'utf8');
  assert.ok(!/pool\.query/.test(src), 'metrics module must not do per-request DB writes');
  assert.ok(!/INSERT INTO/.test(src));
  assert.ok(/in-memory/i.test(src) || /aggregate/i.test(src) || /lightweight/i.test(src) || /No per-request DB/.test(src) || !/pool/.test(src));
});

test('server does not change RBAC - metrics endpoint uses requireAdmin', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const line = src.split('\n').find(l=> l.includes('/api/system/metrics'));
  assert.ok(line.includes('requireAuth'), 'must require auth');
  assert.ok(line.includes('requireAdmin'), 'must require admin');
});
