import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 301, google_user_id: 'google-admin-caps', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 302, google_user_id: 'google-user-caps', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'caps-admin-sid';
const USER_SID = 'caps-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

// Test seam: when true, access-overview evidence queries throw, so the access
// section degrades to unavailable (preflight must report partial). The trigger
// string `expiring_soon_users` appears only in the evidence query, never in
// the /admin dashboard stats query.
let failAccess = false;

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
    if (/expiring_soon_users/.test(sql)) {
      if (failAccess) throw new Error('access store down');
      return { rows: [{ total_users: 5, pending_users: 0, revoked_users: 0, active_users: 4, admin_users: 1, expiring_soon_users: 0 }] };
    }
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 1, recent_replies_count: 1 }] };
    }
    if (/FROM interview_question_notes/.test(sql)) {
      return { rows: [{ total_notes: 1, unique_learners: 1, unique_questions: 1 }] };
    }
    if (/FROM paid_products p/.test(sql) && /LEFT JOIN roles/.test(sql)) {
      return { rows: [] };
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

test.beforeEach(() => {
  failAccess = false;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);
const ALLOWED_KEYS = new Set(['id', 'label', 'description', 'category', 'readOnly', 'available', 'url']);

test('capabilities API: unauthenticated and non-admin access are rejected', async () => {
  const anon = await http('/api/admin/assistant/capabilities');
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/assistant/capabilities', { headers: { Cookie: USER_COOKIE } });
  assert.equal(user.status, 403);
});

test('capabilities API: admin receives bounded safe metadata with ready preflight', async () => {
  const res = await http('/api/admin/assistant/capabilities', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.preflight.status, 'ready');
  assert.ok(typeof body.preflight.summary === 'string' && body.preflight.summary.length > 0);
  assert.deepEqual(body.preflight.unavailable, []);
  assert.equal(body.capabilities.length, 6);
  for (const cap of body.capabilities) {
    for (const key of Object.keys(cap)) {
      assert.ok(ALLOWED_KEYS.has(key), `unexpected key ${key}`);
    }
    assert.ok(typeof cap.id === 'string' && cap.id.length > 0);
    assert.ok(typeof cap.label === 'string' && cap.label.length > 0);
    assert.ok(typeof cap.description === 'string' && cap.description.length > 0);
    assert.ok(typeof cap.category === 'string' && cap.category.length > 0);
    assert.equal(cap.readOnly, true);
    assert.equal(cap.available, true);
    if (cap.url !== undefined) {
      assert.ok(cap.url.startsWith('/admin'), `unsafe url ${cap.url}`);
    }
    // No execution surface or internals leak.
    assert.equal('requires' in cap, false);
    assert.equal('flags' in cap, false);
    assert.equal('runCommands' in cap, false);
  }
  assert.ok(JSON.stringify(body).length < 10000, 'capabilities response must stay bounded');
});

test('capabilities API: unavailable evidence degrades to partial with per-item availability', async () => {
  failAccess = true;
  const res = await http('/api/admin/assistant/capabilities', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.preflight.status, 'partial');
  assert.deepEqual(body.preflight.unavailable, ['access']);
  const byId = new Map(body.capabilities.map(c => [c.id, c]));
  assert.equal(byId.get('access.overview').available, false);
  for (const [id, cap] of byId) {
    if (id !== 'access.overview') assert.equal(cap.available, true, id);
  }
});

test('capabilities UI: /admin renders the read-only card skeleton for admins', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="admin-capabilities"'), 'capabilities card present');
  assert.ok(html.includes('id="capabilities-status"'), 'status badge present');
  assert.ok(html.includes('id="capabilities-summary"'), 'summary region present');
  assert.ok(html.includes('id="capabilities-list"'), 'list region present');
  assert.ok(html.includes('not executable commands'), 'non-executable notice present');
  assert.ok(html.includes('/admin-capabilities.js'), 'capabilities script included');
  // Skeleton only: no server-rendered capability rows.
  assert.ok(!html.includes('integrity.diagnostics'), 'no capability data server-rendered');
});

test('capabilities UI: non-admin dashboard never exposes the card', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.ok([302, 403].includes(res.status), `expected redirect or forbidden, got ${res.status}`);
  const html = await res.text().catch(() => '');
  assert.ok(!html.includes('data-testid="admin-capabilities"'), 'card must not leak to non-admins');
});

test('capabilities UI: client script is served and renders safely', async () => {
  const res = await http('/admin-capabilities.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const js = await res.text();
  assert.ok(js.includes('/api/admin/assistant/capabilities'), 'capabilities endpoint wired');
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
  assert.ok(js.includes('textContent'), 'text-only rendering');
  assert.ok(js.includes('/^\\/admin([#?/]|$)/'), 'evidence URL allowlist present');
});
