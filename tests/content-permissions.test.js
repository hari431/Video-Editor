import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { PERMISSIONS, isValidPermission, hasContentPermission, getUserContentPermissions, grantContentPermission, revokeContentPermission, getAllContentPermissions } from '../src/auth/content-permissions.js';
import { isAdminUser, isOwnerUser } from '../src/auth/admin.js';

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
  pool.connect = async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
    release: () => {}
  });
}
function restore() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
}
test.afterEach(() => restore());

test('PERMISSIONS constants are correct', () => {
  assert.equal(PERMISSIONS.COPY_QUERY, 'COPY_QUERY');
  assert.equal(PERMISSIONS.DOWNLOAD_PDF, 'DOWNLOAD_PDF');
  assert.equal(isValidPermission('COPY_QUERY'), true);
  assert.equal(isValidPermission('DOWNLOAD_PDF'), true);
  assert.equal(isValidPermission('UNKNOWN'), false);
  assert.equal(isValidPermission(''), false);
});

test('Owner always allowed', async () => {
  const owner = { id: 1, email: 'o@x.com', app_role: 'OWNER' };
  // Should return true without DB query (owner bypass)
  // Install stub that would fail if queried
  installPoolStub(async () => { throw new Error('should not query for owner'); });
  assert.equal(await hasContentPermission(owner, 'COPY_QUERY'), true);
  assert.equal(await hasContentPermission(owner, 'DOWNLOAD_PDF'), true);
});

test('Admin always allowed', async () => {
  const admin = { id: 2, email: 'a@x.com', app_role: 'ADMIN' };
  installPoolStub(async () => { throw new Error('should not query for admin'); });
  assert.equal(await hasContentPermission(admin, 'COPY_QUERY'), true);
  assert.equal(await hasContentPermission(admin, 'DOWNLOAD_PDF'), true);
});

test('USER denied by default', async () => {
  const user = { id: 3, email: 'u@x.com', app_role: 'USER' };
  installPoolStub(async (sql) => {
    if (/FROM content_action_permissions/.test(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  });
  assert.equal(await hasContentPermission(user, 'COPY_QUERY'), false);
  assert.equal(await hasContentPermission(user, 'DOWNLOAD_PDF'), false);
});

test('USER allowed after grant', async () => {
  const user = { id: 3, email: 'u@x.com', app_role: 'USER' };
  installPoolStub(async (sql) => {
    if (/FROM content_action_permissions/.test(sql)) return { rowCount: 1, rows: [{ permission: 'COPY_QUERY' }] };
    return { rowCount: 0, rows: [] };
  });
  assert.equal(await hasContentPermission(user, 'COPY_QUERY'), true);
});

test('Unknown permission rejected', async () => {
  const user = { id: 3, email: 'u@x.com', app_role: 'USER' };
  await assert.rejects(() => hasContentPermission(user, 'BAD_PERM'), /Unknown permission/);
  await assert.rejects(() => hasContentPermission(user, ''), /Unknown permission/);
});

test('Per-user isolation', async () => {
  // User 3 has COPY_QUERY, user 4 doesn't
  const user3 = { id: 3, email: 'u3@x.com', app_role: 'USER' };
  const user4 = { id: 4, email: 'u4@x.com', app_role: 'USER' };
  installPoolStub(async (sql, params) => {
    if (/FROM content_action_permissions/.test(sql)) {
      if (params[0] === 3 && params[1] === 'COPY_QUERY') return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  assert.equal(await hasContentPermission(user3, 'COPY_QUERY'), true);
  assert.equal(await hasContentPermission(user4, 'COPY_QUERY'), false);
});

test('grantContentPermission: Owner can grant', async () => {
  const ownerId = 1, targetId = 5;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 }, // fetch actor
    { rows: [{ id: targetId, app_role: 'USER', email: 'u@x.com' }], rowCount: 1 }, // fetch target
    { rows: [] }, // BEGIN
    { rowCount: 1 }, // INSERT permission
    { rowCount: 1 }, // audit
    { rows: [] } // COMMIT
  ];
  installPoolStub(async () => responses.shift() || { rows: [], rowCount: 0 });
  await grantContentPermission(targetId, 'COPY_QUERY', ownerId);
  assert.ok(calls.some(c => /INSERT INTO content_action_permissions/.test(c.sql)));
  assert.ok(calls.some(c => /INSERT INTO content_permission_audit_log/.test(c.sql) && /GRANT/.test(c.sql)));
});

test('revokeContentPermission: Owner can revoke', async () => {
  const ownerId = 1, targetId = 5;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetId, app_role: 'USER' }], rowCount: 1 },
    { rows: [] },
    { rowCount: 1 },
    { rowCount: 1 },
    { rows: [] }
  ];
  installPoolStub(async () => responses.shift() || { rows: [], rowCount: 0 });
  await revokeContentPermission(targetId, 'COPY_QUERY', ownerId);
  assert.ok(calls.some(c => /DELETE FROM content_action_permissions/.test(c.sql)));
});

