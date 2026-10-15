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
  active: { id: 321, email: 'ftv-n-active@example.com', name: 'Active', status: 'active', app_role: 'USER', access_expires_at: FUTURE },
  expired: { id: 322, email: 'ftv-n-expired@example.com', name: 'Expired', status: 'expired', app_role: 'USER', access_expires_at: PAST },
  admin: { id: 323, email: 'ftv-n-admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN', access_expires_at: null }
};

const sessionToUser = {};
const cookies = {};
for (const [key, user] of Object.entries(USERS)) {
  const sid = `ftv-nav-${key}-sid`;
  sessionToUser[sid] = user;
  cookies[key] = `connect.sid=s:${cookieSignature.sign(sid, process.env.SESSION_SECRET)}`;
}

let server;
let port;
let originalQuery;
let originalFetch;

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
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('raw.githubusercontent.com')) {
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
  clearFreeTvCache();
});

test.beforeEach(() => {
  clearFreeTvCache();
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const authed = (key, extra = {}) => ({ ...extra, headers: { Cookie: cookies[key] } });

test('free-tv nav: active user sees the Entertainment link only when enabled', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const on = await http('/', authed('active'));
    assert.equal(on.status, 200);
    const onHtml = await on.text();
    assert.ok(onHtml.includes('href="/entertainment"'), 'active user must see the link when enabled');
    assert.ok(onHtml.includes('🍿 Entertainment'), 'link must carry the approved label');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }

  const off = await http('/', authed('active'));
  assert.equal(off.status, 200);
  assert.ok(!(await off.text()).includes('href="/entertainment"'), 'no link when kill switch is OFF');
});

test('free-tv nav: expired user never sees the Entertainment link', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/', { ...authed('expired'), redirect: 'manual' });
    // requireAuth reroutes expired users away from the library; either way no link may render.
    if (res.status === 200) {
      assert.ok(!(await res.text()).includes('href="/entertainment"'), 'expired user must not see the link');
    } else {
      assert.ok([301, 302].includes(res.status), 'expired user must be redirected away from the library');
      assert.match(res.headers.get('location') || '', /access-expired/);
    }
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv nav: admin sees the Entertainment link when enabled', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/', authed('admin'));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('href="/entertainment"'), 'admin must see the link when enabled');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});
