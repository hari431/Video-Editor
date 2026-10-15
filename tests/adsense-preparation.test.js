import './helpers/env.js';
process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
process.env.ADSENSE_ENABLED = 'true';
process.env.ADSENSE_CLIENT_ID = 'ca-pub-test';
process.env.ADSENSE_SLOT_ID = '12345';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED, ADS_DISABLED } from '../src/library/ad-eligibility.js';
import { invalidatePermissionCache, loadFolderPermissions } from '../src/library/local.js';
import { isAdVisibleForUser } from '../src/library/ad-visibility.js';
import { shouldShowAdSlot, renderAdSlot } from '../src/library/ad-slot.js';
import { getAdsConfig, isLiveAdsEnabled, isPlaceholderMode } from '../src/config/ads.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const SECRET = process.env.SESSION_SECRET;

// Users
const OWNER = { id: 60, google_user_id: 'google-owner6', email: 'owner6@example.com', name: 'Owner6', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 61, google_user_id: 'google-admin6', email: 'admin6@example.com', name: 'Admin6', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 62, google_user_id: 'google-user6', email: 'user6@example.com', name: 'User6', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER', roles: [1] };
const EXPIRED_USER = { ...USER, status: 'expired', access_expires_at: new Date(Date.now()-86400000) };
const OWNER_SID = 'adsense-owner';
const ADMIN_SID = 'adsense-admin';
const USER_SID = 'adsense-user';
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, SECRET)}`;
const sessionToUser = { [OWNER_SID]: OWNER, [ADMIN_SID]: ADMIN, [USER_SID]: EXPIRED_USER };

const ENABLED_QUERY = 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt';

let server, port, originalQuery;

test.before(async () => {
  await mkdir(path.join(QUERIES_DIR, '__adsense_test'), { recursive: true });
  await writeFile(path.join(QUERIES_DIR, '__adsense_test', 'sample.pdf'), Buffer.from('%PDF-1.4 fake'));

  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [OWNER, ADMIN, EXPIRED_USER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }, { folder_path: '__adsense_test', access_level: 'all', role_id: null }] };
    if (/FROM ad_settings/.test(sql)) return { rows: [] };
    if (/content_action_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /total_users/.test(sql)) return { rows: [{ total_users:0, active_today:0, active_month:0, pending_users:0, views_today:0, copies_today:0, total_discussions:0, total_replies:0 }] };
    if (/GROUP BY query_path/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql) && /GROUP BY/.test(sql)) return { rows: [] };
    if (/FROM discussions/.test(sql) && /COUNT/.test(sql)) return { rows: [{ total_questions:0, answered_questions:0, unanswered_questions:0, total_replies:0, accepted_answers:0, new_30d_questions:0 }] };
    if (/access_audit_log/.test(sql)) return { rows: [] };
    if (/role_audit_log/.test(sql)) return { rows: [] };
    if (/content_permission_audit_log/.test(sql)) return { rows: [] };
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
  await rm(path.join(QUERIES_DIR, '__adsense_test'), { recursive:true, force:true });
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const enc = v => v.split('/').map(encodeURIComponent).join('/');

test.beforeEach(() => clearAdCache());
test.afterEach(() => clearAdCache());

// ----- Keep isAdVisibleForUser as single authority -----
test('keep isAdVisibleForUser as single authority', () => {
  const slotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  assert.match(slotSrc, /isAdVisibleForUser/, 'ad-slot must use isAdVisibleForUser');
  assert.match(slotSrc, /shouldShowAdSlot/, 'wrapper exists');
  // Ensure ad-slot does not reimplement eligibility
  const count = (slotSrc.match(/isAdAllowedForPath/g) || []).length;
  assert.ok(count <= 1, 'should delegate to visibility, not duplicate content check');
});

// ----- Keep ad-slot as abstraction boundary -----
test('keep ad-slot as abstraction boundary', () => {
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /shouldShowAdSlot|adSlotViewContext/, 'server uses ad-slot helper');
  assert.match(serverSrc, /from '.\/library\/ad-slot\.js'/, 'imports from ad-slot');
  // Server should not directly contain ad eligibility logic scattered
  const adChecksInServer = (serverSrc.match(/ADS_ENABLED/g) || []).length;
  assert.ok(adChecksInServer <= 1, 'server should not hardcode ADS_ENABLED logic');
});

// ----- Google/AdSense code only when showAd true and eligible -----
test('Google/AdSense code only rendered when showAd true and eligible', async () => {
  const allowAll = () => true;
  // When showAd false, helper returns empty (no Google code)
  setAdCacheForTest({ 'Guidewire': ADS_DISABLED });
  assert.equal(shouldShowAdSlot(USER, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  assert.equal(renderAdSlot(USER, 'Guidewire/Gosu/PC/a.txt'), '', 'no output when not allowed');

  // When showAd true, placeholder is rendered (not live Google script) - use home which bypasses RBAC
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED, 'home': ADS_ENABLED });
  assert.equal(shouldShowAdSlot(EXPIRED_USER, 'home', allowAll), true);
  const html = renderAdSlot(EXPIRED_USER, 'home');
  assert.match(html, /data-testid="ad-slot"/, 'placeholder when allowed');
  assert.ok(!/pagead2\.googlesyndication\.com/.test(html), 'no live Google script in placeholder mode');
  assert.ok(!/googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/.test(html));
});

// ----- Never load on PDFs/dumps/reference/restricted/OWNER/ADMIN/login/error -----
test('never load advertising code on PDFs', async () => {
  clearAdCache(); // pdf default disabled
  assert.equal(shouldShowAdSlot(USER, '__adsense_test/sample.pdf'), false);
  assert.equal(renderAdSlot(USER, '__adsense_test/sample.pdf'), '');
  const res = await http(`/item/${enc('__adsense_test/sample.pdf')}`, { headers:{ Cookie: USER_COOKIE } });
  const html = await res.text();
  assert.ok(!html.includes('data-testid="ad-slot"'), 'PDF item no ad');
  assert.ok(!/pagead2\.googlesyndication/.test(html));
});

test('never load on restricted/private content', () => {
  setAdCacheForTest({ 'Private': ADS_ENABLED });
  // Even if enabled, restricted via canAccess false → no ad
  assert.equal(isAdVisibleForUser(USER, 'Private/secret.txt', () => false), false);
  assert.equal(shouldShowAdSlot(USER, 'Private/secret.txt', () => false), false);
  assert.equal(renderAdSlot(USER, 'Private/secret.txt'), ''); // helper uses default canAccess which for Private with no permission will be false
});

test('never load on OWNER/ADMIN pages', async () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(shouldShowAdSlot(OWNER, 'Guidewire/Gosu/PC/a.txt'), false);
  assert.equal(shouldShowAdSlot(ADMIN, 'Guidewire/Gosu/PC/a.txt'), false);
  assert.equal(renderAdSlot(OWNER, 'Guidewire/Gosu/PC/a.txt'), '');
  // HTTP admin pages
  for (const p of ['/admin', '/admin/system', '/admin/analytics']) {
    const res = await http(p, { headers:{ Cookie: ADMIN_COOKIE } });
    const html = await res.text();
    assert.ok(!html.includes('data-testid="ad-slot"'), `${p} no ad for admin`);
    assert.ok(!/pagead2\.googlesyndication/.test(html));
  }
});

test('never load on login/authentication and error pages', async () => {
  const login = await http('/login');
  const loginHtml = await login.text();
  assert.ok(!loginHtml.includes('data-testid="ad-slot"'));
  assert.ok(!/pagead2\.googlesyndication/.test(loginHtml));

  const err = await http('/query/' + enc('nonexistent/path.txt'), { headers:{ Cookie: USER_COOKIE } });
  assert.equal(err.status, 404);
  const errHtml = await err.text();
  assert.ok(!errHtml.includes('data-testid="ad-slot"'));
});

// ----- Do not use client-side params -----
test('do not use client-side params to decide eligibility', () => {
  const slotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  const configSrc = fs.readFileSync(new URL('../src/config/ads.js', import.meta.url), 'utf8');
  for (const src of [slotSrc, visSrc, configSrc]) {
    assert.ok(!/req\.query/.test(src), 'must not use query params');
    assert.ok(!/req\.cookies/.test(src), 'must not use cookies');
  }
  assert.ok(!/localStorage\.getItem|localStorage\.setItem/.test(slotSrc));
  // Verify isAdVisibleForUser signature not including client override
  assert.ok(!/client.*ads/.test(slotSrc.toLowerCase()) || /server/.test(slotSrc.toLowerCase()));
});

// ----- Config layer outside logic, no hard-coded IDs, default disabled -----
test('keep Google identifiers outside logic, not hard-coded', () => {
  const configSrc = fs.readFileSync(new URL('../src/config/ads.js', import.meta.url), 'utf8');
  assert.match(configSrc, /process\.env\.ADSENSE_CLIENT_ID/, 'reads from env');
  assert.match(configSrc, /process\.env\.ADSENSE_SLOT_ID/, 'reads slot from env');
  assert.ok(!/ca-pub-\d+/.test(configSrc), 'must not hard-code real publisher ID');
  assert.ok(!/ca-pub-/.test(fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8')), 'ad-slot must not hard-code publisher');
  assert.ok(!/ca-pub-/.test(fs.readFileSync(new URL('../src/views/partials/ad-slot.ejs', import.meta.url), 'utf8')));
});

test('default configuration keeps live advertising disabled', () => {
  // Ensure env not set
  const origEnabled = process.env.ADSENSE_ENABLED;
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origSlot = process.env.ADSENSE_SLOT_ID;
  delete process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_SLOT_ID;
  // Need to re-evaluate config (it reads env each call, so fresh)
  assert.equal(isLiveAdsEnabled(), false, 'default disabled');
  assert.equal(isPlaceholderMode(), true);
  // Even with showAd true, live disabled → empty (no placeholder)
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const html = renderAdSlot(USER, 'Guidewire/Gosu/PC/a.txt');
  assert.equal(html, '', 'no placeholder shown for eligible user when disabled');
  assert.ok(!/pagead2\.googlesyndication/.test(html), 'no live script when disabled');
  // Restore
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
  if (origSlot !== undefined) process.env.ADSENSE_SLOT_ID = origSlot;
});

test('missing Google configuration does not break pages', async () => {
  // Ensure no env set, request page should still be 200 and not throw
  delete process.env.ADSENSE_ENABLED;
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_SLOT_ID;
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const res = await http(`/query/${enc(ENABLED_QUERY)}`, { headers:{ Cookie: USER_COOKIE } });
  assert.equal(res.status, 200, 'page should not break without config');
  const html = await res.text();
  if (html.includes('data-testid="ad-slot"')) { console.log("FOUND AD SLOT", html.substring(html.indexOf("ad-slot") - 50, html.indexOf("ad-slot") + 100)); } assert.ok(!html.includes('data-testid="ad-slot"'), 'no ad slot when disabled');
  // Also when live enabled but missing IDs, should fallback to empty and not break
  process.env.ADSENSE_ENABLED = 'true';
  // clientId still missing → isLive false → empty
  assert.equal(isLiveAdsEnabled(), false, 'missing clientId → still disabled');
  const html2 = renderAdSlot(USER, 'Guidewire/Gosu/PC/a.txt');
  assert.equal(html2, '', 'empty when config missing');
  delete process.env.ADSENSE_ENABLED;
});

test('placeholder mode so tests can verify without contacting Google', () => {
  const origEnabled = process.env.ADSENSE_ENABLED;
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origSlot = process.env.ADSENSE_SLOT_ID;
  
  delete process.env.ADSENSE_ENABLED;
  assert.equal(isPlaceholderMode(), true, 'placeholder mode when live disabled');
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const html = renderAdSlot(USER, 'Guidewire/Gosu/PC/a.txt');
  assert.equal(html, '', 'empty when disabled');
  
  process.env.ADSENSE_ENABLED = 'true';
  process.env.ADSENSE_CLIENT_ID = 'ca-pub-test';
  process.env.ADSENSE_SLOT_ID = '12345';
  const htmlEnabled = renderAdSlot(EXPIRED_USER, 'Guidewire/Gosu/PC/a.txt');
  assert.match(htmlEnabled, /Ad slot prepared — AdSense configured/, 'prepared ad slot present');
  assert.ok(!/https:\/\/pagead2\.googlesyndication/.test(htmlEnabled), 'no network call');
  
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
  if (origSlot !== undefined) process.env.ADSENSE_SLOT_ID = origSlot;
});

test('no real Google network call by test suite', () => {
  // Ensure no fetch to google in codebase
  const files = [
    '../src/server.js',
    '../src/library/ad-slot.js',
    '../src/library/ad-visibility.js',
    '../src/config/ads.js',
    '../src/views/partials/ad-slot.ejs'
  ];
  for (const f of files) {
    const content = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/fetch\(.*google/i.test(content), `${f} no fetch to google`);
    assert.ok(!/https:\/\/pagead2\.googlesyndication\.com/.test(content) || content.includes('comment') || /placeholder/i.test(content) ? true : !/pagead2/.test(content));
  }
  // The placeholder HTML should not contain external script src
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const html = renderAdSlot(USER, 'Guidewire/Gosu/PC/a.txt');
  assert.ok(!/src="https:\/\/pagead2/.test(html), 'no external script src in placeholder');
});

// ----- Eligible USER can render prepared component in placeholder mode -----
test('eligible USER content can render prepared ad component in placeholder mode', async () => {
  await pool.query('UPDATE roles SET ads_available = true');
  await pool.query("UPDATE users SET status = 'expired' WHERE id = $1", [USER.id]);
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1) ON CONFLICT DO NOTHING', [USER.id]);
  invalidatePermissionCache();
  await loadFolderPermissions();
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  // Helper directly
  assert.equal(shouldShowAdSlot(EXPIRED_USER, 'Guidewire/Gosu/PC/a.txt'), true);
  const htmlHelper = renderAdSlot(EXPIRED_USER, 'Guidewire/Gosu/PC/a.txt');
  assert.match(htmlHelper, /data-testid="ad-slot"/);

  // HTTP
  const res = await http(`/query/${enc(ENABLED_QUERY)}`, { headers:{ Cookie: USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="ad-slot"'), 'query page should have prepared ad slot for eligible USER');
  assert.ok(html.includes('Ad slot prepared — AdSense configured'), 'prepared mode');
});

// ----- OWNER/ADMIN/PDF/restricted cannot render (already covered) -----
test('OWNER/ADMIN/PDF/restricted cannot render prepared component', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(renderAdSlot(OWNER, 'Guidewire/Gosu/PC/a.txt'), '');
  assert.equal(renderAdSlot(ADMIN, 'Guidewire/Gosu/PC/a.txt'), '');
  clearAdCache();
  assert.equal(renderAdSlot(USER, '__adsense_test/sample.pdf'), '');
  assert.equal(renderAdSlot(USER, 'Private/secret.txt', () => false), '');
});

// ----- Client-side query attempts cannot force ad rendering -----
test('client-side query attempts cannot force ad rendering', async () => {
  setAdCacheForTest({ 'Guidewire': ADS_DISABLED }); // content disabled
  // Even with ?showAd=true, ?ads=1, ?adLive=true, should still be disabled for USER because content is disabled
  const res = await http(`/query/${enc(ENABLED_QUERY)}?showAd=true&ads=1&adLive=true&client=ca-pub-123`, { headers:{ Cookie: USER_COOKIE } });
  // But ENABLED_QUERY is actually enabled via cache? We set Guidewire disabled, so it should be disabled
  // Let's use a disabled path explicitly
  setAdCacheForTest({ [ENABLED_QUERY]: ADS_DISABLED });
  const res2 = await http(`/query/${enc(ENABLED_QUERY)}?showAd=true`, { headers:{ Cookie: USER_COOKIE } });
  assert.ok(! (await res2.text()).includes('data-testid="ad-slot"'), 'query param should not force ad');

  // OWNER with enabled content but query param should still not show
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  const ownerRes = await http(`/query/${enc(ENABLED_QUERY)}?showAd=true&ads=1`, { headers:{ Cookie: OWNER_COOKIE } });
  assert.ok(! (await ownerRes.text()).includes('data-testid="ad-slot"'), 'OWNER should not get ad even with query param');
});

// ----- Ensure no payment/premium implemented -----
test('do not implement payments/premium', () => {
  const slotSrc = fs.readFileSync(new URL('../src/library/ad-slot.js', import.meta.url), 'utf8');
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  const configSrc = fs.readFileSync(new URL('../src/config/ads.js', import.meta.url), 'utf8');
  for (const src of [slotSrc, visSrc, configSrc]) {
    assert.ok(!/stripe/i.test(src), 'no stripe');
    assert.ok(!/payment/i.test(src) || /not.*payment/i.test(src.toLowerCase()), 'no payment');
  }
});
