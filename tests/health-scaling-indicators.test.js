import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetMetrics, recordRequest, recordContentAccess, getMetrics } from '../src/monitoring/metrics.js';
import {
  HEALTH_THRESHOLDS,
  getMemoryIndicator,
  getErrorRateIndicator,
  getResponseTimeIndicator,
  getRequestLevelIndicator,
  getHealthIndicators,
  getRecommendation,
  getOverallStatus
} from '../src/monitoring/health.js';

const { app } = await import('../src/server.js');

// ---- Threshold configurability ----
test('thresholds are configurable in one place', () => {
  assert.ok(HEALTH_THRESHOLDS, 'exported');
  assert.ok('memory' in HEALTH_THRESHOLDS);
  assert.ok('errorRate' in HEALTH_THRESHOLDS);
  assert.ok('responseTime' in HEALTH_THRESHOLDS);
  assert.ok('requestRate' in HEALTH_THRESHOLDS);
  // ensure no scattering: health.js is the single source (server.js should not hardcode thresholds)
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // server should not contain magic numbers for health (it delegates to health.js)
  assert.ok(!/HEALTH_THRESHOLDS|warningMb|criticalMb/.test(serverSrc) || /getHealthIndicators/.test(serverSrc), 'server delegates to health module');
  const healthSrc = fs.readFileSync(new URL('../src/monitoring/health.js', import.meta.url), 'utf8');
  assert.match(healthSrc, /HEALTH_THRESHOLDS/, 'thresholds defined in health.js');
  assert.match(healthSrc, /advisory only/i, 'clear advisory note in source');
  // Ensure not based on arbitrary user counts
  assert.ok(!/total_users|user_count/i.test(healthSrc), 'must not use fixed user counts');
  assert.ok(!/upgrade required/i.test(healthSrc), 'must not claim upgrade required');
});

