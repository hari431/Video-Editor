import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  parseExternalFileContent,
  parseExternalWatermarkValue
} from '../src/library/local.js';
import {
  resolveVideoWatermarkEnabled,
  resolveWatermarkVisible,
  buildVideoProtectionContext
} from '../src/library/video-protection.js';
import { resolveBrandOverlayVisible } from '../src/library/video-branding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '..', 'queries');
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// --- Parser: backward compatibility ------------------------------------------------
test('watermark: URL-only entries behave exactly as before', () => {
  const raw = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n';
  const out = parseExternalFileContent(raw);
  assert.equal(out.externalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(out.pinned, []);
  assert.equal(out.cleanContent, raw.replace(/\n$/, '\n'));
  assert.equal(out.watermark, null);
});

test('watermark: non-string input keeps null watermark', () => {
  assert.deepEqual(parseExternalFileContent(null), { externalUrl: '', pinned: [], cleanContent: '', watermark: null });
  assert.deepEqual(parseExternalFileContent(''), { externalUrl: '', pinned: [], cleanContent: '', watermark: null });
});

// --- Parser: true/false variants ------------------------------------------------------
test('watermark: true values (case-insensitive, whitespace-tolerant)', () => {
  for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', 'on', 'ON']) {
    const out = parseExternalFileContent(`${YT}\nWatermark: ${value}\n`);
    assert.equal(out.watermark, true, value);
    assert.equal(out.externalUrl, YT);
    assert.ok(!out.cleanContent.match(/watermark/i), `directive consumed (${value})`);
  }
});

test('watermark: false values (case-insensitive, whitespace-tolerant)', () => {
  for (const value of ['false', 'FALSE', ' False ', '0', 'no', 'NO', 'off', 'OFF']) {
    const out = parseExternalFileContent(`${YT}\nwatermark:${value}\n`);
    assert.equal(out.watermark, false, value);
    assert.equal(out.externalUrl, YT);
  }
});

test('watermark: directive works before the URL and beside Pinned lines', () => {
  const raw = `Watermark: true\n${YT}\nPinned: Guide | https://example.com/a\n`;
  const out = parseExternalFileContent(raw);
  assert.equal(out.watermark, true);
  assert.equal(out.externalUrl, YT);
  assert.equal(out.pinned.length, 1);
  assert.equal(out.pinned[0].url, 'https://example.com/a');
  assert.ok(!out.cleanContent.match(/watermark/i));
});

test('watermark: invalid values are ignored and stay visible (as today)', () => {
  const raw = `${YT}\nWatermark: maybe\n`;
  const out = parseExternalFileContent(raw);
  assert.equal(out.watermark, null);
  assert.equal(out.externalUrl, YT);
  assert.ok(out.cleanContent.includes('Watermark: maybe'), 'unrecognized line stays visible');
});

test('watermark: first valid value wins, later ones are still consumed', () => {
  const out = parseExternalFileContent(`${YT}\nWatermark: false\nWatermark: true\n`);
  assert.equal(out.watermark, false);
  assert.ok(!out.cleanContent.match(/watermark/i));
});

test('watermark: value parser matrix', () => {
  assert.equal(parseExternalWatermarkValue('true'), true);
  assert.equal(parseExternalWatermarkValue('  OFF  '), false);
  assert.equal(parseExternalWatermarkValue('banana'), null);
  assert.equal(parseExternalWatermarkValue(''), null);
  assert.equal(parseExternalWatermarkValue(null), null);
});

// --- Resolver ---------------------------------------------------------------------------
test('watermark: explicit flag always wins, null keeps role default', () => {
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: true, protectionEnabled: false }), true);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: true, protectionEnabled: true }), true);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: false, protectionEnabled: true }), false);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: false, protectionEnabled: false }), false);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: null, protectionEnabled: true }), true);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: null, protectionEnabled: false }), false);
  assert.equal(resolveVideoWatermarkEnabled({}), false);
  assert.equal(resolveVideoWatermarkEnabled(), false);
});

