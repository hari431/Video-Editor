import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import * as users from '../src/auth/users.js';
import { requireAuth, requireApiAuth, requireAdmin } from '../src/auth/middleware.js';

let originalQuery = null;
let calls = [];

function installPoolStub(handler) {
  originalQuery = pool.query;
  calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return handler(sql, params);
  };
}

function restorePool() {
  if (originalQuery) {
    pool.query = originalQuery;
    originalQuery = null;
  }
}

test.beforeEach(() => {
  calls = [];
});

test.afterEach(() => {
  restorePool();
  delete process.env.ADMIN_EMAILS;
});

function userRow(overrides = {}) {
  return {
    id: 1,
    google_user_id: 'google-1',
    email: 'user@example.com',
    name: 'User',
    status: 'active',
    first_login_at: new Date(),
    last_login_at: new Date(),
    access_expires_at: new Date(Date.now() + 30 * 86400000),
    ...overrides
  };
}

function reqFor(user) {
  return { isAuthenticated: () => !!user, user };
}

function resSpy() {
  const res = {
    statusCode: 200,
    redirected: null,
    body: null
  };
  res.redirect = to => {
    res.redirected = to;
    return res;
  };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    return res;
  };
  res.send = body => {
    res.body = body;
    return res;
  };
  return res;
}

function nextSpy() {
  const fn = (err = null) => {
    fn.called = true;
    fn.err = err;
  };
  fn.called = false;
  return fn;
}

const profile = { id: 'google-123', displayName: 'Jane Doe', emails: [{ value: 'jane@example.com' }] };

test('middleware gating: unauth/pending/active/expired/revoked routing', () => {
  let res = resSpy();
  requireAuth(reqFor(null), res, nextSpy());
  assert.equal(res.redirected, '/login');

  res = resSpy();
  requireAuth(reqFor(userRow({ status: 'pending', access_expires_at: null })), res, nextSpy());
  assert.equal(res.redirected, '/access-pending');

  res = resSpy();
  requireAuth(reqFor(userRow({ status: 'active', access_expires_at: null })), res, nextSpy());
  assert.equal(res.redirected, '/access-expired');

  res = resSpy();
  requireAuth(reqFor(userRow({ status: 'active', access_expires_at: new Date(Date.now() - 1000) })), res, nextSpy());
  assert.equal(res.redirected, '/access-expired');

  res = resSpy();
  const next = nextSpy();
  requireAuth(reqFor(userRow()), res, next);
  assert.equal(next.called, true);

  res = resSpy();
  requireApiAuth(reqFor(null), res, nextSpy());
  assert.equal(res.statusCode, 401);

  res = resSpy();
  requireApiAuth(reqFor(userRow({ status: 'pending' })), res, nextSpy());
  assert.equal(res.statusCode, 403);

  res = resSpy();
  requireApiAuth(reqFor(userRow({ status: 'revoked' })), res, nextSpy());
  assert.equal(res.statusCode, 403);

  res = resSpy();
  requireApiAuth(reqFor(userRow({ access_expires_at: new Date(Date.now() - 1000) })), res, nextSpy());
  assert.equal(res.statusCode, 403);

  res = resSpy();
  const nextApi = nextSpy();
  requireApiAuth(reqFor(userRow()), res, nextApi);
  assert.equal(nextApi.called, true);
});

test('TEST 1: new Google login creates a PENDING user with NULL expiry, no auto grant', async () => {
  installPoolStub(async (sql, params) => {
    assert.match(sql, /INSERT INTO users/);
    assert.match(sql, /'pending'/, 'new user must be created with status pending');
    assert.ok(!/GREATEST|INTERVAL|ACCESS_DURATION_DAYS/i.test(sql), 'must not grant any automatic duration');
    assert.equal(params.length, 3, 'only google_user_id, email, name params; expiry must be literal NULL');
    return {
      rowCount: 1,
      rows: [{ id: 7, google_user_id: profile.id, email: 'jane@example.com', name: 'Jane Doe', status: 'pending', access_expires_at: null }]
    };
  });
  const row = await users.createPendingUser(profile);
  assert.equal(row.status, 'pending');
  assert.equal(row.access_expires_at, null);
});

