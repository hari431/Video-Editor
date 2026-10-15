import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const TOPLEVEL_LINK = 'nav-link" href="/free-books"';

const ACTIVE = { id: 331, email: 'fb-nav-active@example.com', name: 'Active', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };
const ACTIVE_SID = 'fb-nav-active-sid';
const ACTIVE_COOKIE = `connect.sid=s:${cookieSignature.sign(ACTIVE_SID, process.env.SESSION_SECRET)}`;

let server;
let port;
let originalQuery;
let originalFetch;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === ACTIVE_SID) {
        return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: ACTIVE.id } }) }] };
      }
      return { rows: [] };
    }
    if (/FROM ["']?users["']?/i.test(sql)) {
      if (Number(params[0]) === ACTIVE.id) return { rows: [{ ...ACTIVE }] };
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
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);

test('free-books nav: no top-level nav item on the library home', async () => {
  const res = await http('/', { headers: { Cookie: ACTIVE_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes(TOPLEVEL_LINK), 'top-level Free Technical Books nav item must be gone');
  assert.ok(html.includes('href="/knowledge"'), 'Knowledge Base top-level link must remain');
});

test('free-books nav: no top-level nav item on the Knowledge Base page, entry card present', async () => {
  const res = await http('/knowledge');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes(TOPLEVEL_LINK), 'top-level Free Technical Books nav item must be gone from KB header');
  assert.ok(html.includes('href="/free-books"'), 'KB page must link to /free-books');
  assert.ok(html.includes('knowledge-cat-card'), 'KB entry must reuse the category-card pattern');
  assert.ok(html.includes('Free Technical Books'), 'KB entry must carry the approved label');
});

test('free-books nav: /free-books still works with content and navigation intact', async () => {
  const res = await http('/free-books');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Free Technical Books'), 'page content must be unchanged');
  assert.ok(html.includes('href="/knowledge"'), 'page must still link back to the Knowledge Base');
  assert.ok(!html.includes(TOPLEVEL_LINK), 'self-referencing top-level nav item must be gone');
});
