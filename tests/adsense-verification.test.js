import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED } from '../src/library/ad-eligibility.js';
import { getAdsConfig, isLiveAdsEnabled } from '../src/config/ads.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const SECRET = process.env.SESSION_SECRET;
const PUBLISHER_ID = 'ca-pub-7858693637239882';

const USER = { id: 80, google_user_id: 'google-user8', email: 'user8@example.com', name: 'User8', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };
const OWNER = { id: 81, google_user_id: 'google-owner8', email: 'owner8@example.com', name: 'Owner8', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const USER_SID = 'adsense-verify-user';
const OWNER_SID = 'adsense-verify-owner';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, SECRET)}`;
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, SECRET)}`;
const sessionToUser = { [USER_SID]: USER, [OWNER_SID]: OWNER };

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
      const u = [USER, OWNER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
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
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.GOOGLE_ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_ENABLED;
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);

test.beforeEach(() => clearAdCache());
test.afterEach(() => clearAdCache());

test('verification meta tag appears when publisher ID is configured', async () => {
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origGoogle = process.env.GOOGLE_ADSENSE_CLIENT_ID;
  process.env.ADSENSE_CLIENT_ID = PUBLISHER_ID;
  // Need to ensure server reads new env per request (getAdsConfig reads process.env each time)
  const res = await http('/about');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`<meta name="google-adsense-account" content="${PUBLISHER_ID}">`), 'meta tag should appear with publisher ID');
  // Also check other public pages
  for (const p of ['/privacy', '/terms', '/content-policy', '/login']) {
    const r = await http(p);
    const h = await r.text();
    assert.match(h, new RegExp(`<meta name="google-adsense-account" content="${PUBLISHER_ID}">`), `${p} should have meta tag`);
  }
  // Restore
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient; else delete process.env.ADSENSE_CLIENT_ID;
  if (origGoogle !== undefined) process.env.GOOGLE_ADSENSE_CLIENT_ID = origGoogle; else delete process.env.GOOGLE_ADSENSE_CLIENT_ID;
});

test('meta tag is sourced from ADSENSE_CLIENT_ID env, not hard-coded in view', () => {
  const viewFiles = [
    '../src/views/about.ejs',
    '../src/views/privacy.ejs',
    '../src/views/terms.ejs',
    '../src/views/content-policy.ejs',
    '../src/views/library.ejs',
    '../src/views/partials/adsense-verification.ejs'
  ];
  for (const f of viewFiles) {
    const content = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!content.includes(PUBLISHER_ID), `${f} should not hard-code publisher ID, must source from env`);
  }
  const partial = fs.readFileSync(new URL('../src/views/partials/adsense-verification.ejs', import.meta.url), 'utf8');
  assert.match(partial, /adsenseClientId/, 'partial must use adsenseClientId variable');
  assert.match(partial, /google-adsense-account/, 'partial must have correct meta name');
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /adsenseClientId/, 'server must set res.locals.adsenseClientId');
  assert.match(serverSrc, /getAdsConfig/, 'server must source from config');
});

test('meta tag rendered safely when ADSENSE_CLIENT_ID missing', async () => {
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origGoogle = process.env.GOOGLE_ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.GOOGLE_ADSENSE_CLIENT_ID;
  const res = await http('/about');
  assert.equal(res.status, 200);
  const html = await res.text();
  // Should not contain meta with empty content, and should not break page
  assert.ok(!html.includes('content=""'), 'should not render empty content meta');
  // Either no meta tag or no broken tag
  assert.ok(!html.match(/<meta name="google-adsense-account" content="">/), 'should not render empty');
  // Page should still render correctly
  assert.match(html, /About Learn with me/);
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
  if (origGoogle !== undefined) process.env.GOOGLE_ADSENSE_CLIENT_ID = origGoogle;
});

test('no live AdSense script is loaded', async () => {
  const origClient = process.env.ADSENSE_CLIENT_ID;
  process.env.ADSENSE_CLIENT_ID = PUBLISHER_ID;
  // Even when client ID is configured, live script should not load because ADSENSE_ENABLED is false
  const res = await http('/about');
  const html = await res.text();
  assert.ok(!/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/.test(html), 'no live script even with ID');
  assert.ok(!/adsbygoogle\.js/.test(html), 'no live script file');
  // Also for authenticated content page
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const qRes = await http('/query/Guidewire/Gosu/PC/Rating/Partial%20worksheet%20print.txt', { headers:{ Cookie: USER_COOKIE } });
  const qHtml = await qRes.text();
  assert.ok(!/pagead2\.googlesyndication/.test(qHtml), 'query page no live script');
  // Check that verification meta is present but script not
  assert.match(html, /google-adsense-account/);
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient; else delete process.env.ADSENSE_CLIENT_ID;
});

test('ADSENSE_ENABLED remains false by default', () => {
  const origEnabled = process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_SLOT_ID;
  assert.equal(isLiveAdsEnabled(), false, 'live disabled by default');
  assert.equal(getAdsConfig().enabled, false);
  const cfg = getAdsConfig();
  assert.equal(cfg.enabled, false);
  // Even with client ID but not enabled, still disabled
  process.env.ADSENSE_CLIENT_ID = PUBLISHER_ID;
  assert.equal(isLiveAdsEnabled(), false, 'still disabled without ADSENSE_ENABLED=true');
  delete process.env.ADSENSE_CLIENT_ID;
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
});

test('verification meta present on public site, not only auth pages', async () => {
  process.env.ADSENSE_CLIENT_ID = PUBLISHER_ID;
  // Public pages should have meta
  for (const p of ['/about', '/privacy', '/terms', '/content-policy', '/login']) {
    const res = await http(p);
    const html = await res.text();
    assert.match(html, /google-adsense-account/, `${p} should have verification meta`);
  }
  // Authenticated home also should have meta (common head)
  const homeRes = await http('/', { headers:{ Cookie: USER_COOKIE } });
  assert.match(await homeRes.text(), /google-adsense-account/, 'home should also have meta when configured');
  delete process.env.ADSENSE_CLIENT_ID;
});

test('no client-side mechanism can force verification meta', () => {
  const partialSrc = fs.readFileSync(new URL('../src/views/partials/adsense-verification.ejs', import.meta.url), 'utf8');
  assert.ok(!/req\.query/.test(partialSrc));
  assert.ok(!/req\.cookies/.test(partialSrc));
  assert.ok(!/localStorage/.test(partialSrc));
  const configSrc = fs.readFileSync(new URL('../src/config/ads.js', import.meta.url), 'utf8');
  assert.match(configSrc, /process\.env\.ADSENSE_CLIENT_ID/);
});

test('existing ad eligibility and placement still enforced', async () => {
  // OWNER still no ad slot even with verification meta
  process.env.ADSENSE_CLIENT_ID = PUBLISHER_ID;
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const ownerRes = await http('/', { headers:{ Cookie: OWNER_COOKIE } });
  const ownerHtml = await ownerRes.text();
  assert.ok(ownerHtml.includes('google-adsense-account'), 'OWNER page has verification meta but still no ad slot');
  assert.ok(!ownerHtml.includes('data-testid="ad-slot"'), 'OWNER still no ad slot');

  // USER on PDF still no ad slot but has meta
  await http('/item/__launch_test/sample.pdf', { headers:{ Cookie: USER_COOKIE } }).then(async r=>{
    const h = await r.text();
    // PDF may be 404 if not exists, but should not have ad slot
    assert.ok(!h.includes('data-testid="ad-slot"'));
  });
  delete process.env.ADSENSE_CLIENT_ID;
});
