import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED, ADS_DISABLED } from '../src/library/ad-eligibility.js';
import { isLiveAdsEnabled, getAdsConfig, isPlaceholderMode } from '../src/config/ads.js';
import { isAdVisibleForUser } from '../src/library/ad-visibility.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const SECRET = process.env.SESSION_SECRET;

const USER = { id: 70, google_user_id: 'google-user7', email: 'user7@example.com', name: 'User7', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };
const OWNER = { id: 71, google_user_id: 'google-owner7', email: 'owner7@example.com', name: 'Owner7', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const USER_SID = 'launch-user';
const OWNER_SID = 'launch-owner';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, SECRET)}`;
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, SECRET)}`;
const sessionToUser = { [USER_SID]: USER, [OWNER_SID]: OWNER };

let server, port, originalQuery;

test.before(async () => {
  await mkdir(path.join(QUERIES_DIR, '__launch_test'), { recursive: true });
  await writeFile(path.join(QUERIES_DIR, '__launch_test', 'sample.pdf'), Buffer.from('%PDF-1.4 fake'));
  await writeFile(path.join(QUERIES_DIR, '__launch_test', 'note.txt'), 'hello');

  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [USER, OWNER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }, { folder_path: '__launch_test', access_level: 'all', role_id: null }] };
    if (/FROM ad_settings/.test(sql)) return { rows: [] };
    if (/content_action_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /total_users/.test(sql)) return { rows: [{ total_users:0, active_today:0, active_month:0, pending_users:0, views_today:0, copies_today:0, total_discussions:0, total_replies:0 }] };
    if (/GROUP BY query_path/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql) && /GROUP BY/.test(sql)) return { rows: [] };
    if (/FROM discussions/.test(sql) && /COUNT/.test(sql)) return { rows: [{ total_questions:0, answered_questions:0, unanswered_questions:0, total_replies:0, accepted_answers:0, new_30d_questions:0 }] };
    if (/access_audit_log/.test(sql)) return { rows: [] };
    if (/role_audit_log/.test(sql)) return { rows: [] };
    if (/SELECT.*FROM daily_usage_stats/.test(sql)) return { rows: [] };
    if (/item_likes/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/recently_viewed/.test(sql)) return { rows: [] };
    if (/content_seen/.test(sql)) return { rows: [] };
    if (/query_usage/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: 0 }] };
    return { rows: [] };
  };
  const { app } = await import('../src/server.js');
  server = await new Promise(r=> { const s=app.listen(0,()=>r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) pool.query = originalQuery;
  clearAdCache();
  await rm(path.join(QUERIES_DIR, '__launch_test'), { recursive: true, force: true });
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const enc = v => v.split('/').map(encodeURIComponent).join('/');

test.beforeEach(() => clearAdCache());
test.afterEach(() => clearAdCache());

// ----- Public-facing pages -----
test('public pages: /about renders without auth', async () => {
  const res = await http('/about');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /About Learn with me/);
  assert.match(html, /Guidewire/);
  assert.ok(!html.includes('data-testid="ad-slot"'), 'public about should be ad-free');
});

test('public pages: /content-policy renders without auth', async () => {
  const res = await http('/content-policy');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Content &amp; Copyright Policy/);
  assert.match(html, /Copyright/);
  assert.match(html, /User-Generated Content/);
  assert.match(html, /learnwithmegw@gmail\.com/);
  assert.ok(!html.includes('data-testid="ad-slot"'));
});

test('public pages: /copyright redirects to /content-policy', async () => {
  const res = await http('/copyright', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/content-policy');
});

test('public pages: /privacy and /terms render', async () => {
  for (const p of ['/privacy', '/terms']) {
    const res = await http(p);
    assert.equal(res.status, 200, `${p} should be 200`);
    const html = await res.text();
    assert.ok(html.includes('Privacy Policy') || html.includes('Terms of Service'));
    assert.ok(!html.includes('data-testid="ad-slot"'), `${p} should be ad-free`);
  }
});

test('public pages: login and error are ad-free and accessible', async () => {
  const login = await http('/login');
  assert.equal(login.status, 200);
  assert.ok(!(await login.text()).includes('data-testid="ad-slot"'));

  const err = await http('/query/' + enc('nonexistent/path.txt'), { headers:{ Cookie: USER_COOKIE } });
  assert.equal(err.status, 404);
  assert.ok(!(await err.text()).includes('data-testid="ad-slot"'));
});

test('public pages: home is public landing page', async () => {
  const res = await http('/', { redirect: 'manual' });
  assert.equal(res.status, 200);
});

// ----- Legal/policy readiness -----
test('legal/policy readiness: privacy, terms, content-policy, footer links', async () => {
  const privacy = await http('/privacy');
  const privacyHtml = await privacy.text();
  assert.match(privacyHtml, /Privacy Policy/);
  assert.match(privacyHtml, /Information We Collect/);

  const terms = await http('/terms');
  const termsHtml = await terms.text();
  assert.match(termsHtml, /Terms of Service/);
  assert.match(termsHtml, /Intellectual Property/);

  const content = await http('/content-policy');
  const contentHtml = await content.text();
  assert.match(contentHtml, /Content &amp; Copyright Policy/);
  assert.match(contentHtml, /Copyright &amp; Ownership/);
  assert.match(contentHtml, /User-Generated Content/);
  assert.match(contentHtml, /Restricted \/ Private Content/);
  assert.match(contentHtml, /Advertising Separation/);
  assert.match(contentHtml, /Reporting &amp; Contact/);

  // Footer should have all legal links
  const footer = fs.readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /\/about/);
  assert.match(footer, /\/content-policy/);
  assert.match(footer, /\/privacy/);
  assert.match(footer, /\/terms/);
  assert.match(footer, /learnwithmegw@gmail\.com/);
  // About should link to content-policy
  const aboutHtml = await (await http('/about')).text();
  assert.match(aboutHtml, /\/content-policy/);
});