test('TEST 2 + 6 + 9: logging in again NEVER modifies status or access_expires_at', async () => {
  installPoolStub(async (sql, params) => {
    assert.match(sql, /UPDATE users/);
    assert.ok(!/status/i.test(sql), 're-login must not change status');
    assert.ok(!/access_expires_at/.test(sql), 're-login must not change expiry');
    assert.equal(params.length, 3, 'only id, email, name params');
    return { rowCount: 1, rows: [userRow({ status: 'pending', access_expires_at: null })] };
  });
  const row = await users.touchExistingUser(1, profile);
  assert.equal(row.status, 'pending');
});

test('TEST 4: active user logging in again keeps the same expiry', async () => {
  const expiry = new Date(Date.now() + 10 * 86400000);
  installPoolStub(async (sql) => {
    assert.ok(!/access_expires_at/.test(sql), 'expiry must never be touched by login');
    return { rowCount: 1, rows: [userRow({ access_expires_at: expiry })] };
  });
  const row = await users.touchExistingUser(1, profile);
  assert.equal(row.access_expires_at.getTime(), expiry.getTime());
});

test('TEST 3: admin Approve sets status active + chosen expiry and audits', async () => {
  const chosen = new Date(Date.now() + 30 * 86400000);
  const responses = [
    { rows: [{ id: 1, status: 'pending', access_expires_at: null }], rowCount: 1 },
    { rows: [userRow({ status: 'active', access_expires_at: chosen })], rowCount: 1 },
    { rowCount: 1 }
  ];
  installPoolStub(async () => responses.shift());
  const row = await users.approveUser(99, 1, chosen);
  assert.equal(row.status, 'active');
  assert.match(calls[1].sql, /SET status = 'active'/);
  assert.equal(calls[1].params[1].getTime(), chosen.getTime(), 'expiry is server-chosen, not client-supplied');
  assert.match(calls[2].sql, /INSERT INTO access_audit_log/);
  assert.equal(calls[2].params[2], 'approve');
  assert.equal(calls[2].params[3], 'pending');
  assert.equal(calls[2].params[4], 'active');
});

test('extend uses later-of(existing, NOW) + duration: never shortens', async () => {
  const responses = [
    { rows: [{ id: 1, status: 'active', access_expires_at: new Date(Date.now() + 30 * 86400000) }], rowCount: 1 },
    { rows: [userRow()], rowCount: 1 },
    { rowCount: 1 }
  ];
  installPoolStub(async () => responses.shift());
  await users.extendUserByDays(99, 1, 30);
  assert.match(calls[1].sql, /GREATEST\(COALESCE\(access_expires_at, NOW\(\)\), NOW\(\)\) \+ \(\$2::int \* INTERVAL '1 day'\)/);
  assert.equal(calls[1].params[1], 30);
});

test('TEST 5: admin Revoke sets status revoked + expiry=NOW and audits', async () => {
  const responses = [
    { rows: [{ id: 1, status: 'active', access_expires_at: new Date(Date.now() + 5 * 86400000) }], rowCount: 1 },
    { rows: [userRow({ status: 'revoked', access_expires_at: new Date() })], rowCount: 1 },
    { rowCount: 1 }
  ];
  installPoolStub(async () => responses.shift());
  await users.revokeUser(99, 1);
  assert.match(calls[1].sql, /status = 'revoked'/);
  assert.match(calls[1].sql, /access_expires_at = NOW\(\)/);
  assert.equal(calls[1].params.length, 1, 'revoke uses only the DB id; no browser-supplied email/status');
  assert.equal(calls[2].params[2], 'revoke');
});

test('TEST 7: revoked user with a stale browser session is denied immediately', () => {
  const res = resSpy();
  requireAuth(reqFor(userRow({ status: 'revoked' })), res, nextSpy());
  assert.equal(res.redirected, '/access-revoked');

  const resApi = resSpy();
  requireApiAuth(reqFor(userRow({ status: 'revoked' })), resApi, nextSpy());
  assert.equal(resApi.statusCode, 403);
});

