import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import * as users from '../src/auth/users.js';
import { isAdminEmail, isAdminUser } from '../src/auth/admin.js';
import { requireAuth, requireApiAuth } from '../src/auth/middleware.js';

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

const ADMIN_EMAIL = 'boss@example.com';
const adminProfile = { id: 'google-admin', displayName: 'Admin', emails: [{ value: ADMIN_EMAIL }] };

function row(overrides = {}) {
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

function setAdminEnv() {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
}

function reqFor(user) {
  return { isAuthenticated: () => !!user, user };
}

function resSpy() {
  const res = { statusCode: 200, redirected: null, body: null };
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

test('isAdminEmail / isAdminUser: normalized comparison, no client flag involved', () => {
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(''), false);
  assert.equal(isAdminEmail('someone@example.com'), false);

  setAdminEnv();
  assert.equal(isAdminEmail('Boss@Example.com'), true, 'case-insensitive and trimmed');
  assert.equal(isAdminEmail('  boss@example.com  '), true, 'whitespace trimmed');
  assert.equal(isAdminUser(row({ email: 'Boss@example.com' })), true);
  assert.equal(isAdminUser(row({ email: 'user@example.com', admin: true })), false, 'a client-supplied flag must be ignored');
});

test('1. existing admin with a future expiry is normalized to active + NULL expiry', async () => {
  setAdminEnv();
  installPoolStub(async (sql, params) => {
    assert.match(sql, /status = 'active'/);
    assert.match(sql, /access_expires_at = NULL/);
    assert.equal(params.length, 3, 'id, email, name only; expiry is forced NULL, never passed');
    return { rowCount: 1, rows: [row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: null })] };
  });
  const user = await users.normalizeAdminUser(1, adminProfile);
  assert.equal(user.status, 'active');
  assert.equal(user.access_expires_at, null);
});

test('2. new admin Google login creates active + NULL expiry (never pending)', async () => {
  setAdminEnv();
  installPoolStub(async (sql, params) => {
    assert.match(sql, /INSERT INTO users/);
    assert.match(sql, /'active'/);
    assert.match(sql, /access_expires_at/);
    assert.equal(params.length, 3, 'no expiry value passed; forced NULL');
    return { rowCount: 1, rows: [row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: null })] };
  });
  const user = await users.createAdminUser(adminProfile);
  assert.equal(user.status, 'active');
  assert.equal(user.access_expires_at, null);
});

test('3. existing admin login never assigns an expiry', async () => {
  setAdminEnv();
  installPoolStub(async (sql, params) => {
    const hasExpiryParam = params.some(p => p instanceof Date);
    assert.equal(hasExpiryParam, false, 'login must never pass an expiry value for an admin');
    assert.ok(!/GREATEST|INTERVAL/.test(sql));
    return { rowCount: 1, rows: [row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: null })] };
  });
  const user = await users.normalizeAdminUser(1, adminProfile);
  assert.equal(user.access_expires_at, null);
});

test('4. admin can access protected pages with NULL expiry', () => {
  setAdminEnv();
  const next = nextSpy();
  requireAuth(reqFor(row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: null })), resSpy(), next);
  assert.equal(next.called, true);
});

test('5. admin can access protected APIs with NULL expiry', () => {
  setAdminEnv();
  const next = nextSpy();
  requireApiAuth(reqFor(row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: null })), resSpy(), next);
  assert.equal(next.called, true);
});

test('6. admin cannot be revoked through the server endpoint', async () => {
  setAdminEnv();
  installPoolStub(async () => ({
    rowCount: 1,
    rows: [{ id: 1, email: ADMIN_EMAIL, status: 'active', access_expires_at: new Date() }]
  }));
  await assert.rejects(() => users.revokeUser(2, 1), /Administrator accounts cannot be modified/);
  assert.equal(calls.length, 1, 'only the guard read ran; no UPDATE was executed');
  assert.match(calls[0].sql, /^SELECT/, 'guard rejects before any update');
});

test('7. approve is rejected for admins', async () => {
  const serverSrc = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

  setAdminEnv();
  installPoolStub(async () => ({
    rowCount: 1,
    rows: [{ id: 1, email: ADMIN_EMAIL, status: 'active', access_expires_at: new Date() }]
  }));
  await assert.rejects(
    () => users.approveUser(2, 1, new Date(Date.now() + 86400000)),
    /Administrator accounts cannot be modified/
  );
  assert.equal(calls.length, 1, 'approve rejected before any UPDATE');
});

