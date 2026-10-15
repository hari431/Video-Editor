import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const USER = { id: 210, email: 'fxnav-user@example.com', name: 'FxNavUser', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };
const USER_SID = 'fxnav-user-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [USER_SID]: USER };

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
      if (params && params[0] && Number(params[0]) === USER.id) return { rows: [USER] };
      return { rows: [] };
    }
    if (/FROM ["']?rbac_user_roles["']?/i.test(sql)) return { rows: [] };
    if (/FROM ["']?folder_permissions["']?/i.test(sql)) {
      return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    }
    return { rows: [] };
  };
  // Exchange-rates API stub so /exchange-rates-adjacent renders never hit the network.
  originalFetch = globalThis.fetch;
  const stubbed = async (url, init) => {
    if (String(url).includes('/currencies/')) {
      return { ok: true, status: 200, json: async () => ({ date: '2026-10-05', usd: { eur: 0.9, inr: 83.2 } }) };
    }
    return originalFetch(url, init);
  };
  globalThis.fetch = stubbed;
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  if (originalFetch) globalThis.fetch = originalFetch;
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const NAV_LINK = 'href="/exchange-rates"';

test('exchange-rates nav: logged-out home shows Exchange Rates link', async () => {
  const res = await http('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(NAV_LINK), 'logged-out main nav must link to /exchange-rates');
  assert.ok(html.includes('Exchange Rates'), 'link must be labeled Exchange Rates');
  // Existing nav behavior unchanged.
  assert.ok(html.includes('href="/login"'), 'Sign in link must remain');
});

test('exchange-rates nav: logged-in home shows Exchange Rates link', async () => {
  const res = await http('/', { headers: { Cookie: USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(NAV_LINK), 'logged-in main nav must link to /exchange-rates');
  assert.ok(html.includes('Exchange Rates'), 'link must be labeled Exchange Rates');
});

test('exchange-rates nav: footer link is unchanged', async () => {
  const res = await http('/exchange-rates');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(NAV_LINK), 'page must still link to /exchange-rates');
  assert.ok(html.includes('class="footer-legal"'), 'footer must still render');
});
