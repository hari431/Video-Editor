import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 701, google_user_id: 'google-admin-aicenter', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 702, google_user_id: 'google-user-aicenter', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'aicenter-admin-sid';
const USER_SID = 'aicenter-user-sid';
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
    if (/expiring_soon_users/.test(sql)) {
      return { rows: [{ total_users: 5, pending_users: 0, revoked_users: 0, active_users: 4, admin_users: 1, expiring_soon_users: 0 }] };
    }
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 1, recent_replies_count: 1 }] };
    }
    if (/FROM interview_question_notes/.test(sql)) {
      return { rows: [{ total_notes: 1, unique_learners: 1, unique_questions: 1 }] };
    }
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

const MOVED_TESTIDS = [
  'data-testid="admin-assistant"',
  'data-testid="admin-capabilities"',
  'data-testid="admin-actions"',
  'data-testid="nanobot-digest"',
  'data-testid="ai-workflow-status"'
];
const MOVED_SCRIPTS = ['/admin-assistant.js', '/admin-capabilities.js', '/admin-actions.js'];

test('ai center: /admin/ai renders all 5 moved sections with their scripts for admins', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('AI Admin Center'), 'center heading present');
  for (const testid of MOVED_TESTIDS) {
    assert.ok(html.includes(testid), `moved section present: ${testid}`);
  }
  for (const script of MOVED_SCRIPTS) {
    assert.ok(html.includes(script), `moved script present: ${script}`);
  }
  assert.ok(html.includes('/api/admin/nanobot/digest'), 'digest loader moved with its card');
  assert.ok(html.includes('href="/admin"'), 'navigation back to Admin Home present');
});

test('ai center: /admin links to the center near the top and hosts no moved UI', async () => {
  const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="ai-center-link"'), 'center link section present');
  assert.ok(html.includes('href="/admin/ai"'), 'center link target present');
  assert.ok(html.includes('AI Admin Center'), 'center link labeled');
  assert.ok(
    html.indexOf('href="/admin/ai"') < html.indexOf('data-testid="needs-attention"'),
    'center link sits near the top, before the Needs Attention section'
  );
  for (const testid of MOVED_TESTIDS) {
    assert.ok(!html.includes(testid), `moved section absent from /admin: ${testid}`);
  }
  for (const script of MOVED_SCRIPTS) {
    assert.ok(!html.includes(`src="${script}"`), `moved script absent from /admin: ${script}`);
  }
});

test('ai center: non-admins and guests receive no center UI or data', async () => {
  const user = await http('/admin/ai', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.ok([302, 403].includes(user.status), `expected redirect or forbidden, got ${user.status}`);
  const userHtml = await user.text().catch(() => '');
  for (const testid of MOVED_TESTIDS) {
    assert.ok(!userHtml.includes(testid), `center must not leak to non-admins: ${testid}`);
  }
  const anon = await http('/admin/ai', { redirect: 'manual' });
  assert.equal(anon.status, 302);
});

test('ai center: existing assistant APIs keep working after the move', async () => {
  const brief = await http('/api/admin/assistant/brief', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(brief.status, 200);
  assert.equal((await brief.json()).ok, true);

  const caps = await http('/api/admin/assistant/capabilities', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(caps.status, 200);
  assert.equal((await caps.json()).ok, true);

  const exec = await http('/api/admin/assistant/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
    body: JSON.stringify({ actionId: 'health.snapshot' })
  });
  assert.equal(exec.status, 200);
  const execBody = await exec.json();
  assert.equal(execBody.ok, true);
  assert.equal(execBody.status, 'executed');
});
