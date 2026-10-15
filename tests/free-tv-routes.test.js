import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearFreeTvCache } from '../src/library/free-tv.js';

const { app } = await import('../src/server.js');

const SAMPLE = `#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-name="NDTV India" tvg-logo="https://i.imgur.com/QjJYfh2.png" tvg-id="NDTVIndia.in" group-title="India",NDTV India
https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8
#EXTINF:-1 tvg-name="ABP News" tvg-logo="https://i.imgur.com/DKBUFQ1.png" tvg-id="ABPNews.in" group-title="India",ABP News
https://d2l4ar6y3mrs4k.cloudfront.net/live-streaming/abpnews-livetv/master.m3u8
#EXTINF:-1 tvg-name="Euronews Albania" tvg-logo="https://i.imgur.com/Skf6vdi.png" group-title="Albania",Euronews Albania
https://live1.mediadesk.al/static.m3u8
#EXTINF:-1 tvg-name="Legacy HTTP" tvg-logo="https://i.imgur.com/x.png" group-title="India",Legacy HTTP
http://198.244.188.94/panorama/livestream/playlist.m3u8
#EXTINF:-1 tvg-name="Tube Channel" tvg-logo="https://i.imgur.com/y.png" group-title="India",Tube Channel
https://www.youtube.com/@SomeChannel/live
`;

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const USERS = {
  active: { id: 301, email: 'ftv-active@example.com', name: 'Active', status: 'active', app_role: 'USER', access_expires_at: FUTURE },
  pending: { id: 302, email: 'ftv-pending@example.com', name: 'Pending', status: 'pending', app_role: 'USER', access_expires_at: null },
  revoked: { id: 303, email: 'ftv-revoked@example.com', name: 'Revoked', status: 'revoked', app_role: 'USER', access_expires_at: PAST },
  expired: { id: 304, email: 'ftv-expired@example.com', name: 'Expired', status: 'expired', app_role: 'USER', access_expires_at: PAST },
  activeStale: { id: 305, email: 'ftv-stale@example.com', name: 'Stale', status: 'active', app_role: 'USER', access_expires_at: PAST },
  admin: { id: 306, email: 'ftv-admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN', access_expires_at: null }
};

const sessionToUser = {};
const cookies = {};
for (const [key, user] of Object.entries(USERS)) {
  const sid = `ftv-${key}-sid`;
  sessionToUser[sid] = user;
  cookies[key] = `connect.sid=s:${cookieSignature.sign(sid, process.env.SESSION_SECRET)}`;
}

const okText = (text) => ({ ok: true, status: 200, text: async () => text });
const failStatus = (status) => ({ ok: false, status, text: async () => '' });

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
      return okText(SAMPLE);
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
const authed = (key) => ({ headers: { Cookie: cookies[key] } });

test('free-tv routes: kill switch OFF hides the endpoint from everyone (404, no oracle)', async () => {
  delete process.env.FREE_TV_ENABLED;
  const anon = await http('/api/entertainment/channels');
  assert.equal(anon.status, 404);
  assert.equal((await anon.json()).ok, false);
  const active = await http('/api/entertainment/channels', authed('active'));
  assert.equal(active.status, 404);
  assert.equal((await active.json()).ok, false);
  assert.equal(upstreamCalls.length, 0, 'disabled endpoint must not touch upstream');
});

test('free-tv routes: logged-out users get 401 when enabled', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/api/entertainment/channels');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: pending/revoked/expired/active-with-past-expiry all get 403', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    for (const key of ['pending', 'revoked', 'expired', 'activeStale']) {
      const res = await http('/api/entertainment/channels', authed(key));
      assert.equal(res.status, 403, `${key} must be denied`);
      assert.equal((await res.json()).ok, false);
    }
    assert.equal(upstreamCalls.length, 0, 'denied users must not trigger upstream fetch');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: expired stays denied even with EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED=true', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
  try {
    for (const key of ['expired', 'activeStale']) {
      const res = await http('/api/entertainment/channels', authed(key));
      assert.equal(res.status, 403, `${key} must stay denied under public-access flag`);
    }
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: active user gets metadata-only channels (https HLS, no externals)', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/api/entertainment/channels', authed('active'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 3);
    assert.equal(body.total, 3);
    assert.ok(body.groups.includes('India') && body.groups.includes('Albania'));
    assert.equal(body.source, 'https://github.com/Free-TV/IPTV');
    for (const ch of body.channels) {
      assert.match(ch.url, /^https:\/\//, 'https only');
      assert.match(ch.url, /\.m3u8/i, 'hls only');
      assert.ok(!ch.url.includes('youtube.com'), 'no youtube');
    }
    assert.deepEqual(Object.keys(body.channels[0]).sort(), ['geoBlocked', 'group', 'id', 'logo', 'name', 'sd', 'tvgId', 'url']);
    assert.equal(upstreamCalls.length, 1, 'one upstream metadata fetch serves the request');
    assert.ok(!JSON.stringify(body).includes('/entertainment/stream'), 'no proxied stream path may leak');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: permanent admin (NULL expiry) is allowed via existing convention', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/api/entertainment/channels', authed('admin'));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: country and search filters narrow the lightweight payload', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const india = await http('/api/entertainment/channels?country=India', authed('active'));
    assert.equal(india.status, 200);
    const indiaBody = await india.json();
    assert.equal(indiaBody.count, 2);
    assert.ok(indiaBody.channels.every(c => c.group === 'India'));

    const search = await http('/api/entertainment/channels?search=ndtv', authed('active'));
    const searchBody = await search.json();
    assert.equal(searchBody.count, 1);
    assert.match(searchBody.channels[0].name, /NDTV/);

    const missing = await http('/api/entertainment/channels?country=Nowhere', authed('active'));
    assert.equal((await missing.json()).count, 0);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('free-tv routes: upstream failure becomes 502 with empty cache', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('raw.githubusercontent.com')) return failStatus(503);
    return originalFetch(url, init);
  };
  try {
    const res = await http('/api/entertainment/channels', authed('active'));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).ok, false);
  } finally {
    globalThis.fetch = prev;
    delete process.env.FREE_TV_ENABLED;
  }
});
