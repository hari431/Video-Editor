import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { resetAssistantRateLimits } from '../src/admin-assistant/router.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 10, google_user_id: 'google-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'assistant-admin-sid';
const USER_SID = 'assistant-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

const seenSql = [];
let originalQuery = null;
let server;
let port;

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
      const u = [ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    // Admin evidence: access overview counts (pending=1 drives attention).
    if (/COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [{ total_users: 5, pending_users: 1, revoked_users: 0, active_users: 3, admin_users: 1, expiring_soon_users: 0 }] };
    }
    // Admin evidence: discussion attention counts.
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 2, recent_replies_count: 3 }] };
    }
    // Admin evidence: learner-notes aggregates.
    if (/FROM interview_question_notes/.test(sql)) {
      return { rows: [{ total_notes: 2, unique_learners: 1, unique_questions: 2 }] };
    }
    // Integrity: one enabled product without active plans -> warning finding.
    if (/FROM paid_products p/.test(sql) && /LEFT JOIN roles/.test(sql)) {
      return { rows: [{ id: 7, code: 'ORPHAN', name: 'Orphan Product', role_id: 9, role_name: 'Role 9' }] };
    }
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.beforeEach(() => {
  resetAssistantRateLimits();
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);
const json = obj => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE }, body: JSON.stringify(obj) });

test('API: unauthenticated brief and query are rejected', async () => {
  const brief = await http('/api/admin/assistant/brief');
  assert.equal(brief.status, 401);
  const query = await http('/api/admin/assistant/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'brief' })
  });
  assert.equal(query.status, 401);
});

test('API: non-admin brief and query are rejected', async () => {
  const brief = await http('/api/admin/assistant/brief', { headers: { Cookie: USER_COOKIE } });
  assert.equal(brief.status, 403);
  const query = await http('/api/admin/assistant/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
    body: JSON.stringify({ question: 'brief' })
  });
  assert.equal(query.status, 403);
});

test('API: forged origin on POST is rejected', async () => {
  const res = await http('/api/admin/assistant/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE, Origin: 'https://evil.example' },
    body: JSON.stringify({ question: 'brief' })
  });
  assert.equal(res.status, 403);
});

test('API: admin brief succeeds with bounded, referenced output', async () => {
  const res = await http('/api/admin/assistant/brief', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.brief.overall, 'attention');
  assert.ok(typeof body.brief.headline === 'string' && body.brief.headline.length > 0);
  for (const name of ['access', 'attention', 'health', 'integrity', 'usage', 'notes']) {
    assert.ok(body.brief.sections[name], name);
  }
  // Integrity warning is present and references its check.
  const finding = body.brief.sections.integrity.findings.find(f => f.id === 'integrity:enabled_products_without_plans');
  assert.ok(finding, 'expected orphan-product finding');
  assert.ok(finding.evidenceRefs.length > 0);
  assert.equal(finding.evidenceRefs[0].checkId, 'enabled_products_without_plans');
  // Every finding carries admin evidence references.
  for (const section of Object.values(body.brief.sections)) {
    for (const f of section.findings) {
      assert.ok(f.evidenceRefs.length > 0, f.id);
      for (const r of f.evidenceRefs) {
        assert.ok(r.url.startsWith('/admin'), `${f.id} -> ${r.url}`);
      }
    }
  }
  assert.ok(JSON.stringify(body).length < 20000, 'brief response must stay bounded');
});

test('API: allowlisted query intent succeeds with evidence', async () => {
  const res = await http('/api/admin/assistant/query', json({ question: 'How many pending access requests are there?' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.intent, 'pending');
  assert.match(body.answer, /1 pending/);
  assert.ok(body.findings.length > 0);
  assert.ok(body.evidenceRefs.length > 0);
  assert.ok(body.evidenceRefs.every(r => r.url.startsWith('/admin')));
});

test('API: unsupported query is rejected without guessing', async () => {
  const res = await http('/api/admin/assistant/query', json({ question: 'What is the capital of France?' }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unsupported');
  assert.ok(Array.isArray(body.supported) && body.supported.length > 0);
});

test('API: malformed and oversized input is rejected', async () => {
  for (const payload of [{}, { question: '' }, { question: '   ' }, { question: 123 }, { question: 'x'.repeat(501) }]) {
    const res = await http('/api/admin/assistant/query', json(payload));
    assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 60));
    const body = await res.json();
    assert.equal(body.ok, false);
  }
});

test('API: provider fields are rejected as disabled', async () => {
  const res = await http('/api/admin/assistant/query', json({ question: 'brief', provider: 'gemini', api_key: 'secret' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /disabled/);
});

test('API: rate limit trips after the request budget', async () => {
  let lastStatus = 0;
  for (let i = 0; i < 31; i += 1) {
    const res = await http('/api/admin/assistant/query', json({ question: 'brief' }));
    lastStatus = res.status;
    await res.text();
  }
  assert.equal(lastStatus, 429);
});

test('API: assistant issues no application DB writes', async () => {
  seenSql.length = 0;
  const brief = await http('/api/admin/assistant/brief', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(brief.status, 200);
  await brief.text();
  resetAssistantRateLimits();
  const query = await http('/api/admin/assistant/query', json({ question: 'Summarize project health.' }));
  assert.equal(query.status, 200);
  await query.text();
  // The session store touches user_sessions expiry on its own (pre-existing
  // middleware behavior, unrelated to the assistant). Everything else the
  // assistant runs must be a read.
  const appSql = seenSql.filter(sql => !/user_sessions/i.test(sql));
  const writes = appSql.filter(sql => /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql));
  assert.deepEqual(writes, []);
  assert.ok(appSql.length > 0, 'expected read queries to have run');
  assert.ok(appSql.every(sql => /^\s*(SELECT|WITH)\b/i.test(sql)), 'assistant reads must be SELECT-only');
});