test('TEST 8 + 9: expired active user is denied and login never resets expiry', () => {
  const expired = userRow({ access_expires_at: new Date(Date.now() - 1000) });
  const res = resSpy();
  requireAuth(reqFor(expired), res, nextSpy());
  assert.equal(res.redirected, '/access-expired');

  const resApi = resSpy();
  requireApiAuth(reqFor(expired), resApi, nextSpy());
  assert.equal(resApi.statusCode, 403);
});

test('TEST 10: admin Reactivate requires a new expiry (never active-without-expiry)', async () => {
  const chosen = new Date(Date.now() + 7 * 86400000);
  const responses = [
    { rows: [{ id: 1, status: 'revoked', access_expires_at: new Date() }], rowCount: 1 },
    { rows: [userRow({ status: 'active', access_expires_at: chosen })], rowCount: 1 },
    { rowCount: 1 }
  ];
  installPoolStub(async () => responses.shift());
  await users.reactivateUser(99, 1, chosen);
  assert.match(calls[1].sql, /SET status = 'active'/);
  assert.equal(calls[1].params[1].getTime(), chosen.getTime());
  assert.equal(calls[2].params[2], 'reactivate');
});

test('TEST 11: non-admin calling admin flow is denied with 403', () => {
  process.env.ADMIN_EMAILS = 'boss@example.com';
  const res = resSpy();
  requireAdmin(reqFor(userRow({ email: 'intruder@example.com' })), res, nextSpy());
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');

  const resOk = resSpy();
  const next = nextSpy();
  requireAdmin(reqFor(userRow({ email: 'Boss@example.com' })), resOk, next);
  assert.equal(next.called, true);
});

test('TEST 12: DB-level CHECK constraint rejects invalid status values', async () => {
  const sql = await readFile(new URL('../migrations/002_status_and_audit.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(sql, /CHECK \(status IN \('pending', 'active', 'revoked'\)\)/);
});

test('existing-user migration preserves expiry and backfills existing users to active', async () => {
  const sql = await readFile(new URL('../migrations/002_status_and_audit.sql', import.meta.url), 'utf8');
  assert.match(sql, /UPDATE users SET status = 'active' WHERE status = 'pending' AND access_expires_at IS NOT NULL/);
  assert.ok(!/SET\s+\S*access_expires_at/.test(sql), 'migration must not modify existing expiry dates');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS access_audit_log/);
});

test('passport no longer auto-grants: createPendingUser wired, ACCESS_DURATION_DAYS unused', async () => {
  const passport = await readFile(new URL('../src/auth/passport.js', import.meta.url), 'utf8');
  assert.match(passport, /createPendingUser/);
  assert.match(passport, /touchExistingUser/);
  assert.ok(!/ACCESS_DURATION_DAYS/.test(passport), 'passport must never use AUTO-grant env var');

  const usersSrc = await readFile(new URL('../src/auth/users.js', import.meta.url), 'utf8');
  assert.ok(!/ACCESS_DURATION_DAYS/.test(usersSrc), 'auto-grant env var must be unused in user logic');
});

test('all four admin mutation routes are protected by requireAuth + requireAdmin + requireSameOrigin', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const routes = server.match(/app\.post\('\/admin\/users\/[^']+'/g) || [];
  // Now includes make-admin / remove-admin owner-only routes + bulk routes (total 12)
  assert.ok(routes.length >= 8, `approve/extend/revoke/reactivate + make-admin/remove-admin endpoints all exist (found ${routes.length})`);
  assert.ok(routes.length >= 12, `bulk routes should exist (found ${routes.length})`);
  for (const route of routes) {
    const line = server.split('\n').find(l => l.includes(route));
    assert.ok(line.includes('requireAuth'), `missing requireAuth on ${route}`);
    if (route.includes('make-admin') || route.includes('remove-admin')) {
      assert.ok(line.includes('requireOwner'), `missing requireOwner on ${route}`);
    } else {
      assert.ok(line.includes('requireAdmin'), `missing requireAdmin on ${route}`);
    }
    assert.ok(line.includes('requireSameOrigin'), `missing requireSameOrigin on ${route}`);
  }
});