test('health module does not do per-request DB writes or external services', () => {
  const src = fs.readFileSync(new URL('../src/monitoring/health.js', import.meta.url), 'utf8');
  assert.ok(!/pool\.query/.test(src), 'no DB writes');
  assert.ok(!/fetch\(|axios|http\.request/.test(src), 'no external monitoring services');
  assert.ok(!/INSERT INTO/.test(src));
});

// ---- Memory indicator ----
test('Memory indicator healthy / warning / critical', () => {
  const base = { heapUsedMb: 50, requests: { total: 100 }, errors: { total: 0 }, responseTime: { count: 100, avgMs: 10, minMs: 5, maxMs: 20 }, uptimeSeconds: 1000, memory: {} };
  let ind = getMemoryIndicator({ ...base, heapUsedMb: 50 });
  assert.equal(ind.status, 'healthy');
  ind = getMemoryIndicator({ ...base, heapUsedMb: HEALTH_THRESHOLDS.memory.warningMb });
  assert.equal(ind.status, 'warning');
  ind = getMemoryIndicator({ ...base, heapUsedMb: HEALTH_THRESHOLDS.memory.warningMb + 10 });
  assert.equal(ind.status, 'warning');
  ind = getMemoryIndicator({ ...base, heapUsedMb: HEALTH_THRESHOLDS.memory.criticalMb });
  assert.equal(ind.status, 'critical');
  ind = getMemoryIndicator({ ...base, heapUsedMb: HEALTH_THRESHOLDS.memory.criticalMb + 50 });
  assert.equal(ind.status, 'critical');
  // detail must mention informational
  assert.match(ind.detail, /informational/i);
});

test('Memory indicator handles missing data gracefully', () => {
  const ind = getMemoryIndicator({ heapUsedMb: null });
  assert.equal(ind.status, 'healthy'); // no data => healthy advisory
});

// ---- Error rate indicator ----
test('Error rate healthy / warning / critical with minSamples', () => {
  const mk = (total, errors) => ({ requests: { total }, errors: { total: errors }, heapUsedMb: 10, responseTime: { count: 100, avgMs: 10 }, uptimeSeconds: 1000, memory: {} });
  // insufficient samples -> healthy
  let ind = getErrorRateIndicator(mk(5, 5));
  assert.equal(ind.status, 'healthy');
  assert.match(ind.detail, /Insufficient data/);
  // healthy: 2% error (2/100) below warning 5%
  ind = getErrorRateIndicator(mk(100, 2));
  assert.equal(ind.status, 'healthy');
  // warning: exactly threshold
  ind = getErrorRateIndicator(mk(100, 5));
  assert.equal(ind.status, 'warning');
  ind = getErrorRateIndicator(mk(100, 7));
  assert.equal(ind.status, 'warning');
  // critical
  ind = getErrorRateIndicator(mk(100, 10));
  assert.equal(ind.status, 'critical');
  ind = getErrorRateIndicator(mk(100, 15));
  assert.equal(ind.status, 'critical');
  assert.match(ind.detail, /informational/i);
});

test('Error rate thresholds are measurable not user-count based', () => {
  const src = fs.readFileSync(new URL('../src/monitoring/health.js', import.meta.url), 'utf8');
  // should compute rate = errors/total, not users
  assert.match(src, /errors\.total.*requests\.total|rate.*errors.*total/s);
});

// ---- Response time indicator ----
test('Response time healthy / warning / critical with minSamples', () => {
  const mk = (count, avg) => ({ responseTime: { count, avgMs: avg, minMs: avg-5, maxMs: avg+5 }, requests: { total: 100 }, errors: { total: 0 }, heapUsedMb: 10, uptimeSeconds: 1000, memory: {} });
  let ind = getResponseTimeIndicator(mk(5, 100));
  assert.equal(ind.status, 'healthy');
  assert.match(ind.detail, /Insufficient data/);
  ind = getResponseTimeIndicator(mk(100, 100));
  assert.equal(ind.status, 'healthy');
  ind = getResponseTimeIndicator(mk(100, HEALTH_THRESHOLDS.responseTime.warningMs));
  assert.equal(ind.status, 'warning');
  ind = getResponseTimeIndicator(mk(100, 600));
  assert.equal(ind.status, 'warning');
  ind = getResponseTimeIndicator(mk(100, HEALTH_THRESHOLDS.responseTime.criticalMs));
  assert.equal(ind.status, 'critical');
  ind = getResponseTimeIndicator(mk(100, 1500));
  assert.equal(ind.status, 'critical');
});

// ---- Request / Activity level ----
test('Request level healthy / warning / critical', () => {
  const mk = (total, uptime) => ({ requests: { total }, uptimeSeconds: uptime, heapUsedMb: 10, errors: { total: 0 }, responseTime: { count: 100, avgMs: 10 }, memory: {} });
  // low uptime => healthy advisory
  let ind = getRequestLevelIndicator(mk(100, 10));
  assert.equal(ind.status, 'healthy');
  assert.match(ind.detail, /Low uptime/);
  // healthy rps below warning
  ind = getRequestLevelIndicator(mk(300, 100)); // 3 rps
  assert.equal(ind.status, 'healthy');
  // warning
  ind = getRequestLevelIndicator(mk(HEALTH_THRESHOLDS.requestRate.warningRps * 100, 100));
  assert.equal(ind.status, 'warning');
  // critical
  ind = getRequestLevelIndicator(mk(HEALTH_THRESHOLDS.requestRate.criticalRps * 100, 100));
  assert.equal(ind.status, 'critical');
});

// ---- Overall status & recommendation ----
test('Overall status aggregates worst indicator', () => {
  const healthyMetrics = { heapUsedMb: 10, requests: { total: 100 }, errors: { total: 1 }, responseTime: { count: 100, avgMs: 50, minMs: 10, maxMs: 100 }, uptimeSeconds: 1000, memory: { rss: 100*1024*1024, heapTotal: 50*1024*1024 } };
  let res = getHealthIndicators(healthyMetrics);
  assert.equal(res.overall, 'healthy');
  assert.equal(res.recommendation, 'Current infrastructure looks sufficient.');
  // introduce warning via memory
  let warnMetrics = { ...healthyMetrics, heapUsedMb: HEALTH_THRESHOLDS.memory.warningMb + 5 };
  res = getHealthIndicators(warnMetrics);
  assert.equal(res.overall, 'warning');
  assert.equal(res.recommendation, 'Usage is increasing; continue monitoring.');
  // introduce critical via error rate
  let critMetrics = { ...healthyMetrics, requests: { total: 100 }, errors: { total: 15 } }; // 15% error
  res = getHealthIndicators(critMetrics);
  assert.equal(res.overall, 'critical');
  assert.equal(res.recommendation, 'Capacity concern detected; consider reviewing server resources.');
  // verify advisory note present and not claiming upgrade required as fact
  assert.match(res.note, /advisory only/i);
  assert.ok(!/upgrade is required/i.test(res.recommendation), 'advisory only');
  assert.ok(res.recommendation.includes('consider reviewing'), 'advisory phrasing');
});

test('Recommendation mapping is advisory and distinct from hosting capacity', () => {
  assert.equal(getRecommendation('healthy'), 'Current infrastructure looks sufficient.');
  assert.equal(getRecommendation('warning'), 'Usage is increasing; continue monitoring.');
  assert.equal(getRecommendation('critical'), 'Capacity concern detected; consider reviewing server resources.');
  const src = fs.readFileSync(new URL('../src/monitoring/health.js', import.meta.url), 'utf8');
  assert.ok(/advisory only/.test(src.toLowerCase()), 'source must clarify advisory');
});

test('Overall includes application health derived indicator', () => {
  const m = { heapUsedMb: 10, requests: { total: 100 }, errors: { total: 0 }, responseTime: { count: 100, avgMs: 10, minMs: 5, maxMs: 20 }, uptimeSeconds: 1000, memory: {} };
  const res = getHealthIndicators(m);
  assert.ok(res.indicators.some(i => i.name === 'Application health'), 'includes app health');
  assert.equal(res.indicators[0].name, 'Application health');
});

// ---- Dashboard integration ----
const OWNER = { id: 30, google_user_id: 'google-owner2', email: 'owner2@example.com', name: 'Owner2', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 31, google_user_id: 'google-admin2', email: 'admin2@example.com', name: 'Admin2', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 32, google_user_id: 'google-user2', email: 'user2@example.com', name: 'User2', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };
const SID_OWNER = 'health-owner-sid';
const SID_ADMIN = 'health-admin-sid';
const SID_USER = 'health-user-sid';
const COOKIE_OWNER = `connect.sid=s:${cookieSignature.sign(SID_OWNER, process.env.SESSION_SECRET)}`;
const COOKIE_ADMIN = `connect.sid=s:${cookieSignature.sign(SID_ADMIN, process.env.SESSION_SECRET)}`;
const COOKIE_USER = `connect.sid=s:${cookieSignature.sign(SID_USER, process.env.SESSION_SECRET)}`;
const sessionToUser = { [SID_OWNER]: OWNER, [SID_ADMIN]: ADMIN, [SID_USER]: USER };

let server, port, originalQuery;

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

const http = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);

