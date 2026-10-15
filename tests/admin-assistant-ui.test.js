import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 201, google_user_id: 'google-admin-ui', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 202, google_user_id: 'google-user-ui', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'assistant-ui-admin-sid';
const USER_SID = 'assistant-ui-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let originalQuery = null;
let server;
let port;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const user = sessionToUser[params[0]];
      if (user) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: user.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    // /admin dashboard stats row (template reads stats.* directly).
    if (/active_today/.test(sql)) {
      return { rows: [{ total_users: 2, active_today: 1, active_month: 2, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);

test('UI: /admin renders the assistant card skeleton for admins', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="admin-assistant"'), 'assistant card present');
  assert.ok(html.includes('/admin-assistant.js'), 'assistant script included');
  assert.ok(html.includes('id="assistant-question"'), 'question input present');
  assert.ok(html.includes('maxlength="500"'), 'client length matches API bound');
  assert.ok(html.includes('id="assistant-answer"'), 'answer region present');
  // Card is a skeleton: loading headline shown, no server-rendered brief data.
  assert.ok(html.includes('Loading the deterministic admin brief…'), 'loading headline shown');
});

test('UI: non-admin cannot load the admin dashboard', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.ok([302, 403].includes(res.status), `expected redirect or forbidden, got ${res.status}`);
  const html = await res.text().catch(() => '');
  assert.ok(!html.includes('data-testid="admin-assistant"'), 'card must not leak to non-admins');
});

test('UI: unauthenticated /admin does not expose the card', async () => {
  const res = await http('/admin/ai', { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('UI: assistant client script is served and renders safely', async () => {
  const res = await http('/admin-assistant.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const js = await res.text();
  assert.ok(js.includes('/api/admin/assistant/brief'), 'brief endpoint wired');
  assert.ok(js.includes('/api/admin/assistant/query'), 'query endpoint wired');
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
  assert.ok(js.includes('textContent'), 'text-only rendering');
  // Link allowlist: only same-origin /admin URLs may become anchors.
  assert.ok(js.includes('/^\\/admin([#?/]|$)/'), 'evidence URL allowlist present');
});
