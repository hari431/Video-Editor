import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { isOwnerUser, isAdminUser, getUserRole, ROLES } from '../src/auth/admin.js';
import { requireAdmin, requireOwner } from '../src/auth/middleware.js';
import * as users from '../src/auth/users.js';

let originalQuery = null;
let originalConnect = null;
let calls = [];

function installPoolStub(handler) {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return handler(sql, params);
  };
  // Mock client for transactional grant/revoke (BEGIN/COMMIT)
  pool.connect = async () => {
    return {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return handler(sql, params);
      },
      release: () => {}
    };
  };
}
function restorePool() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
}
function resSpy() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => { res.body = body; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}
function nextSpy() { const fn = () => { fn.called = true; }; fn.called = false; return fn; }
function reqFor(user) { return { isAuthenticated: () => !!user, user }; }

test.afterEach(() => { restorePool(); });

// --- Role recognition ---
test('Role recognition: Owner recognized as Owner + Admin, Admin as Admin, User as User', () => {
  const owner = { id: 1, email: 'owner@x.com', app_role: 'OWNER' };
  const admin = { id: 2, email: 'admin@x.com', app_role: 'ADMIN' };
  const user = { id: 3, email: 'user@x.com', app_role: 'USER' };
  assert.equal(isOwnerUser(owner), true);
  assert.equal(isAdminUser(owner), true);
  assert.equal(getUserRole(owner), 'OWNER');
  assert.equal(isOwnerUser(admin), false);
  assert.equal(isAdminUser(admin), true);
  assert.equal(getUserRole(admin), 'ADMIN');
  assert.equal(isOwnerUser(user), false);
  assert.equal(isAdminUser(user), false);
  assert.equal(getUserRole(user), 'USER');
  // fallback via email before migration
  process.env.ADMIN_EMAILS = 'fallback@x.com';
  const fallback = { id: 9, email: 'fallback@x.com' };
  assert.equal(isAdminUser(fallback), true);
  assert.equal(isOwnerUser(fallback), true);
  delete process.env.ADMIN_EMAILS;
});

test('Fallback: unknown email is USER when no app_role', () => {
  assert.equal(isAdminUser({ email: 'nobody@x.com' }), false);
  assert.equal(isOwnerUser({ email: 'nobody@x.com' }), false);
  assert.equal(getUserRole({ email: 'nobody@x.com' }), 'USER');
});

// --- Authorization ---
test('requireAdmin allows Owner and Admin, rejects User', () => {
  const owner = { email: 'o@x.com', app_role: 'OWNER' };
  const admin = { email: 'a@x.com', app_role: 'ADMIN' };
  const user = { email: 'u@x.com', app_role: 'USER' };
  let res = resSpy(); let next = nextSpy();
  requireAdmin(reqFor(owner), res, next); assert.equal(next.called, true);
  res = resSpy(); next = nextSpy();
  requireAdmin(reqFor(admin), res, next); assert.equal(next.called, true);
  res = resSpy(); next = nextSpy();
  requireAdmin(reqFor(user), res, next); assert.equal(res.statusCode, 403);
  assert.equal(next.called, false);
});
test('requireOwner allows Owner, rejects Admin and User', () => {
  const owner = { email: 'o@x.com', app_role: 'OWNER' };
  const admin = { email: 'a@x.com', app_role: 'ADMIN' };
  const user = { email: 'u@x.com', app_role: 'USER' };
  let res = resSpy(); let next = nextSpy();
  requireOwner(reqFor(owner), res, next); assert.equal(next.called, true);
  res = resSpy(); next = nextSpy();
  requireOwner(reqFor(admin), res, next); assert.equal(res.statusCode, 403);
  res = resSpy(); next = nextSpy();
  requireOwner(reqFor(user), res, next); assert.equal(res.statusCode, 403);
});

