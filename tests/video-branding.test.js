import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  BRANDING_STYLES,
  DEFAULT_BRANDING,
  DEFAULT_BRANDING_COLOR,
  normalizeBrandingColor,
  getVideoBranding,
  setVideoBranding,
  _resetVideoBrandingCache,
} from '../src/library/video-branding.js';
import { videoMimeType } from '../src/library/video.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));

// Isolate file persistence to a temp file for the whole file.
const TMP_BRANDING_FILE = join(mkdtempSync(join(tmpdir(), 'video-branding-')), 'video-branding.json');
process.env.VIDEO_BRANDING_FILE = TMP_BRANDING_FILE;

test.after(() => {
  delete process.env.VIDEO_BRANDING_FILE;
  _resetVideoBrandingCache();
  try { rmSync(path.dirname(TMP_BRANDING_FILE), { recursive: true, force: true }); } catch {}
});

// ---------- Store unit tests (no DB) ----------

test('branding defaults to Option 3 Centered Large at 8% opacity, dark blue', () => {
  _resetVideoBrandingCache();
  assert.deepEqual(getVideoBranding('Videos/a.mp4'), { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
  assert.deepEqual(getVideoBranding(''), { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
  assert.deepEqual(getVideoBranding(null), { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
  assert.deepEqual(DEFAULT_BRANDING, { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
  assert.equal(DEFAULT_BRANDING_COLOR, '#1E3A5F');
  assert.ok(BRANDING_STYLES.has(2) && BRANDING_STYLES.has(3));
});

test('normalizeBrandingColor accepts only #RGB/#RRGGBB hex, normalized', () => {
  assert.equal(normalizeBrandingColor('#1E3A5F'), '#1E3A5F');
  assert.equal(normalizeBrandingColor('#1e3a5f'), '#1E3A5F');
  assert.equal(normalizeBrandingColor('  #ffffff  '), '#FFFFFF');
  assert.equal(normalizeBrandingColor('#abc'), '#AABBCC');
  assert.equal(normalizeBrandingColor('#000'), '#000000');
  for (const bad of ['red', 'white', '#GGGGGG', '#12345', '#1234567', 'rgb(0,0,0)',
    'rgba(0,0,0,1)', 'url(x)', 'expression(alert(1))', '#1E3A5F;', '', '   ', null, 123, '#']) {
    assert.equal(normalizeBrandingColor(bad), null, `rejected: ${String(bad)}`);
  }
});

test('setVideoBranding validates style, opacity, color and path', () => {
  _resetVideoBrandingCache();
  assert.throws(() => setVideoBranding('Videos/a.mp4', 1, 8, '#1E3A5F'), /style/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 4, 8, '#1E3A5F'), /style/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 0, '#1E3A5F'), /opacity/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 101, '#1E3A5F'), /opacity/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 7.5, '#1E3A5F'), /opacity/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 8, 'red'), /color/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 8, '#GGGGGG'), /color/);
  assert.throws(() => setVideoBranding('Videos/a.mp4', 3, 8, 'expression(alert(1))'), /color/);
  assert.throws(() => setVideoBranding('../evil.mp4', 3, 8, '#1E3A5F'), /path/);
  assert.throws(() => setVideoBranding('', 3, 8, '#1E3A5F'), /path/);
  // Missing color keeps older callers working (default color applied).
  assert.deepEqual(
    setVideoBranding('Videos/a.mp4', 2, 25),
    { enabled: true, style: 2, opacity: 25, color: '#1E3A5F' }
  );
  _resetVideoBrandingCache();
});

test('setVideoBranding persists per-video entries; others keep defaults', async () => {
  _resetVideoBrandingCache();
  const { readFile } = await import('node:fs/promises');
  const saved = setVideoBranding('Videos/a.mp4', 2, 25, '#2563EB');
  assert.deepEqual(saved, { enabled: true, style: 2, opacity: 25, color: '#2563EB' });
  assert.deepEqual(getVideoBranding('Videos/a.mp4'), { enabled: true, style: 2, opacity: 25, color: '#2563EB' });
  assert.deepEqual(getVideoBranding('Videos/b.mp4'), { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
  const onDisk = JSON.parse(await readFile(TMP_BRANDING_FILE, 'utf8'));
  assert.deepEqual(onDisk['Videos/a.mp4'], { enabled: true, style: 2, opacity: 25, color: '#2563EB' });
  // Entries written before color existed keep style/opacity and gain the default color.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(TMP_BRANDING_FILE, JSON.stringify({ 'Videos/old.mp4': { style: 2, opacity: 40 } }), 'utf8');
  _resetVideoBrandingCache();
  assert.deepEqual(getVideoBranding('Videos/old.mp4'), { enabled: true, style: 2, opacity: 40, color: '#1E3A5F' });
  // Corrupt on-disk content degrades to defaults, never throws.
  await writeFile(TMP_BRANDING_FILE, 'not-json{{{', 'utf8');
  _resetVideoBrandingCache();
  assert.deepEqual(getVideoBranding('Videos/a.mp4'), { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' });
});

// ---------- View rendering tests ----------

function baseVideoLocals(overrides = {}) {
  return {
    user: { name: 'Viewer', email: 'viewer@x.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false,
    ...overrides
  };
}

test('video.ejs renders default brand overlay (Option 3, 8%, dark blue) for viewers', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: true, maskedEmail: 'h***@gmail.com', sessionShort: 'a1b2c3d4', viewerName: 'Viewer', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' },
    videoBranding: { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' },
    canConfigureBranding: false
  }));
  assert.match(html, /wm-brand wm-brand-opt3/, 'centered overlay rendered');
  assert.match(html, /opacity:0\.08/, '8% opacity applied');
  assert.match(html, /color:#1E3A5F/, 'default dark blue applied');
  const defaultOverlay = html.match(/<div class="wm-brand wm-brand-opt3"[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(defaultOverlay, /wm-tile-layer/, 'Option 3 stays a single centered mark');
  assert.equal((defaultOverlay.match(/Learn with me/g) || []).length, 1, 'single brand instance');
  assert.doesNotMatch(html, /data-testid="video-branding-config"/, 'no config UI for regular users');
  assert.doesNotMatch(html, /data-testid="video-branding-color"/, 'no color control for regular users');
  // Viewer-specific watermark is untouched by branding color.
  assert.match(html, /For Viewer · Downloading or Recording is prohibited/, 'viewer line intact');
  assert.doesNotMatch(html, /Sharing is prohibited/, 'old wording retired');
  assert.match(html, /<div class="video-watermark is-protected" aria-hidden="true">/, 'viewer pill has no inline styling');
});

test('video.ejs renders configured brand overlay (Option 2, custom opacity + color)', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: true, maskedEmail: 'h***@gmail.com', sessionShort: 'a1b2c3d4', viewerName: 'Viewer', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' },
    videoBranding: { style: 2, opacity: 25, color: '#FFFFFF' },
    canConfigureBranding: false
  }));
  assert.match(html, /wm-brand wm-brand-opt2/, 'diagonal overlay rendered');
  assert.match(html, /opacity:0\.25/, 'configured opacity applied');
  assert.match(html, /color:#FFFFFF/, 'configured color applied');
  const overlay = html.match(/<div class="wm-brand wm-brand-opt2"[\s\S]*?<\/div><\/div>/)[0];
  const tiles = overlay.match(/<span>Learn with me<\/span>/g) || [];
  assert.equal(tiles.length, 30, 'tiled overlay holds many small instances');
  assert.match(html, /\.wm-brand-opt2 \{[^}]*font-size:\s*clamp\(10px, 1\.5vw, 16px\)/, 'tiles significantly smaller than the old huge mark');
  assert.match(html, /transform:\s*rotate\(-32deg\)/, 'diagonal tilt at ~32 degrees');
  assert.doesNotMatch(html, /rotate\(-24deg\)/, 'old single-giant diagonal retired');
});

test('video.ejs shows branding config (incl. color) only to Admin/Owner', async () => {
  const adminHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: false, maskedEmail: '', sessionShort: '', viewerName: '', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' },
    videoBranding: { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' },
    canConfigureBranding: true
  }));
  assert.match(adminHtml, /data-testid="video-branding-config"/, 'admin sees config panel');
  assert.match(adminHtml, /Option 2: Diagonal \+ Logo/, 'style options offered');
  assert.match(adminHtml, /Option 3: Centered Large/, 'style options offered');
  assert.match(adminHtml, /data-testid="video-branding-color"/, 'color picker present');
  assert.match(adminHtml, /value="#1E3A5F"/, 'picker prefilled with current color');
  for (const preset of ['#FFFFFF', '#000000', '#1E3A5F', '#2563EB', '#6B7280']) {
    assert.match(adminHtml, new RegExp(`data-brand-preset="${preset}"`), `preset ${preset} present`);
  }
  assert.match(adminHtml, /data-testid="video-branding-preview"/, 'live preview present');
  assert.match(adminHtml, /fontSize = isDiagonal \? '13px' : '22px'/, 'preview shrinks for the tiled style');
  assert.doesNotMatch(adminHtml, /rotate\(-12deg\)/, 'old preview angle retired');
  assert.match(adminHtml, /\/api\/admin\/video-branding/, 'panel posts to the protected endpoint');
  assert.doesNotMatch(adminHtml, /<div class="video-watermark/, 'exempt admin still gets no watermark');
});

function baseExternalLocals(overrides = {}) {
  return {
    user: { name: 'Viewer', email: 'viewer@x.com', access_expires_at: new Date() },
    itemPath: 'Premium/Vid.txt',
    fileName: 'External - Vid.txt',
    friendlyName: 'Vid',
    externalUrl: null,
    youtubeId: null,
    externalVideoToken: 'tok-1',
    isYouTube: true,
    isBlogger: false,
    isDrive: false,
    drivePreviewUrl: null,
    pinnedRefs: [],
    isValidUrl: true,
    likeCount: 0,
    liked: false,
    discussions: [],
    relatedItems: [],
    hasNotes: false,
    userNote: null,
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Premium',
    getExternalFriendlyName: name => name,
    ...overrides
  };
}

test('external.ejs YouTube renders viewer lines + brand overlay, gating config', async () => {
  const viewerCtx = {
    enabled: true, maskedEmail: 'b***@example.com', sessionShort: 'e5f6g7h8',
    viewerName: 'Viewer', itemPath: 'Premium/Vid.txt', itemType: 'youtube'
  };
  const viewerHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx,
    videoBranding: { style: 2, opacity: 30, color: '#6B7280' },
    canConfigureBranding: false
  }));
  assert.match(viewerHtml, /For Viewer · Downloading or Recording is prohibited/, 'viewer name line shown');
  assert.doesNotMatch(viewerHtml, /Sharing is prohibited/, 'old wording retired');
  assert.match(viewerHtml, /b\*\*\*@example\.com · e5f6g7h8/, 'masked + code line shown');
  assert.match(viewerHtml, /wm-brand wm-brand-opt2/, 'brand overlay shown');
  assert.match(viewerHtml, /color:#6B7280/, 'configured brand color shown');
  const extOverlay = viewerHtml.match(/<div class="wm-brand wm-brand-opt2"[\s\S]*?<\/div><\/div>/)[0];
  assert.equal((extOverlay.match(/<span>Learn with me<\/span>/g) || []).length, 30, 'YouTube overlay tiled too');
  assert.match(viewerHtml, /#youtubeContainer \.wm-brand-opt2 \.wm-tile-layer/, 'tiled layer styled for the player');
  assert.match(viewerHtml, /"viewerName":"Viewer"/, 'client config carries the viewer name');
  assert.doesNotMatch(viewerHtml, /data-testid="video-branding-config"/, 'no config UI for regular users');
  assert.doesNotMatch(viewerHtml, /data-testid="video-branding-color"/, 'no color control for regular users');
  assert.doesNotMatch(viewerHtml, /viewer@x\.com/, 'full viewer email never rendered');

  const adminHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: { ...viewerCtx, enabled: false, maskedEmail: '', viewerName: '' },
    videoBranding: { style: 2, opacity: 30, color: '#6B7280' },
    canConfigureBranding: true
  }));
  assert.match(adminHtml, /data-testid="video-branding-config"/, 'admin sees config panel on YouTube externals');
  assert.match(adminHtml, /data-testid="video-branding-color"/, 'admin sees color picker on YouTube externals');
  assert.match(adminHtml, /data-testid="video-branding-preview"/, 'admin sees live preview on YouTube externals');
  assert.doesNotMatch(adminHtml, /video-watermark is-protected/, 'exempt admin gets no watermark overlay');
});

