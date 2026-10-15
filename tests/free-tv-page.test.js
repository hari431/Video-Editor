import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearFreeTvCache } from '../src/library/free-tv.js';

const { app } = await import('../src/server.js');

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const USERS = {
  active: { id: 311, email: 'ftv-p-active@example.com', name: 'Active', status: 'active', app_role: 'USER', access_expires_at: FUTURE },
  pending: { id: 312, email: 'ftv-p-pending@example.com', name: 'Pending', status: 'pending', app_role: 'USER', access_expires_at: null },
  revoked: { id: 313, email: 'ftv-p-revoked@example.com', name: 'Revoked', status: 'revoked', app_role: 'USER', access_expires_at: PAST },
  expired: { id: 314, email: 'ftv-p-expired@example.com', name: 'Expired', status: 'expired', app_role: 'USER', access_expires_at: PAST },
  activeStale: { id: 315, email: 'ftv-p-stale@example.com', name: 'Stale', status: 'active', app_role: 'USER', access_expires_at: PAST },
  admin: { id: 316, email: 'ftv-p-admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN', access_expires_at: null }
};

const sessionToUser = {};
const cookies = {};
for (const [key, user] of Object.entries(USERS)) {
  const sid = `ftv-page-${key}-sid`;
  sessionToUser[sid] = user;
  cookies[key] = `connect.sid=s:${cookieSignature.sign(sid, process.env.SESSION_SECRET)}`;
}

let server;
let port;
let originalQuery;
let originalFetch;
let upstreamCalls;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/FROM ["']?users["']?/i.test(sql)) {
      const found = Object.values(USERS).find(u => Number(u.id) === Number(params[0]));
      if (found) return { rows: [{ ...found }] };
      return { rows: [] };
    }
    return { rows: [] };
  };
  originalFetch = globalThis.fetch;
  upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('raw.githubusercontent.com')) {
      upstreamCalls.push(String(url));
      return { ok: true, status: 200, text: async () => '#EXTM3U\n' };
    }
    return originalFetch(url, init);
  };
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  if (originalFetch) globalThis.fetch = originalFetch;
  delete process.env.FREE_TV_ENABLED;
  delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
  clearFreeTvCache();
});

test.beforeEach(() => {
  clearFreeTvCache();
  upstreamCalls.length = 0;
  delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const authed = (key, extra = {}) => ({ ...extra, headers: { Cookie: cookies[key] } });

test('free-tv page: kill switch OFF hides the page from everyone (404)', async () => {
  delete process.env.FREE_TV_ENABLED;
  const anon = await http('/entertainment');
  assert.equal(anon.status, 404);
  assert.ok(!(await anon.text()).includes('ftvPlayer'), 'disabled page must not render the player');
  const active = await http('/entertainment', authed('active'));
  assert.equal(active.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

test('free-tv page: logged-out users are sent to /login when enabled', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/entertainment', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/login/);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv page: pending/revoked/expired/active-with-past-expiry get generic 404', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    for (const key of ['pending', 'revoked', 'expired', 'activeStale']) {
      const res = await http('/entertainment', authed(key));
      assert.equal(res.status, 404, `${key} must not see the page`);
      const html = await res.text();
      assert.ok(!html.includes('ftvPlayer'), `${key}: no player may leak`);
      assert.ok(!html.includes('/api/entertainment/channels'), `${key}: no API hint may leak`);
    }
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv page: expired stays hidden even with EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED=true', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
  try {
    const res = await http('/entertainment', authed('expired'));
    assert.equal(res.status, 404);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv page: active user gets API-driven player with native+HLS fallback and no embedded streams', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/entertainment', authed('active'));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Entertainment'), 'page title must render');
    assert.ok(html.includes('id="ftvPlayer"'), 'must render the video element');
    assert.ok(html.includes('preload="none"'), 'player must not preload third-party bytes');
    assert.ok(html.includes('/api/entertainment/channels'), 'metadata must come through the Step 2 API');
    assert.ok(html.includes('hls.js'), 'must include the HLS fallback library');
    assert.ok(html.includes('canPlayType'), 'must handle native HLS before the library');
    assert.ok(html.includes('NotSupported') || html.includes('not supported'), 'must message unsupported browsers');
    // No server-side stream data: the page carries no playlist, no stream URLs, no proxy path.
    assert.ok(!html.includes('raw.githubusercontent.com'), 'browser must never depend on upstream directly');
    assert.ok(!html.includes('/entertainment/stream'), 'no proxied stream path may exist');
    assert.ok(!html.includes('"channels"'), 'no channel payload may be embedded');
    assert.ok(!html.includes('youtube.com/@') && !html.includes('twitch.tv'), 'no external embeds');
    assert.equal(upstreamCalls.length, 0, 'page render must not fetch upstream (API does that lazily)');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv page: permanent admin (NULL expiry) is allowed via existing convention', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/entertainment', authed('admin'));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('ftvPlayer'));
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});
