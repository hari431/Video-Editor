import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  videoProtectionSessionCodeSql,
  searchVideoProtectionSession
} from '../src/library/video-protection.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const FULL_SID = 'xxxxxxxxxxxxxxxxxxxxxxxxHFBZ7R7G'; // 32 chars, derives to HFBZ7R7G
assert.equal(FULL_SID.length, 32);

const ADMIN_ROW = {
  id: 8001,
  google_user_id: 'google-vp-admin',
  email: 'vp-admin@example.com',
  name: 'VP Admin',
  status: 'active',
  app_role: 'ADMIN',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400000)
};
const USER_ROW = {
  id: 8002,
  google_user_id: 'google-vp-user',
  email: 'vp-user@example.com',
  name: 'VP User',
  status: 'active',
  app_role: 'USER',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400000)
};

test('SQL derivation reproduces the JS session-short (CASE, never LPAD-truncate)', () => {
  const sql = videoProtectionSessionCodeSql('e.session_id');
  assert.match(sql, /e\.session_id/, 'targets the given column');
  assert.match(sql, /CASE WHEN LENGTH/, 'pads short values instead of truncating');
  assert.match(sql, /RIGHT\(/, 'takes the trailing 8 chars like slice(-8)');
  assert.doesNotMatch(sql, /RIGHT\s*\(\s*LPAD/i, 'never the broken RIGHT(LPAD()) combination');
  assert.throws(() => videoProtectionSessionCodeSql('e.session_id; DROP TABLE users; --'), /Invalid column/);
  assert.throws(() => videoProtectionSessionCodeSql(''), /Invalid column/);
});

test('search helper rejects bad codes without touching the database', async () => {
  const origQuery = pool.query;
  let called = 0;
  pool.query = async () => { called += 1; return { rows: [] }; };
  try {
    for (const bad of ['', 'abc', 'HFBZ7R7', 'HFBZ7R7GXX']) {
      const res = await searchVideoProtectionSession(bad);
      assert.equal(res.ok, false);
      assert.match(res.error, /8-character/);
    }
    assert.equal(called, 0, 'no query issued for invalid codes');
    // Sanitization strips punctuation first: 'HFBZ7R7G!' is a valid lookup.
    const cleaned = await searchVideoProtectionSession('HFBZ7R7G!');
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.code, 'HFBZ7R7G');
  } finally {
    pool.query = origQuery;
  }
});

test('search helper returns the session mapping and degrades on missing table', async () => {
  const origQuery = pool.query;
  const seen = [];
  pool.query = async (sql, params = []) => {
    seen.push(sql);
    if (/video_protection_sessions/.test(sql)) {
      return { rows: [{ session_code: 'HFBZ7R7G', user_id: 59, user_email: 'viewer@example.com', user_name: 'Viewer', user_role: 'USER', user_status: 'active', first_seen: new Date(), last_seen: new Date() }] };
    }
    return { rows: [] };
  };
  try {
    const res = await searchVideoProtectionSession('HFBZ7R7G');
    assert.equal(res.ok, true);
    assert.equal(res.code, 'HFBZ7R7G');
    assert.equal(res.session.user_email, 'viewer@example.com');
    assert.equal(res.session.session_code, 'HFBZ7R7G');
    assert.ok(res.session.first_seen && res.session.last_seen, 'first/last activity present');
    for (const s of seen) {
      assert.doesNotMatch(s, /session_id/, 'raw session id never referenced');
    }
    pool.query = async () => ({ rows: [] });
    const missing = await searchVideoProtectionSession('AAAAAAAA');
    assert.equal(missing.ok, true);
    assert.equal(missing.session, null);
    pool.query = async () => { const e = new Error('no such table'); e.code = '42P01'; throw e; };
    const degraded = await searchVideoProtectionSession('HFBZ7R7G');
    assert.equal(degraded.ok, false);
    assert.match(degraded.error, /migration 042/);
  } finally {
    pool.query = origQuery;
  }
});

function mockPoolFor(userRow, sid, onProtectionQuery) {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === sid) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: userRow.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ ...userRow }], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/video_protection_sessions/.test(sql)) return onProtectionQuery(sql, params);
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return () => { pool.query = origQuery; pool.connect = origConnect; };
}