test('8. admin cannot be extended or reactivated through access-management actions', async () => {
  setAdminEnv();
  const guardRow = () => ({
    rowCount: 1,
    rows: [{ id: 1, email: ADMIN_EMAIL, status: 'active', access_expires_at: new Date() }]
  });

  installPoolStub(async () => guardRow());
  await assert.rejects(() => users.extendUserByDays(2, 1, 30), /Administrator/);
  assert.equal(calls.length, 1, 'extend-by-days rejected before UPDATE');

  installPoolStub(async () => guardRow());
  await assert.rejects(() => users.extendUserToDate(2, 1, new Date(Date.now() + 86400000)), /Administrator/);
  assert.equal(calls.length, 1, 'extend-to-date rejected before UPDATE');

  installPoolStub(async () => guardRow());
  await assert.rejects(() => users.reactivateUser(2, 1, new Date(Date.now() + 86400000)), /Administrator/);
  assert.equal(calls.length, 1, 'reactivate rejected before UPDATE');
});

test('9. admin never becomes pending (creation + normalization always active)', async () => {
  const src = await readFile(new URL('../src/auth/users.js', import.meta.url), 'utf8');
  assert.match(src, /status = 'active', access_expires_at = NULL/);
  assert.match(src, /'active', NULL/);
  assert.ok(!(new RegExp("access_expires_at: null").test(src)), 'sanity guard');
});

test('10. admin never becomes expired even with a stale past expiry', () => {
  setAdminEnv();
  const next = nextSpy();
  requireAuth(reqFor(row({ email: ADMIN_EMAIL, status: 'active', access_expires_at: new Date(Date.now() - 1000) })), resSpy(), next);
  assert.equal(next.called, true, 'admin short-circuit ignores access_expires_at');
});

test('11. normal pending user behavior is unchanged while admins exist', () => {
  setAdminEnv();
  const res = resSpy();
  requireAuth(reqFor(row({ email: 'user@example.com', status: 'pending', access_expires_at: null })), res, nextSpy());
  assert.equal(res.redirected, '/access-pending');
});

test('12. normal active user with a future expiry is unchanged', () => {
  setAdminEnv();
  const next = nextSpy();
  requireAuth(reqFor(row({ email: 'user@example.com' })), resSpy(), next);
  assert.equal(next.called, true);
});

test('13. normal expired user remains denied', () => {
  setAdminEnv();
  const res = resSpy();
  requireAuth(reqFor(row({ email: 'user@example.com', access_expires_at: new Date(Date.now() - 1000) })), res, nextSpy());
  assert.equal(res.redirected, '/access-expired');
});

test('14. normal revoked user remains denied', () => {
  setAdminEnv();
  const res = resSpy();
  requireAuth(reqFor(row({ email: 'user@example.com', status: 'revoked', access_expires_at: new Date() })), res, nextSpy());
  assert.equal(res.redirected, '/access-revoked');
});

test('15. revoke → logout → login still leaves a normal user revoked', async () => {
  setAdminEnv();
  installPoolStub(async (sql) => {
    assert.ok(!/status/i.test(sql), 'login does not touch status');
    assert.ok(!/access_expires_at/.test(sql), 'login does not touch expiry');
    return { rowCount: 1, rows: [row({ email: 'user@example.com', status: 'revoked', access_expires_at: new Date() })] };
  });
  const user = await users.touchExistingUser(1, { id: 'google-1', displayName: 'U', emails: [{ value: 'user@example.com' }] });
  assert.equal(user.status, 'revoked');

  const res = resSpy();
  requireAuth(reqFor(user), res, nextSpy());
  assert.equal(res.redirected, '/access-revoked');
});

test('migration 003 makes access_expires_at nullable for admins and pending users', async () => {
  const sql = await readFile(new URL('../migrations/003_admin_protection.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER COLUMN access_expires_at DROP NOT NULL/);
});

test('normalize-admins script only touches ADMIN_EMAILS accounts and forces active + NULL', async () => {
  const script = await readFile(new URL('../scripts/normalize-admins.js', import.meta.url), 'utf8');
  assert.match(script, /SET status = 'active', access_expires_at = NULL, updated_at = NOW\(\)/);
  assert.match(script, /WHERE lower\(email\) = ANY\(\$1::text\[\]\)/);
});

test('passport wires admin creation/normalization and never treats admins as normal users', async () => {
  const src = await readFile(new URL('../src/auth/passport.js', import.meta.url), 'utf8');
  assert.match(src, /createAdminUser/);
  assert.match(src, /normalizeAdminUser/);
});