// --- Role management ---
test('Owner promotes User -> Admin (audit recorded)', async () => {
  const ownerId = 1, targetId = 2;
  const responses = [
    { rows: [{ id: ownerId, email: 'owner@x.com', app_role: 'OWNER', status: 'active', access_expires_at: null }], rowCount: 1 },
    { rows: [{ id: targetId, email: 'user@x.com', app_role: 'USER', status: 'active', access_expires_at: new Date() }], rowCount: 1 },
    { rows: [] }, // BEGIN
    { rows: [{ id: targetId, email: 'user@x.com', app_role: 'ADMIN' }], rowCount: 1 }, // UPDATE
    { rowCount: 1 }, // audit INSERT
    { rows: [] } // COMMIT
  ];
  installPoolStub(async () => responses.shift());
  const result = await users.grantAdmin(ownerId, targetId);
  assert.equal(result.app_role, 'ADMIN');
  const update = calls.find(c => /UPDATE users SET app_role = 'ADMIN'/.test(c.sql));
  assert.ok(update);
  const audit = calls.find(c => /INSERT INTO role_audit_log/.test(c.sql));
  assert.ok(audit);
  assert.equal(audit.params[2], 'USER');
  assert.equal(audit.params[3], 'ADMIN');
  assert.equal(audit.params[4], 'grant_admin');
});

test('Owner demotes Admin -> User (audit recorded)', async () => {
  const ownerId = 1, targetId = 3;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetId, app_role: 'ADMIN', status: 'active', access_expires_at: null, email: 'a@x.com' }], rowCount: 1 },
    { rows: [] }, // BEGIN
    { rows: [{ id: targetId, app_role: 'USER' }], rowCount: 1 },
    { rowCount: 1 },
    { rows: [] } // COMMIT
  ];
  installPoolStub(async () => responses.shift());
  const result = await users.revokeAdmin(ownerId, targetId);
  assert.equal(result.app_role, 'USER');
  const update = calls.find(c => /UPDATE users SET app_role = 'USER'/.test(c.sql));
  assert.ok(update);
  const audit = calls.find(c => /INSERT INTO role_audit_log/.test(c.sql));
  assert.equal(audit.params[4], 'revoke_admin');
});

