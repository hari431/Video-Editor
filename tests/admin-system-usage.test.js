import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetMetrics, recordRequest, recordContentAccess, recordPdfPreview, recordPdfDownload } from '../src/monitoring/metrics.js';

const { app } = await import('../src/server.js');

const OWNER = { id: 20, google_user_id: 'google-owner', email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 21, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 22, google_user_id: 'google-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };

const OWNER_SID = 'sys-owner-sid';
const ADMIN_SID = 'sys-admin-sid';
const USER_SID = 'sys-user-sid';
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [OWNER_SID]: OWNER, [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let originalQuery;
let server;
let port;

test.before(async () => {
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
    return { rows: [] };
  };
  server = await new Promise(r=> { const s=app.listen(0,()=>r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('Owner can access System / Usage dashboard', async () => {
  resetMetrics();
  const res = await http('/admin/system', { headers:{ Cookie: OWNER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /System \/ Usage/);
});

test('Admin can access System / Usage dashboard', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Application uptime/);
});

test('USER receives 403 Forbidden (existing behavior)', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: USER_COOKIE } });
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.equal(body, 'Forbidden');
});

test('Unauthenticated user is redirected to /login', async () => {
  const res = await http('/admin/system', { redirect:'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('Dashboard renders all required metrics sections', async () => {
  resetMetrics();
  recordRequest(200, 10);
  recordRequest(404, 5);
  recordRequest(500, 12);
  recordContentAccess();
  recordPdfPreview();
  recordPdfDownload();
  const res = await http('/admin/system', { headers:{ Cookie: OWNER_COOKIE } });
  const html = await res.text();
  // labels
  assert.match(html, /Application uptime/);
  assert.match(html, /Application start time/);
  assert.match(html, /Total requests/);
  assert.match(html, /2xx/);
  assert.match(html, /3xx/);
  assert.match(html, /4xx/);
  assert.match(html, /5xx/);
  assert.match(html, /Total errors/);
  assert.match(html, /Average response time/);
  assert.match(html, /Min response time/);
  assert.match(html, /Max response time/);
  assert.match(html, /Content views/);
  assert.match(html, /PDF previews/);
  assert.match(html, /PDF downloads/);
  assert.match(html, /Heap used/);
  assert.match(html, /System health status/);
});

test('Metrics displayed correctly after activity', async () => {
  resetMetrics();
  recordRequest(200, 10);
  recordRequest(200, 20);
  recordRequest(500, 30);
  recordContentAccess();
  recordContentAccess();
  recordPdfPreview();
  // Need to allow middleware increments for the dashboard request itself
  // Snapshot before dashboard request (excluding dashboard request)
  const before = (await http('/api/system/metrics', { headers:{ Cookie: ADMIN_COOKIE } }).then(r=>r.json()));
  // before.requests.total should be 3+1 (the api call itself) = at least 3
  assert.ok(before.requests.total >= 3, 'before counts at least recorded');
  assert.ok(before.content.views >= 2, 'before content views');
  const res = await http('/admin/system', { headers:{ Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // After dashboard request, fetch metrics again - dashboard request adds 1
  const after = await http('/api/system/metrics', { headers:{ Cookie: ADMIN_COOKIE } }).then(r=>r.json());
  // HTML was rendered with metrics at time of dashboard request (which includes dashboard request? No, middleware counts after render, so HTML reflects state before dashboard increment)
  // So HTML should show before metrics (or before+? ) Verify HTML contains content views count from before
  assert.ok(html.includes(`<strong>${before.content.views}</strong>`) || html.includes(`<strong>${after.content.views}</strong>`), 'content views displayed');
  assert.ok(html.includes(`<strong>${before.content.pdfPreviews}</strong>`) || html.includes(`<strong>${after.content.pdfPreviews}</strong>`), 'pdf previews displayed');
  // Also verify at least thresholds
  const contentViewsMatch = html.match(/Content views<\/span><\/div>/);
  assert.ok(contentViewsMatch, 'content label present');
  // Ensure numbers are not zero when we recorded activity
  assert.ok(after.content.views >= 2);
  assert.ok(after.content.pdfPreviews >= 1);
  assert.ok(after.requests.total >= 3);
});

test('Dashboard clearly labels in-memory nature', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: OWNER_COOKIE } });
  const html = await res.text();
  assert.match(html, /in-memory/i);
  assert.match(html, /since the current application process started/i);
});

test('No accidental exposure to normal users via API or dashboard data', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: USER_COOKIE } });
  assert.equal(res.status, 403);
  const api = await http('/api/system/metrics', { headers:{ Cookie: USER_COOKIE } });
  assert.equal(api.status, 403);
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const line = src.split('\n').find(l=> l.includes("'/admin/system'"));
  assert.ok(line.includes('requireAuth'), 'dashboard must require auth');
  assert.ok(line.includes('requireAdmin'), 'dashboard must require admin');
  assert.ok(!src.includes('/api/system/usage/public'), 'no public usage API');
});

test('Dashboard uses existing Admin layout and styling', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<link rel="stylesheet" href="\/styles.css">/);
  assert.match(html, /class="stats"/);
  assert.match(html, /class="stat stat--/);
  const adminSrc = fs.readFileSync(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
  assert.ok(adminSrc.includes('/admin/system') || adminSrc.includes('partials/admin-nav'), 'admin navigation links to system');
});

test('Dashboard does not introduce Google Ads or per-request DB writes', async () => {
  const viewSrc = fs.readFileSync(new URL('../src/views/admin-system.ejs', import.meta.url), 'utf8');
  // Phase 8B allows verification meta (adsense-verification) but not live ad scripts
  assert.ok(!/adsbygoogle/i.test(viewSrc), 'no live adsbygoogle in dashboard');
  assert.ok(!/pagead2\.googlesyndication/i.test(viewSrc), 'no live googlesyndication');
  assert.ok(!/googletagmanager/i.test(viewSrc), 'no googletagmanager');
  const metricsSrc = fs.readFileSync(new URL('../src/monitoring/metrics.js', import.meta.url), 'utf8');
  assert.ok(!/pool\.query/.test(metricsSrc), 'no per-request DB writes');
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(!/adsbygoogle/i.test(serverSrc), 'no live adsbygoogle in server');
  assert.ok(!/pagead2\.googlesyndication/i.test(serverSrc), 'no live script');
});

test('Memory and health displayed', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  assert.match(html, /Heap used/);
  assert.match(html, /RSS/);
  assert.match(html, /ok|errors detected/i);
});

test('Admin navigation includes System / Usage entry', async () => {
  const adminSrc = fs.readFileSync(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
  assert.ok(adminSrc.includes('/admin/system') || adminSrc.includes('partials/admin-nav'), 'admin.ejs links to system');
  const analyticsSrc = fs.readFileSync(new URL('../src/views/admin-analytics.ejs', import.meta.url), 'utf8');
  assert.ok(analyticsSrc.includes('/admin/system') || analyticsSrc.includes('partials/admin-nav'), 'analytics links to system');
});