async function listen(app) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('admin page: form prompt, search results, and no full session_id leakage', async () => {
  const SID = 'vp-admin-page-sid';
  const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const restore = mockPoolFor(ADMIN_ROW, SID, (sql) => {
    // Fixture deliberately carries extra columns a leaky query might return;
    // the template must render only the session mapping fields.
    return { rows: [{ session_code: 'HFBZ7R7G', user_id: 59, user_email: 'viewer@example.com', user_name: 'Viewer', user_role: 'USER', user_status: 'active', first_seen: new Date('2026-09-26T05:50:48Z'), last_seen: new Date('2026-09-26T06:02:37Z') }] };
  });
  const { app } = await import('../src/server.js');
  const { server, base } = await listen(app);
  try {
    const plain = await fetch(`${base}/admin/video-protection`, { headers: { Cookie: COOKIE } });
    assert.equal(plain.status, 200);
    const plainHtml = await plain.text();
    assert.match(plainHtml, /protection-search-form/, 'search form rendered');
    assert.match(plainHtml, /protection-prompt/, 'empty-state prompt rendered');

    const res = await fetch(`${base}/admin/video-protection?session=HFBZ7R7G`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /HFBZ7R7G/, 'session code shown');
    assert.match(html, /viewer@example\.com/, 'associated user shown');
    assert.match(html, /USER/, 'user role shown');
    assert.match(html, /First seen/, 'first activity shown');
    assert.match(html, /Last seen/, 'last activity shown');
    assert.doesNotMatch(html, /protection-events-table/, 'no event-trail table anymore');
    assert.doesNotMatch(html, new RegExp(FULL_SID), 'full session_id never rendered');

    const bad = await fetch(`${base}/admin/video-protection?session=xyz`, { headers: { Cookie: COOKIE } });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /8-character/, 'invalid code explained, page intact');
  } finally {
    await new Promise(r => server.close(r));
    restore();
  }
});

test('admin page: ADMIN_EMAILS fallback admins are admitted, users get 403, guests redirect', async () => {
  const prev = process.env.ADMIN_EMAILS;
  const { app } = await import('../src/server.js');
  const { server, base } = await listen(app);
  try {
    process.env.ADMIN_EMAILS = 'fallback-admin@example.com';
    const FALLBACK = { ...USER_ROW, id: 8003, email: 'fallback-admin@example.com', app_role: null };
    const restoreFallback = mockPoolFor(FALLBACK, 'vp-fallback-sid', () => ({ rows: [] }));
    const fCookie = `connect.sid=s:${cookieSignature.sign('vp-fallback-sid', process.env.SESSION_SECRET)}`;
    const fRes = await fetch(`${base}/admin/video-protection`, { headers: { Cookie: fCookie } });
    assert.equal(fRes.status, 200, 'ADMIN_EMAILS fallback account admitted via existing logic');
    restoreFallback();

    const restoreUser = mockPoolFor(USER_ROW, 'vp-user-sid', () => ({ rows: [] }));
    const uCookie = `connect.sid=s:${cookieSignature.sign('vp-user-sid', process.env.SESSION_SECRET)}`;
    const uRes = await fetch(`${base}/admin/video-protection?session=HFBZ7R7G`, { headers: { Cookie: uCookie } });
    assert.equal(uRes.status, 403, 'non-admin users are forbidden');
    restoreUser();

    const gRes = await fetch(`${base}/admin/video-protection`, { redirect: 'manual' });
    assert.equal(gRes.status, 302, 'guests redirect to login');
    assert.match(gRes.headers.get('location') || '', /\/login/);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
    await new Promise(r => server.close(r));
  }
});

test('admin nav exposes the isolated Video Protection link', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/video-protection' });
  assert.match(html, /href="\/admin\/video-protection"/, 'nav links to the new page');
  assert.match(html, /Video Protection/, 'nav labels the new page');
});
