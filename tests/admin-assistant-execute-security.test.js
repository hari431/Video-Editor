import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetAssistantRateLimits } from '../src/admin-assistant/router.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 501, google_user_id: 'google-admin-hard', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'hard-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let failAccess = false;
let originalQuery = null;
let server;
let port;
const seenSql = [];

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    seenSql.push(String(sql));
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const user = sessionToUser[params[0]];
      if (user) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: user.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      return { rows: [{ ...ADMIN }] };
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
const post = (raw, cookie = ADMIN_COOKIE) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: raw
});

test('hardening: prototype-pollution payloads are rejected and pollute nothing', async () => {
  // Raw JSON strings: object literals cannot express a `__proto__` own key
  // (it becomes the prototype and is dropped by stringify), so the real
  // attack shape must be sent verbatim. Node's JSON.parse keeps `__proto__`
  // as an inert own property without touching Object.prototype; the
  // single-key body rule then rejects every variant below.
  for (const raw of [
    '{"actionId":"health.snapshot","__proto__":{"polluted":"yes"}}',
    '{"__proto__":{"polluted":"yes"}}',
    '{"actionId":"health.snapshot","constructor":{"prototype":{"polluted":"yes"}}}'
  ]) {
    const res = await http('/api/admin/assistant/execute', post(raw));
    assert.equal(res.status, 400, raw.slice(0, 60));
    await res.text();
  }
  assert.equal({}.polluted, undefined, 'Object prototype was polluted');
  assert.equal({}.constructor?.polluted, undefined, 'constructor path was polluted');
});

test('hardening: magic property names never resolve to actions', async () => {
  for (const actionId of ['constructor', 'prototype', '__proto__', 'hasOwnProperty']) {
    const res = await http('/api/admin/assistant/execute', post(JSON.stringify({ actionId })));
    assert.equal(res.status, 422, actionId);
    const body = await res.json();
    assert.equal(body.reason, 'unknown-action', actionId);
  }
});

test('hardening: oversized bodies are rejected by the global JSON limit', async () => {
  const big = JSON.stringify({ actionId: 'health.snapshot', pad: 'x'.repeat(120 * 1024) });
  assert.ok(big.length > 100 * 1024, 'payload must exceed the 100kb limit');
  const res = await http('/api/admin/assistant/execute', post(big));
  assert.equal(res.status, 413);
  await res.text();
});

test('hardening: execute issues no application DB writes across all 5 actions', async () => {
  seenSql.length = 0;
  for (const actionId of ['access.review-queue', 'attention.triage', 'health.snapshot', 'integrity.reconcile', 'brief.compose']) {
    const res = await http('/api/admin/assistant/execute', post(JSON.stringify({ actionId })));
    assert.equal(res.status, 200, actionId);
    await res.text();
  }
  // The session store touches user_sessions on its own (pre-existing
  // middleware behavior, unrelated to the assistant). Everything else the
  // execute path runs must be a read.
  const appSql = seenSql.filter(sql => !/user_sessions/i.test(sql));
  const writes = appSql.filter(sql => /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i.test(sql));
  assert.deepEqual(writes, []);
  assert.ok(appSql.length > 0, 'expected read queries to have run');
  assert.ok(appSql.every(sql => /^\s*(SELECT|WITH)\b/i.test(sql)), 'execute reads must be SELECT-only');
});

test('hardening: repeated execution is deterministic (no per-call state)', async () => {
  const first = await (await http('/api/admin/assistant/execute', post(JSON.stringify({ actionId: 'integrity.reconcile' })))).text();
  const second = await (await http('/api/admin/assistant/execute', post(JSON.stringify({ actionId: 'integrity.reconcile' })))).text();
  assert.equal(first, second);
});

test('hardening: blocked responses prove server-side gates ran (no client trust)', async () => {
  failAccess = true;
  const res = await http('/api/admin/assistant/execute', post(JSON.stringify({ actionId: 'brief.compose' })));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'blocked');
  assert.equal(body.reason, 'evidence-unavailable');
  assert.deepEqual(body.checks, [
    { check: 'authorization', passed: true },
    { check: 'capability', passed: true },
    { check: 'evidence', passed: false }
  ]);
  assert.doesNotMatch(JSON.stringify(body), /access store down|at Object|stack/i);
});