// --- Pill visibility (split from protection) ------------------------------------------------------------
test('watermark: pill visibility hides only the pill, never protection', () => {
  assert.equal(resolveWatermarkVisible({ fileWatermark: false, protectionEnabled: true }), false);
  assert.equal(resolveWatermarkVisible({ fileWatermark: false, protectionEnabled: false }), false);
  assert.equal(resolveWatermarkVisible({ fileWatermark: true, protectionEnabled: false }), true);
  assert.equal(resolveWatermarkVisible({ fileWatermark: true, protectionEnabled: true }), true);
  assert.equal(resolveWatermarkVisible({ fileWatermark: null, protectionEnabled: true }), true);
  assert.equal(resolveWatermarkVisible({ fileWatermark: null, protectionEnabled: false }), false);
  assert.equal(resolveWatermarkVisible({}), false);
  assert.equal(resolveWatermarkVisible(), false);
});

// --- Brand overlay visibility ----------------------------------------------------------------------
test('watermark: Watermark:false hides the brand overlay; store value otherwise rules', () => {
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: false, brandingEnabled: true }), false);
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: false, brandingEnabled: false }), false);
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: true, brandingEnabled: true }), true);
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: true, brandingEnabled: false }), false);
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: null, brandingEnabled: true }), true);
  assert.equal(resolveBrandOverlayVisible({ fileWatermark: null, brandingEnabled: false }), false);
  assert.equal(resolveBrandOverlayVisible({}), true);
  assert.equal(resolveBrandOverlayVisible(), true);
});

// --- Context builder -----------------------------------------------------------------------
// maskedEmail derives from ADMIN_EMAILS; pin it so unit assertions are env-independent.
test('watermark: default context behavior unchanged without options', () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'watermark-contact@example.com';
  try {
    const user = { id: 1, app_role: 'USER', status: 'active', name: 'Normal User' };
    const admin = { id: 2, app_role: 'ADMIN', status: 'active', name: 'Admin User' };
    const req = sid => ({ user, sessionID: sid });
    const onUser = buildVideoProtectionContext(req('sessuser1'), 'a/b.txt', 'youtube');
    assert.equal(onUser.enabled, true);
    assert.ok(onUser.maskedEmail.length > 0);
    const onAdmin = buildVideoProtectionContext({ user: admin, sessionID: 'sessadmin1' }, 'a/b.txt', 'youtube');
    assert.equal(onAdmin.enabled, false);
    assert.equal(onAdmin.maskedEmail, '');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});

test('watermark: force override populates identity fields when enabling', () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'watermark-contact@example.com';
  try {
    const admin = { id: 2, app_role: 'ADMIN', status: 'active', name: 'Admin User' };
    const forced = buildVideoProtectionContext({ user: admin, sessionID: 'sessadmin2' }, 'a/b.txt', 'youtube', { forceWatermark: true });
    assert.equal(forced.enabled, true);
    assert.ok(forced.maskedEmail.length > 0);
    assert.equal(forced.viewerName, 'Admin User');
    const user = { id: 1, app_role: 'USER', status: 'active', name: 'Normal User' };
    const suppressed = buildVideoProtectionContext({ user, sessionID: 'sessuser2' }, 'a/b.txt', 'youtube', { forceWatermark: false });
    assert.equal(suppressed.enabled, false);
    assert.equal(suppressed.maskedEmail, '');
    const neutral = buildVideoProtectionContext({ user, sessionID: 'sessuser3' }, 'a/b.txt', 'youtube', { forceWatermark: null });
    assert.equal(neutral.enabled, true);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});

// --- HTTP: per-video flag drives the rendered overlay ------------------------------------------
const OVERLAY = '<div class="video-watermark is-protected"';

function mockPoolFor(SID, USER, folder) {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: folder, access_level: 'all', role_id: null }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/SELECT COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/SELECT id FROM item_likes/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return () => { pool.query = origQuery; pool.connect = origConnect; };
}