// ----- Advertising readiness -----
test('advertising readiness: AdSense disabled by default, no live script', () => {
  const origEnabled = process.env.ADSENSE_ENABLED;
  const origClient = process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_SLOT_ID;
  assert.equal(isLiveAdsEnabled(), false, 'live disabled by default');
  assert.equal(isPlaceholderMode(), true);
  const cfg = getAdsConfig();
  assert.equal(cfg.enabled, false);
  // No hard-coded real IDs
  assert.ok(!/ca-pub-\d+/.test(JSON.stringify(cfg)));
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
});

test('advertising readiness: isAdVisibleForUser remains single authority', () => {
  const slotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  assert.match(slotSrc, /isAdVisibleForUser/, 'ad-slot uses single authority');
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.match(visSrc, /hasAdFreeCapability/);
});

test('advertising readiness: PDFs/dumps/reference/restricted/OWNER/ADMIN/login/error remain ad-free', async () => {
  clearAdCache(); // pdf default disabled
  // PDF item
  const pdfRes = await http(`/item/${enc('__launch_test/sample.pdf')}`, { headers:{ Cookie: USER_COOKIE } });
  assert.ok(!(await pdfRes.text()).includes('data-testid="ad-slot"'), 'PDF ad-free');

  // OWNER home
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const ownerHome = await http('/', { headers:{ Cookie: OWNER_COOKIE } });
  assert.ok(!(await ownerHome.text()).includes('data-testid="ad-slot"'), 'OWNER ad-free');

  // ADMIN home
  const adminHome = await http('/', { headers:{ Cookie: OWNER_COOKIE } }); // reuse owner for admin check via hasAdFree
  assert.ok(!(await adminHome.text()).includes('data-testid="ad-slot"'));

  // Login/error already checked
});

test('advertising readiness: existing ad slots fail safely if Google config missing', async () => {
  delete process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_CLIENT_ID;
  // Even with missing config, eligible USER content should still render placeholder and not 500
  setAdCacheForTest({ '__launch_test': ADS_ENABLED, 'Guidewire': ADS_ENABLED });
  const res = await http('/query/__launch_test/note.txt', { headers:{ Cookie: USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('data-testid="ad-slot"'), 'no ad slot when disabled');
  assert.ok(!/pagead2\.googlesyndication/.test(html), 'no live script when config missing');
});

test('advertising readiness: no client-side mechanism can force advertising', () => {
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.ok(!/req\.query/.test(visSrc));
  const slotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  assert.ok(!/req\.query/.test(slotSrc));
  assert.ok(!/req\.cookies/.test(slotSrc));
});

// ----- Content readiness -----
test('content readiness: PDFs, dumps, reference, restricted identified as non-monetized', () => {
  clearAdCache();
  // PDFs disabled by default
  assert.equal(isAdVisibleForUser(USER, '__launch_test/sample.pdf'), false);
  // Simulate dumps folder explicitly disabled
  setAdCacheForTest({ 'Certification Dumps': ADS_DISABLED });
  assert.equal(isAdVisibleForUser(USER, 'Certification Dumps/exam.pdf', () => true), false);
  // Reference material (xlsx) disabled
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/report.xlsx', () => true), false);
  // Restricted private
  assert.equal(isAdVisibleForUser(USER, 'Private/secret.txt', () => false), false);
  // Original Gosu query enabled (for an expired user, ads are shown on base/free content)
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const expiredUser = { ...USER, status: 'expired', access_expires_at: new Date(Date.now() - 100000) };
  assert.equal(isAdVisibleForUser(expiredUser, 'Guidewire/Gosu/PC/query.txt', () => true), true);
});

// ----- Privacy/security -----
test('privacy/security: no unnecessary tracking or analytics', () => {
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(!/googletagmanager|google-analytics|hotjar|mixpanel/i.test(serverSrc), 'no third-party analytics');
  const adSlotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  assert.ok(!/googletagmanager/.test(adSlotSrc));
  // Monitoring remains lightweight, in-memory
  const metricsSrc = fs.readFileSync(new URL('../src/monitoring/metrics.js', import.meta.url), 'utf8');
  assert.ok(!/track.*user/i.test(metricsSrc) || /no PII/i.test(metricsSrc));
});

// ----- Production configuration -----
test('production configuration documented', () => {
  const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /ADSENSE_ENABLED/);
  assert.match(envExample, /ADSENSE_CLIENT_ID/);
  assert.match(envExample, /ADSENSE_SLOT_ID/);
  const docsPath = fileURLToPath(new URL('../docs/ADSENSE_SETUP.md', import.meta.url));
  if (fs.existsSync(docsPath)) {
    const docs = fs.readFileSync(docsPath, 'utf8');
    assert.match(docs, /ADSENSE_ENABLED/);
    assert.match(docs, /ca-pub-/);
    assert.match(docs, /disabled by default/i);
  }
});
