import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  maskEmailForWatermark,
  isVideoProtectionExempt,
  getVideoProtectionSessionShort,
  getWatermarkSourceEmail,
  getViewerDisplayName,
  buildVideoProtectionContext,
  touchVideoProtectionSession
} from '../src/library/video-protection.js';
import { videoMimeType } from '../src/library/video.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));

function baseVideoLocals(overrides = {}) {
  return {
    user: { name: 'Tester', email: 'hema@gmail.com', access_expires_at: new Date() },
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

test('maskEmailForWatermark masks the local part, keeps domain', () => {
  assert.equal(maskEmailForWatermark('hema@gmail.com'), 'h***@gmail.com');
  assert.equal(maskEmailForWatermark('ab@example.com'), 'a***@example.com');
  assert.equal(maskEmailForWatermark('not-an-email'), '');
  assert.equal(maskEmailForWatermark('a@b'), '');
  assert.equal(maskEmailForWatermark(''), '');
  assert.equal(maskEmailForWatermark(null), '');
  assert.equal(maskEmailForWatermark('  Hema@Gmail.com  '.toLowerCase()), 'h***@gmail.com');
});

test('isVideoProtectionExempt reuses existing admin logic (role + ADMIN_EMAILS)', async () => {
  const prev = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    assert.equal(isVideoProtectionExempt({ app_role: 'ADMIN', email: 'someone@x.com' }), true);
    assert.equal(isVideoProtectionExempt({ app_role: 'OWNER', email: 'someone@x.com' }), true);
    // DB role wins over the env fallback (existing isAdminUser semantics):
    // a USER row stays protected even if listed in ADMIN_EMAILS.
    assert.equal(isVideoProtectionExempt({ app_role: 'USER', email: 'boss@example.com' }), false);
    // Env fallback applies to role-less (bootstrap) accounts.
    assert.equal(isVideoProtectionExempt({ email: 'boss@example.com' }), true);
    assert.equal(isVideoProtectionExempt({ app_role: 'USER', email: 'regular@x.com' }), false);
    assert.equal(isVideoProtectionExempt(null), false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

test('watermark identity comes from ADMIN_EMAILS, never the viewer email', () => {
  const prev = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    assert.equal(getWatermarkSourceEmail(), 'boss@example.com');
    // Viewer identity does not leak into the display value.
    const ctx = buildVideoProtectionContext({ user: { id: 9, email: 'regular@x.com', app_role: 'USER' }, sessionID: 'sess-9' }, 'Videos/a.mp4', 'youtube');
    assert.equal(ctx.enabled, true);
    assert.equal(ctx.maskedEmail, 'b***@example.com');
    assert.doesNotMatch(ctx.maskedEmail, /regular/, 'viewer local part never rendered');
    // First configured entry wins; shared canonical parsing (trim + lowercase).
    process.env.ADMIN_EMAILS = '  Boss@Example.com , second@x.com ';
    assert.equal(getWatermarkSourceEmail(), 'boss@example.com');
    assert.equal(buildVideoProtectionContext({ user: { id: 9, email: 'regular@x.com', app_role: 'USER' }, sessionID: 'sess-9' }, 'Videos/a.mp4', 'video').maskedEmail, 'b***@example.com');
    // Unset variable degrades to empty display value, never the viewer email.
    delete process.env.ADMIN_EMAILS;
    assert.equal(getWatermarkSourceEmail(), '');
    assert.equal(buildVideoProtectionContext({ user: { id: 9, email: 'regular@x.com', app_role: 'USER' }, sessionID: 'sess-9' }, 'Videos/a.mp4', 'video').maskedEmail, '');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

test('getVideoProtectionSessionShort derives an opaque 8-char id', () => {
  assert.equal(getVideoProtectionSessionShort({ sessionID: 'abc-123-XYZ' }), 'bc123XYZ');
  assert.equal(getVideoProtectionSessionShort({}), '00000000');
  assert.equal(getVideoProtectionSessionShort(null), '00000000');
});

test('buildVideoProtectionContext enables for users, disables for admins', () => {
  const prev = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    const userCtx = buildVideoProtectionContext({ user: { id: 7, email: 'hema@gmail.com', app_role: 'USER' }, sessionID: 'sess-1' }, 'Videos/a.mp4', 'video');
    assert.equal(userCtx.enabled, true);
    assert.equal(userCtx.maskedEmail, 'b***@example.com');
    assert.equal(userCtx.sessionShort.length, 8);
    assert.equal(userCtx.itemPath, 'Videos/a.mp4');

    const adminCtx = buildVideoProtectionContext({ user: { id: 8, email: 'boss@example.com', app_role: 'ADMIN' }, sessionID: 'sess-1' }, 'Videos/a.mp4', 'video');
    assert.equal(adminCtx.enabled, false);
    assert.equal(adminCtx.maskedEmail, '');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

test('video.ejs without protection context keeps legacy watermark (back-compat)', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals());
  assert.match(html, /<div class="video-watermark">/, 'legacy watermark div present');
  assert.match(html, /hema@gmail.com/, 'legacy path still shows full email');
});

test('video.ejs with protection context renders masked watermark + init config', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: true, maskedEmail: 'h***@gmail.com', sessionShort: 'a1b2c3d4', viewerName: 'Tester', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' }
  }));
  assert.match(html, /video-watermark is-protected/, 'protected watermark rendered');
  assert.match(html, /For Tester · Downloading or Recording is prohibited/, 'viewer name + sharing line shown');
  assert.doesNotMatch(html, /Sharing is prohibited/, 'old wording retired');
  assert.match(html, /h\*\*\*@gmail\.com · a1b2c3d4/, 'masked identity + session shown');
  assert.doesNotMatch(html, /Licensed to:/, 'legacy prefix retired');
  assert.doesNotMatch(html, /hema@gmail\.com/, 'full email never rendered in protected mode');
  assert.match(html, /src="\/video-protection\.js"/, 'client layer loaded');
  assert.match(html, /VideoProtection\.init/, 'protection initialised');
});

test('viewer watermark uses the logged-in name, falls back without leaking email', () => {
  assert.equal(getViewerDisplayName({ name: '  Hema  ', email: 'hema@gmail.com' }), 'Hema');
  assert.equal(getViewerDisplayName({ email: 'hema@gmail.com' }), '');
  assert.equal(getViewerDisplayName(null), '');
  const prev = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    const ctx = buildVideoProtectionContext({ user: { id: 9, name: 'Regular User', email: 'regular@x.com', app_role: 'USER' }, sessionID: 'sess-9' }, 'Videos/a.mp4', 'video');
    assert.equal(ctx.viewerName, 'Regular User');
    assert.doesNotMatch(ctx.viewerName, /regular@x\.com/, 'full viewer email never in context');
    const nameless = buildVideoProtectionContext({ user: { id: 9, email: 'regular@x.com', app_role: 'USER' }, sessionID: 'sess-9' }, 'Videos/a.mp4', 'video');
    assert.equal(nameless.viewerName, '');
    const adminCtx = buildVideoProtectionContext({ user: { id: 8, name: 'Boss', email: 'boss@example.com', app_role: 'ADMIN' }, sessionID: 'sess-1' }, 'Videos/a.mp4', 'video');
    assert.equal(adminCtx.enabled, false);
    assert.equal(adminCtx.viewerName, '', 'exempt admins expose no viewer identity');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

test('video.ejs falls back to member when the viewer has no name', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: true, maskedEmail: 'h***@gmail.com', sessionShort: 'a1b2c3d4', viewerName: '', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' }
  }));
  assert.match(html, /For member · Downloading or Recording is prohibited/);
  assert.doesNotMatch(html, /Sharing is prohibited/, 'old wording retired');
});

test('video.ejs for exempt admins renders no watermark at all', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), baseVideoLocals({
    videoProtection: { enabled: false, maskedEmail: '', sessionShort: 'a1b2c3d4', itemPath: 'Videos/TestVideo.mp4', itemType: 'video' }
  }));
  assert.doesNotMatch(html, /<div class="video-watermark/, 'no watermark markup for admins');
  assert.doesNotMatch(html, /src="\/video-protection\.js"/, 'no protection script for admins');
  assert.doesNotMatch(html, /VideoProtection\.init/, 'no protection init for admins');
});