// ---------- Endpoint tests (mocked pool) ----------

const { app } = await import('../src/server.js');
const SECRET = process.env.SESSION_SECRET;
const ADMIN = { id: 301, google_user_id: 'google-301', email: 'brand-admin@example.com', name: 'BrandAdmin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 302, google_user_id: 'google-302', email: 'brand-user@example.com', name: 'BrandUser', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const USERS = { 301: ADMIN, 302: USER };
const cookieFor = id => `connect.sid=s:${cookieSignature.sign(`brand-${id}`, SECRET)}`;

let server, port, originalQuery;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const m = String(params[0]).match(/brand-(\d+)/);
      const uid = m ? Number(m[1]) : null;
      if (uid && USERS[uid]) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: uid } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) return { rows: [USERS[Number(params[0])] || USER] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/content_action_permissions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/item_likes/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, opts);
const postBranding = (body, id) => http('/api/admin/video-branding', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(id ? { Cookie: cookieFor(id) } : {}) },
  body: JSON.stringify(body)
});

test('branding endpoint rejects unauthenticated and non-admin callers', async () => {
  const anon = await postBranding({ itemPath: 'Videos/a.mp4', style: 2, opacity: 10 }, null);
  assert.equal(anon.status, 401);
  const user = await postBranding({ itemPath: 'Videos/a.mp4', style: 2, opacity: 10 }, 302);
  assert.equal(user.status, 403);
});