async function clearCaches() {
  const { _clearLibraryCache } = await import('../src/server.js');
  _clearLibraryCache();
  const { invalidatePermissionCache } = await import('../src/library/local.js');
  invalidatePermissionCache();
}

test('watermark: HTTP overlay follows the per-video flag (user off, admin on)', async () => {
  const tmpRoot = path.join(QUERIES_DIR, '__external_watermark_test');
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(path.join(tmpRoot, 'External - WmOff.txt'), `${YT}\nWatermark: false\n`);
  await writeFile(path.join(tmpRoot, 'External - WmOn.txt'), `${YT}\nWatermark: true\n`);
  await writeFile(path.join(tmpRoot, 'External - WmPlain.txt'), `${YT}\n`);
  const base = { first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const USER = { id: 6101, google_user_id: 'google-wm-user', email: 'wmuser@example.com', name: 'Wm User', status: 'active', app_role: 'USER', ...base };
  const ADMIN = { id: 6102, google_user_id: 'google-wm-admin', email: 'wmadmin@example.com', name: 'Wm Admin', status: 'active', app_role: 'ADMIN', ...base };
  const SID_U = 'wm-user-sid';
  const SID_A = 'wm-admin-sid';
  const COOKIE_U = `connect.sid=s:${cookieSignature.sign(SID_U, process.env.SESSION_SECRET)}`;
  const COOKIE_A = `connect.sid=s:${cookieSignature.sign(SID_A, process.env.SESSION_SECRET)}`;
  const restoreU = mockPoolFor(SID_U, USER, '__external_watermark_test');
  const { app } = await import('../src/server.js');
  await clearCaches();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const http = (p, cookie) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: cookie } });
  try {
    // Control: regular user, URL-only file → overlay present (today's behavior)
    const plain = await http('/external/__external_watermark_test/External%20-%20WmPlain.txt', COOKIE_U);
    assert.equal(plain.status, 200);
    assert.ok((await plain.text()).includes(OVERLAY), 'default watermark renders for non-exempt user');

    // Explicit false → overlay gone for the same non-exempt user
    const off = await http('/external/__external_watermark_test/External%20-%20WmOff.txt', COOKIE_U);
    assert.equal(off.status, 200);
    assert.ok(!(await off.text()).includes(OVERLAY), 'Watermark: false suppresses the overlay');
  } finally {
    await new Promise(r => server.close(r));
    restoreU();
  }

  // Admin leg needs its own session mapping
  const restoreA = mockPoolFor(SID_A, ADMIN, '__external_watermark_test');
  await clearCaches();
  const server2 = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port2 = server2.address().port;
  const http2 = (p, cookie) => fetch(`http://127.0.0.1:${port2}${p}`, { headers: { Cookie: cookie } });
  try {
    // Control: admin, URL-only file → no overlay (today's exemption)
    const plainA = await http2('/external/__external_watermark_test/External%20-%20WmPlain.txt', COOKIE_A);
    assert.equal(plainA.status, 200);
    assert.ok(!(await plainA.text()).includes(OVERLAY), 'admin exemption unchanged without flag');

    // Explicit true → overlay rendered even for exempt admin
    const on = await http2('/external/__external_watermark_test/External%20-%20WmOn.txt', COOKIE_A);
    assert.equal(on.status, 200);
    const htmlOn = await on.text();
    assert.ok(htmlOn.includes(OVERLAY), 'Watermark: true forces the overlay for admins');
    assert.ok(htmlOn.includes('Wm Admin'), 'forced overlay carries viewer identity');
  } finally {
    await new Promise(r => server2.close(r));
    restoreA();
    await clearCaches();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('watermark: Watermark:false hides pill+brand — protection and controls stay', async () => {
  const tmpRoot = path.join(QUERIES_DIR, '__external_wm_split_test');
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(path.join(tmpRoot, 'External - SplitOff.txt'), `${YT}\nWatermark: false\n`);
  await writeFile(path.join(tmpRoot, 'External - SplitPlain.txt'), `${YT}\n`);
  const base = { first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const USER = { id: 6201, google_user_id: 'google-wm-split', email: 'wmsplit@example.com', name: 'Split User', status: 'active', app_role: 'USER', ...base };
  const SID = 'wm-split-sid';
  const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const restore = mockPoolFor(SID, USER, '__external_wm_split_test');
  const { app } = await import('../src/server.js');
  await clearCaches();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const http = p => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: COOKIE } });
  try {
    // Control: URL-only file renders pill, shield, toolbars and branding.
    const plainHtml = await (await http('/external/__external_wm_split_test/External%20-%20SplitPlain.txt')).text();
    assert.ok(plainHtml.includes(OVERLAY), 'control: pill renders by default');
    assert.ok(plainHtml.includes('id="youtubeRightClickShield"'), 'control: right-click shield renders');
    assert.ok(plainHtml.includes('id="ytPlayPauseTop"'), 'control: top toolbar renders');
    assert.ok(plainHtml.includes('id="ytPlayPauseBottom"'), 'control: bottom toolbar renders');
    assert.ok(plainHtml.includes('<div class="wm-brand'), 'control: branding renders');
    assert.ok(plainHtml.includes('VideoProtection'), 'control: protection script renders');

    // Watermark:false → pill AND brand overlay gone, everything else intact.
    const offRes = await http('/external/__external_wm_split_test/External%20-%20SplitOff.txt');
    assert.equal(offRes.status, 200);
    const offHtml = await offRes.text();
    assert.ok(!offHtml.includes(OVERLAY), 'pill hidden by Watermark:false');
    assert.ok(!offHtml.includes('<div class="wm-brand'), 'brand overlay hidden by Watermark:false');
    assert.ok(offHtml.includes('id="youtubeRightClickShield"'), 'right-click shield preserved');
    assert.ok(offHtml.includes('oncontextmenu="return false"'), 'role-based right-click block preserved');
    assert.ok(offHtml.includes('id="ytPlayPauseTop"'), 'top toolbar (Play/Pause, volume, settings) preserved');
    assert.ok(offHtml.includes('id="ytPlayPauseBottom"'), 'bottom toolbar preserved');
    assert.ok(offHtml.includes('VideoProtection'), 'protection client script preserved');
    assert.ok(offHtml.includes('data-token="'), 'tokenized playback preserved');
  } finally {
    await new Promise(r => server.close(r));
    restore();
    await clearCaches();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('watermark: exact browser case — Ratetable Part1 hides pill+brand, keeps protection', async () => {
  // Real library file carrying `Watermark: false` (no fixture copy).
  const base = { first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const USER = { id: 6202, google_user_id: 'google-wm-real', email: 'wmreal@example.com', name: 'Real User', status: 'active', app_role: 'USER', ...base };
  const SID = 'wm-real-sid';
  const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const restore = mockPoolFor(SID, USER, 'Guidewire/Tutorials/Rating');
  const { app } = await import('../src/server.js');
  await clearCaches();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/external/Guidewire/Tutorials/Rating/External%20-%20Ratetable%20Creation%20-%20Part1.txt`,
      { headers: { Cookie: COOKIE } }
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes(OVERLAY), 'no viewer pill despite active session');
    assert.ok(!html.includes('<div class="wm-brand'), 'no large brand overlay despite active session');
    assert.ok(html.includes('id="youtubeRightClickShield"'), 'right-click shield intact');
    assert.ok(html.includes('oncontextmenu="return false"'), 'role-based right-click block intact');
    assert.ok(html.includes('id="ytPlayPauseTop"'), 'custom top controls intact');
    assert.ok(html.includes('id="ytPlayPauseBottom"'), 'custom bottom controls intact');
    assert.ok(html.includes('VideoProtection'), 'protection script intact');
    assert.ok(html.includes('data-token="'), 'tokenized playback intact');
  } finally {
    await new Promise(r => server.close(r));
    restore();
    await clearCaches();
  }
});