test('client layer uses only honest page signals (never prompts, never claims recorder detection)', async () => {
  const src = await readFile(path.join(PUBLIC_DIR, 'video-protection.js'), 'utf8');
  assert.match(src, /VideoProtection/, 'exposes init entrypoint');
  assert.match(src, /visibilitychange/, 'listens to tab visibility');
  assert.match(src, /sendBeacon/, 'audit logging via beacon');
  assert.match(src, /pauseVideo/, 'attempts YouTube pause via player API');
  assert.doesNotMatch(src, /getDisplayMedia/, 'must never invoke screen-share prompt as "detection"');
  assert.match(src, /No webpage API can detect external recorder apps/, 'limitation is documented in code');
  assert.match(src, /Downloading or Recording is prohibited/, 'fallback watermark uses the viewer sharing text');
  assert.doesNotMatch(src, /Sharing is prohibited/, 'old wording retired from client layer');
  assert.doesNotMatch(src, /Licensed to:/, 'legacy fallback prefix retired');
});

test('migration 042 creates the session mapping and replaces the event table', async () => {
  const sql = await readFile(fileURLToPath(new URL('../migrations/042_video_protection_sessions.sql', import.meta.url)), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS video_protection_sessions/, 'session mapping defined');
  assert.match(sql, /session_code TEXT PRIMARY KEY/, 'UPSERT key on the watermark code');
  assert.match(sql, /user_id.*REFERENCES users\(id\)/, 'user relationship kept, FK-safe');
  assert.match(sql, /DROP TABLE IF EXISTS video_protection_events/, 'per-event storage replaced');
  assert.doesNotMatch(sql, /session_id/i, 'raw session id never stored');
  assert.doesNotMatch(sql, /email/i, 'no PII column in session mapping');
  const migrateSrc = await readFile(fileURLToPath(new URL('../scripts/migrate.js', import.meta.url)), 'utf8');
  assert.match(migrateSrc, /042_video_protection_sessions\.sql/, 'migration registered for baselining');
});