test('ADMIN cannot grant', async () => {
  const adminId = 2, targetId = 5;
  installPoolStub(async () => ({ rows: [{ id: adminId, app_role: 'ADMIN' }], rowCount: 1 }));
  await assert.rejects(() => grantContentPermission(targetId, 'COPY_QUERY', adminId), /Only the Owner/);
});

test('ADMIN cannot revoke', async () => {
  const adminId = 2, targetId = 5;
  installPoolStub(async () => ({ rows: [{ id: adminId, app_role: 'ADMIN' }], rowCount: 1 }));
  await assert.rejects(() => revokeContentPermission(targetId, 'COPY_QUERY', adminId), /Only the Owner/);
});

test('USER cannot grant', async () => {
  const userId = 10, targetId = 11;
  installPoolStub(async () => ({ rows: [{ id: userId, app_role: 'USER' }], rowCount: 1 }));
  await assert.rejects(() => grantContentPermission(targetId, 'COPY_QUERY', userId), /Only the Owner/);
});

test('Invalid permission rejected in grant/revoke', async () => {
  await assert.rejects(() => grantContentPermission(1, 'BAD', 1), /Unknown permission/);
  await assert.rejects(() => revokeContentPermission(1, 'BAD', 1), /Unknown permission/);
});

test('Invalid target user rejected', async () => {
  await assert.rejects(() => grantContentPermission('bad', 'COPY_QUERY', 1), /Invalid target/);
});

test('Owner permissions cannot be modified', async () => {
  const ownerId = 1, targetOwnerId = 2;
  installPoolStub(async (sql, params) => {
    // first call actor, second target
    if (calls.length === 1) return { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 };
    if (calls.length === 2) return { rows: [{ id: targetOwnerId, app_role: 'OWNER' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  // Need two calls: actor fetch and target fetch; our stub above is off by one due to pushes
  // Safer to use responses array
  const responses2 = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetOwnerId, app_role: 'OWNER' }], rowCount: 1 }
  ];
  installPoolStub(async () => responses2.shift() || { rows: [], rowCount: 0 });
  await assert.rejects(() => grantContentPermission(targetOwnerId, 'COPY_QUERY', ownerId), /Owner permissions cannot be modified/);
});

test('Grant/revoke are transactional', async () => {
  const ownerId = 1, targetId = 5;
  const responses = [
    { rows: [{ id: ownerId, app_role: 'OWNER' }], rowCount: 1 },
    { rows: [{ id: targetId, app_role: 'USER' }], rowCount: 1 },
    { rows: [] },
    { rowCount: 1 },
    { rowCount: 1 },
    { rows: [] }
  ];
  installPoolStub(async () => responses.shift() || { rows: [], rowCount: 0 });
  await grantContentPermission(targetId, 'DOWNLOAD_PDF', ownerId);
  assert.ok(calls.some(c => /BEGIN/.test(c.sql)));
  assert.ok(calls.some(c => /COMMIT/.test(c.sql)));
});

test('getUserContentPermissions returns Set', async () => {
  installPoolStub(async () => ({ rows: [{ permission: 'COPY_QUERY' }, { permission: 'DOWNLOAD_PDF' }] }));
  const set = await getUserContentPermissions(3);
  assert.ok(set instanceof Set);
  assert.equal(set.has('COPY_QUERY'), true);
  assert.equal(set.has('DOWNLOAD_PDF'), true);
});

test('Migration file exists and is idempotent SQL', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../migrations/017_content_action_permissions.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS content_action_permissions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS content_permission_audit_log/);
  assert.match(sql, /UNIQUE\(user_id, permission\)/);
  assert.match(sql, /permission IN \('COPY_QUERY','DOWNLOAD_PDF'\)/);
});

test('Server enforces download permission for PDFs', async () => {
  const srv = await (await import('node:fs/promises')).readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const mod = await (await import('node:fs/promises')).readFile(new URL('../src/auth/content-permissions.js', import.meta.url), 'utf8');
  assert.match(srv, /hasContentPermission/);
  assert.match(srv, /DOWNLOAD_PDF/);
  assert.match(srv, /COPY_QUERY/);
  assert.match(srv, /requireOwner/);
  assert.match(mod, /content_action_permissions/);
  assert.ok(srv.includes('canAccessLibraryPath'));
});

test('Admin page hides Content Permissions from non-owners', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/views/admin.ejs', import.meta.url), 'utf8');
  const auditSrc = await (await import('node:fs/promises')).readFile(new URL('../src/views/admin-audit-logs.ejs', import.meta.url), 'utf8');
  assert.match(src, /isOwner/);
  assert.match(src, /Content Permissions/);
  // Audit log moved to dedicated Audit Logs screen
  assert.match(auditSrc, /contentPermissionAuditLog/);
});