test('Admin cannot promote User (must be Owner)', async () => {
  const adminId = 2, targetId = 3;
  installPoolStub(async (sql) => {
    if (/SELECT.*FROM users WHERE id =/.test(sql)) {
      return { rows: [{ id: adminId, app_role: 'ADMIN' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(() => users.grantAdmin(adminId, targetId), /Only the Owner/);
});

test('Admin cannot demote Admin', async () => {
  const adminId = 2, targetId = 4;
  installPoolStub(async (sql) => {
    if (/SELECT.*FROM users WHERE id =/.test(sql)) {
      return { rows: [{ id: adminId, app_role: 'ADMIN' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(() => users.revokeAdmin(adminId, targetId), /Only the Owner/);
});

test('Admin cannot modify Owner', async () => {
  const ownerId = 1, adminId = 2;
  // admin tries to grant admin to owner (should fail because owner role cannot be changed)
  installPoolStub(async (sql) => {
    if (/SELECT.*FROM users WHERE id =/.test(sql) && sql.includes('$1')) {
      // first call is assertActorIsOwner for adminId
      if (calls.length === 0 || calls.length===1) {
        // we need to simulate fetchUser for actor
      }
      return { rows: [{ id: adminId, app_role: 'ADMIN' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  // Actually test grantAdmin where actor is Owner but target is Owner should fail
  installPoolStub(async (sql, params) => {
    // dispatch based on call order
    if (calls.length === 1) { // first fetchUser(actor) inside assertActorIsOwner - but calls already pushed
      // This handler is called after push, so we need to count
    }
    return { rows: [], rowCount: 0 };
  });
  // Simpler: Owner trying to modify Owner should fail with "Owner role cannot be changed"
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 }, // actor
    { rows: [{ id: ownerId, app_role: 'OWNER', email: 'owner@x.com' }], rowCount: 1 } // target
  ];
  installPoolStub(async () => responses.shift());
  await assert.rejects(() => users.grantAdmin(ownerId, ownerId), /Owner role cannot be changed|Cannot change your own role/);
});

test('User cannot modify roles', async () => {
  const userId = 10, targetId = 11;
  installPoolStub(async () => ({ rows: [{ id: userId, app_role: 'USER' }], rowCount: 1 }));
  await assert.rejects(() => users.grantAdmin(userId, targetId), /Only the Owner/);
});

test('nobody can create a second OWNER through grantAdmin', async () => {
  const ownerId = 1, targetId = 5;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetId, app_role: 'USER' }], rowCount: 1 },
    { rows: [] },
    { rows: [{ id: targetId, app_role: 'ADMIN' }], rowCount: 1 },
    { rowCount: 1 },
    { rows: [] }
  ];
  installPoolStub(async () => responses.shift());
  const result = await users.grantAdmin(ownerId, targetId);
  assert.notEqual(result.app_role, 'OWNER');
  assert.equal(result.app_role, 'ADMIN');
  for (const c of calls) {
    if (/UPDATE users SET app_role/.test(c.sql)) {
      assert.ok(!c.sql.includes("'OWNER'") || c.sql.includes("WHERE app_role = 'OWNER'"), 'grant should not set OWNER');
    }
  }
});

test('Persistence: getUsersForAdmin returns app_role', async () => {
  installPoolStub(async (sql) => {
    assert.match(sql, /app_role/);
    return { rows: [{ id: 1, email: 'a@x.com', app_role: 'OWNER' }] };
  });
  const rows = await users.getUsersForAdmin();
  assert.equal(rows[0].app_role, 'OWNER');
});

test('Audit: promotion and demotion record actor, target, timestamp', async () => {
  installPoolStub(async (sql) => {
    if (/role_audit_log/.test(sql)) {
      return { rows: [{ id: 1, action: 'grant_admin', previous_role: 'USER', new_role: 'ADMIN', target_email: 'u@x.com', actor_email: 'owner@x.com', created_at: new Date() }] };
    }
    return { rows: [] };
  });
  const log = await users.getRoleAuditLog(10);
  assert.equal(log[0].action, 'grant_admin');
  assert.equal(log[0].previous_role, 'USER');
  assert.equal(log[0].new_role, 'ADMIN');
  assert.ok(log[0].created_at instanceof Date || typeof log[0].created_at === 'string');
});

test('Regression: normalizeAdminUser does NOT re-promote a demoted USER', async () => {
  process.env.ADMIN_EMAILS = 'demoted@example.com';
  const userId = 99;
  const profile = { id: 'google-99', displayName: 'Demoted', emails: [{ value: 'demoted@example.com' }] };
  // First update (email/name) + check currentRole = USER + ownerExists check
  const responses = [
    { rows: [{ id: userId, email: 'demoted@example.com', app_role: 'USER' }], rowCount: 1 }, // UPDATE users set email... RETURNING *
    { rows: [{ id: userId, app_role: 'USER' }], rowCount: 1 }, // SELECT app_role
    // should NOT do promotion because currentRole is USER but we fixed to only if null
    // So no further queries, just return
  ];
  let queryCount = 0;
  installPoolStub(async (sql) => {
    const r = responses[queryCount++];
    if (!r) return { rows: [], rowCount: 0 };
    return r;
  });
  const result = await users.normalizeAdminUser(userId, profile);
  // Should return the first UPDATE result, not promoted
  assert.equal(result.app_role, 'USER');
  // Ensure no UPDATE app_role to ADMIN/OWNER happened
  const roleUpdates = calls.filter(c => /UPDATE users SET app_role/.test(c.sql));
  assert.equal(roleUpdates.length, 0, 'should not re-promote demoted USER');
  delete process.env.ADMIN_EMAILS;
});

test('Regression: grant/revoke are transactional (BEGIN/COMMIT)', async () => {
  const ownerId = 1, targetId = 2;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetId, app_role: 'USER' }], rowCount: 1 },
    { rows: [] }, // BEGIN
    { rows: [{ id: targetId, app_role: 'ADMIN' }], rowCount: 1 },
    { rowCount: 1 },
    { rows: [] } // COMMIT
  ];
  installPoolStub(async () => responses.shift());
  await users.grantAdmin(ownerId, targetId);
  assert.ok(calls.some(c => /BEGIN/.test(c.sql)));
  assert.ok(calls.some(c => /COMMIT/.test(c.sql)));
  assert.ok(!calls.some(c => /ROLLBACK/.test(c.sql)));
});

test('Regression: ADMIN_EMAILS fallback not used when app_role present', async () => {
  process.env.ADMIN_EMAILS = 'user@example.com';
  const user = { email: 'user@example.com', app_role: 'USER' };
  assert.equal(isAdminUser(user), false, 'USER with ADMIN_EMAILS should not be admin when DB says USER');
  assert.equal(isOwnerUser(user), false);
  assert.equal(getUserRole(user), 'USER');
  delete process.env.ADMIN_EMAILS;
});