test('POST /api/video-protection-event rejects unauthenticated callers', async () => {
  const { app } = await import('../src/server.js');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/video-protection-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemPath: 'Videos/a.mp4', itemType: 'video', eventType: 'VIDEO_HIDDEN' })
    });
    assert.ok([401, 302].includes(res.status), `expected auth gate, got ${res.status}`);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/video-protection-event validates but persists no per-event rows', async () => {
  const SID = 'video-protection-event-sid';
  const USER = { id: 7001, google_user_id: 'google-vp-1', email: 'vp@example.com', name: 'VP User', status: 'active', app_role: 'USER', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const protectionWrites = [];
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/video_protection_(events|sessions)/.test(sql)) {
      protectionWrites.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { app } = await import('../src/server.js');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const http = (p, opts) => fetch(`http://127.0.0.1:${server.address().port}${p}`, opts);
  try {
    const bad = await http('/api/video-protection-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
      body: JSON.stringify({ itemPath: 'Videos/a.mp4', itemType: 'video', eventType: 'NOPE' })
    });
    assert.equal(bad.status, 400);

    for (const evt of ['VIDEO_HIDDEN', 'WINDOW_BLURRED', 'FULLSCREEN_CHANGED']) {
      const good = await http('/api/video-protection-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
        body: JSON.stringify({ itemPath: 'Videos/a.mp4', itemType: 'video', eventType: evt, details: { x: 1 } })
      });
      assert.equal(good.status, 200);
      assert.deepEqual(await good.json(), { ok: true, logged: false });
    }
    assert.equal(protectionWrites.length, 0, 'browser signals create no database rows');
  } finally {
    await new Promise(r => server.close(r));
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('touchVideoProtectionSession upserts one row per session code', async () => {
  const origQuery = pool.query;
  const seen = [];
  pool.query = async (sql, params = []) => { seen.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  try {
    const noUser = await touchVideoProtectionSession({});
    assert.equal(noUser.ok, false);
    assert.equal(seen.length, 0, 'no write without an authenticated user');

    // First access creates the mapping.
    const first = await touchVideoProtectionSession({ user: { id: 7 }, sessionID: 'sess-aaa-111' });
    assert.deepEqual(first, { ok: true, touched: true });
    assert.equal(seen.length, 1);
    assert.match(seen[0].sql, /INSERT INTO video_protection_sessions/);
    assert.match(seen[0].sql, /ON CONFLICT \(session_code\) DO UPDATE SET last_seen_at/);
    assert.doesNotMatch(seen[0].sql, /session_id/, 'raw session id never persisted');
    const firstCode = seen[0].params[0];
    assert.equal(firstCode.length, 8);
    assert.equal(seen[0].params[1], 7);

    // Repeated access from the same session reuses the code: the DB converges
    // to a single row via the PRIMARY KEY conflict path.
    const second = await touchVideoProtectionSession({ user: { id: 7 }, sessionID: 'sess-aaa-111' });
    assert.deepEqual(second, { ok: true, touched: true });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].params[0], firstCode, 'same session reuses the same row');
    assert.match(seen[1].sql, /ON CONFLICT \(session_code\) DO UPDATE/);

    // A new session maps to a different code, i.e. exactly one new row.
    const other = await touchVideoProtectionSession({ user: { id: 7 }, sessionID: 'sess-bbb-222' });
    assert.deepEqual(other, { ok: true, touched: true });
    assert.notEqual(seen[2].params[0], firstCode, 'new session creates its own row');

    // Missing table degrades without breaking the caller.
    pool.query = async () => { const err = new Error('relation "video_protection_sessions" does not exist'); err.code = '42P01'; throw err; };
    assert.deepEqual(await touchVideoProtectionSession({ user: { id: 7 }, sessionID: 'sess-aaa-111' }), { ok: true, touched: false });
  } finally {
    pool.query = origQuery;
  }
});