test('Dashboard shows health indicators with Healthy/Warning/Critical', async () => {
  resetMetrics();
  // create healthy baseline: low heap, low errors, fast response
  for (let i=0;i<30;i++) recordRequest(200, 20);
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /System Health & Scaling Indicators/);
  assert.match(html, /Overall system status/);
  // should contain at least one Healthy badge (since we are healthy)
  assert.match(html, /Healthy/);
  assert.match(html, /Memory \/ Heap/);
  assert.match(html, /Error rate/);
  assert.match(html, /Response time/);
  assert.match(html, /Request \/ Activity level/);
  assert.match(html, /Application health/);
  // advisory note
  assert.match(html, /advisory only/i);
});

test('Dashboard warning scenario renders correctly', async () => {
  resetMetrics();
  // Force warning via memory: simulate high heap by monkey-patching process.memoryUsage? Instead we can directly test via metrics heapUsedMb
  // Safer to trigger error rate warning: 6 errors / 100 total = 6% > 5% warning
  for (let i=0;i<94;i++) recordRequest(200, 20);
  for (let i=0;i<6;i++) recordRequest(500, 20);
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_OWNER } });
  const html = await res.text();
  // Should show Warning overall and recommendation
  assert.match(html, /Warning/);
  assert.match(html, /Usage is increasing; continue monitoring\./);
  // detail should be present
  assert.match(html, /Error rate/);
});

test('Dashboard critical scenario renders correctly', async () => {
  resetMetrics();
  for (let i=0;i<85;i++) recordRequest(200, 20);
  for (let i=0;i<15;i++) recordRequest(500, 20); // 15% error => critical
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  const html = await res.text();
  assert.match(html, /Critical/);
  assert.match(html, /Capacity concern detected; consider reviewing server resources\./);
});

test('Owner/Admin access remains protected for health dashboard', async () => {
  const userRes = await http('/admin/system', { headers:{ Cookie: COOKIE_USER } });
  assert.equal(userRes.status, 403);
  assert.equal(await userRes.text(), 'Forbidden');
  const unauth = await http('/admin/system', { redirect:'manual' });
  assert.equal(unauth.status, 302);
  assert.equal(unauth.headers.get('location'), '/login');
  const adminOK = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  assert.equal(adminOK.status, 200);
  const ownerOK = await http('/admin/system', { headers:{ Cookie: COOKIE_OWNER } });
  assert.equal(ownerOK.status, 200);
});

test('Existing Phase 1 and Phase 2 metrics still displayed on dashboard', async () => {
  resetMetrics();
  recordContentAccess();
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  const html = await res.text();
  // Phase2 sections must still be present
  assert.match(html, /Total requests/);
  assert.match(html, /Content views/);
  assert.match(html, /PDF previews/);
  assert.match(html, /Average response time/);
});

test('Dashboard does not expose scaling to normal users via API', async () => {
  const apiUser = await http('/api/system/metrics', { headers:{ Cookie: COOKIE_USER } });
  assert.equal(apiUser.status, 403);
});

test('UI reuses existing styling and is compact', async () => {
  const res = await http('/admin/system', { headers:{ Cookie: COOKIE_ADMIN } });
  const html = await res.text();
  assert.match(html, /class="admin-table"/);
  assert.match(html, /class="stats"/);
  const viewSrc = fs.readFileSync(new URL('../src/views/admin-system.ejs', import.meta.url), 'utf8');
  assert.ok(viewSrc.includes('badgeFor') || viewSrc.includes('badge'), 'uses badge styling');
  assert.ok(!/googletag|adsbygoogle/.test(viewSrc), 'no ads');
});