test('branding endpoint validates input, persists only valid config', async () => {
  _resetVideoBrandingCache();
  for (const body of [
    { itemPath: '', style: 2, opacity: 10, color: '#1E3A5F' },
    { itemPath: '../evil.mp4', style: 2, opacity: 10, color: '#1E3A5F' },
    { itemPath: 'Videos/a.mp4', style: 9, opacity: 10, color: '#1E3A5F' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 0, color: '#1E3A5F' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 101, color: '#1E3A5F' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 10, color: 'red' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 10, color: '#GGGGGG' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 10, color: 'expression(alert(1))' },
    { itemPath: 'Videos/a.mp4', style: 2, opacity: 10, color: 'rgb(0,0,0)' },
  ]) {
    const res = await postBranding(body, 301);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const ok = await postBranding({ itemPath: 'Videos/a.mp4', style: 2, opacity: 25, color: '#2563EB' }, 301);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, itemPath: 'Videos/a.mp4', branding: { enabled: true, style: 2, opacity: 25, color: '#2563EB' } });
  assert.deepEqual(getVideoBranding('Videos/a.mp4'), { enabled: true, style: 2, opacity: 25, color: '#2563EB' });
  // Omitting color keeps older callers working with the default color.
  const legacy = await postBranding({ itemPath: 'Videos/b.mp4', style: 3, opacity: 8 }, 301);
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { ok: true, itemPath: 'Videos/b.mp4', branding: { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' } });
});

test('branding enabled flag: opt-out persists, defaults stay enabled', () => {
  _resetVideoBrandingCache();
  assert.deepEqual(
    setVideoBranding('Videos/wm.mp4', 3, 8, '#1E3A5F', false),
    { enabled: false, style: 3, opacity: 8, color: '#1E3A5F' }
  );
  assert.deepEqual(
    getVideoBranding('Videos/wm.mp4'),
    { enabled: false, style: 3, opacity: 8, color: '#1E3A5F' }
  );
  // Omitted flag keeps older callers enabled.
  assert.deepEqual(
    setVideoBranding('Videos/wm2.mp4', 2, 25, '#2563EB'),
    { enabled: true, style: 2, opacity: 25, color: '#2563EB' }
  );
  for (const bad of ['yes', 'no', 0, 1]) {
    assert.throws(() => setVideoBranding('Videos/wm.mp4', 3, 8, '#1E3A5F', bad), /enabled/, `rejected: ${String(bad)}`);
  }
  _resetVideoBrandingCache();
});

test('video.ejs skips the brand overlay when disabled, viewer pill untouched', async () => {
  const base = {
    user: { name: 'Viewer', email: 'viewer@x.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false,
    canConfigureBranding: false
  };
  const vpx = { enabled: true, maskedEmail: 'h***@gmail.com', sessionShort: 'a1b2c3d4', viewerName: 'Viewer', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' };
  const off = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    ...base,
    videoProtection: vpx,
    videoBranding: { enabled: false, style: 3, opacity: 8, color: '#1E3A5F' }
  });
  assert.doesNotMatch(off, /wm-brand wm-brand-opt3/, 'brand overlay suppressed');
  assert.match(off, /<div class="video-watermark is-protected"/, 'viewer identity pill unaffected');
  const on = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    ...base,
    videoProtection: vpx,
    videoBranding: { enabled: true, style: 3, opacity: 8, color: '#1E3A5F' }
  });
  assert.match(on, /wm-brand wm-brand-opt3/, 'brand overlay renders when enabled');
  // Legacy objects without the flag keep rendering (backward compatible).
  const legacy = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    ...base,
    videoProtection: vpx,
    videoBranding: { style: 3, opacity: 8, color: '#1E3A5F' }
  });
  assert.match(legacy, /wm-brand wm-brand-opt3/, 'pre-flag entries still render');
});

test('branding endpoint persists enabled:false and rejects bad values', async () => {
  _resetVideoBrandingCache();
  const bad = await postBranding({ itemPath: 'Videos/wm.mp4', style: 3, opacity: 8, color: '#1E3A5F', enabled: 'yes' }, 301);
  assert.equal(bad.status, 400);
  const off = await postBranding({ itemPath: 'Videos/wm.mp4', style: 3, opacity: 8, color: '#1E3A5F', enabled: false }, 301);
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { ok: true, itemPath: 'Videos/wm.mp4', branding: { enabled: false, style: 3, opacity: 8, color: '#1E3A5F' } });
  assert.deepEqual(getVideoBranding('Videos/wm.mp4'), { enabled: false, style: 3, opacity: 8, color: '#1E3A5F' });
});
