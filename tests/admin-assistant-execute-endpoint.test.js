import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetAssistantRateLimits } from '../src/admin-assistant/router.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 401, google_user_id: 'google-admin-exec', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 402, google_user_id: 'google-user-exec', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'exec-admin-sid';
const USER_SID = 'exec-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

// Test seam: when true, access-overview evidence queries throw, forcing the
// access section (and the actions requiring it) into unavailable.
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
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.beforeEach(() => {
  failAccess = false;
  resetAssistantRateLimits();
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);
const post = obj => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
  body: JSON.stringify(obj)
});

const DECLARED_IDS = [
  'access.review-queue',
  'attention.triage',
  'health.snapshot',
  'integrity.reconcile',
  'brief.compose'
];

test('execute API: unauthenticated and non-admin access are rejected', async () => {
  const anon = await http('/api/admin/assistant/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: 'health.snapshot' })
  });
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/assistant/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
    body: JSON.stringify({ actionId: 'health.snapshot' })
  });
  assert.equal(user.status, 403);
});

test('execute API: forged origin on POST is rejected', async () => {
  const res = await http('/api/admin/assistant/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE, Origin: 'https://evil.example' },
    body: JSON.stringify({ actionId: 'health.snapshot' })
  });
  assert.equal(res.status, 403);
});

test('execute API: all 5 declared plans execute bounded read-only results', async () => {
  for (const actionId of DECLARED_IDS) {
    const res = await http('/api/admin/assistant/execute', post({ actionId }));
    assert.equal(res.status, 200, actionId);
    const body = await res.json();
    assert.equal(body.ok, true, actionId);
    assert.equal(body.status, 'executed', actionId);
    assert.equal(body.actionId, actionId, actionId);
    assert.ok(typeof body.summary === 'string' && body.summary.length > 0, actionId);
    assert.ok(Array.isArray(body.findings), actionId);
    assert.ok(Array.isArray(body.evidenceRefs), actionId);
    assert.ok(body.evidenceRefs.every(r => !r.url || r.url.startsWith('/admin')), actionId);
    assert.deepEqual(body.checks, [
      { check: 'authorization', passed: true },
      { check: 'capability', passed: true },
      { check: 'evidence', passed: true }
    ], actionId);
    assert.ok(JSON.stringify(body).length < 20000, `${actionId} unbounded`);
  }
});

test('execute API: unavailable evidence blocks without leaking internals', async () => {
  failAccess = true;
  const res = await http('/api/admin/assistant/execute', post({ actionId: 'access.review-queue' }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'blocked');
  assert.equal(body.reason, 'evidence-unavailable');
  assert.doesNotMatch(JSON.stringify(body), /access store down|at Object|at file|stack/i);
});

test('execute API: unknown and capability ids are unresolvable', async () => {
  for (const actionId of ['no.such-plan', 'access.overview', '../actions', 'ACCESS.REVIEW-QUEUE']) {
    const res = await http('/api/admin/assistant/execute', post({ actionId }));
    assert.equal(res.status, 422, actionId);
    const body = await res.json();
    assert.equal(body.ok, false, actionId);
    assert.equal(body.status, 'unavailable', actionId);
    assert.equal(body.reason, 'unknown-action', actionId);
  }
});

test('execute API: malformed and smuggled fields are rejected', async () => {
  const bad = [
    {},
    { actionId: '' },
    { actionId: '   ' },
    { actionId: 123 },
    { actionId: 'x'.repeat(65) },
    { actionId: 'health.snapshot', command: 'nmap -sV x' },
    { actionId: 'health.snapshot', shell: 'bash' },
    { actionId: 'health.snapshot', provider: 'gemini', api_key: 'secret' },
    { actionId: 'health.snapshot', plan: { status: 'planned' } },
    { wrongKey: 'health.snapshot' }
  ];
  for (const payload of bad) {
    const res = await http('/api/admin/assistant/execute', post(payload));
    assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 60));
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.doesNotMatch(JSON.stringify(body), /secret|stack|at Object/i);
  }
  // Non-object JSON bodies are rejected before reaching the executor.
  for (const raw of ['"health.snapshot"', '[1]', '42']) {
    const res = await http('/api/admin/assistant/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
      body: raw
    });
    assert.equal(res.status, 400, raw);
  }
});

test('execute API: rate limit trips after the request budget', async () => {
  let lastStatus = 0;
  for (let i = 0; i < 31; i += 1) {
    const res = await http('/api/admin/assistant/execute', post({ actionId: 'health.snapshot' }));
    lastStatus = res.status;
    await res.text();
  }
  assert.equal(lastStatus, 429);
});
