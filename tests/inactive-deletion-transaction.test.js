import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

// Helper to create a mock pg client that simulates transactions and SAVEPOINTs
function createTxMockClient({ failOnSql = null, users = new Map() } = {}) {
  const calls = [];
  let inTransaction = false;
  let savepoints = [];
  // pending deletes that are in current transaction, committed on COMMIT, discarded on ROLLBACK
  let pendingOps = [];
  let committedOps = [];

  const client = {
    calls,
    committedOps,
    pendingOps,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      const s = sql.trim();
      // Transaction control
      if (/^BEGIN/i.test(s)) {
        inTransaction = true;
        pendingOps = [];
        savepoints = [];
        return { rowCount: 0, rows: [] };
      }
      if (/^COMMIT/i.test(s)) {
        if (inTransaction) {
          committedOps.push(...pendingOps);
          pendingOps = [];
          inTransaction = false;
          savepoints = [];
        }
        return { rowCount: 0, rows: [] };
      }
      if (/^ROLLBACK$/i.test(s)) {
        if (inTransaction) {
          pendingOps = [];
          inTransaction = false;
          savepoints = [];
        }
        return { rowCount: 0, rows: [] };
      }
      if (/^SAVEPOINT/i.test(s)) {
        if (!inTransaction) throw new Error('SAVEPOINT can only be used in transaction blocks');
        savepoints.push({ name: s.match(/SAVEPOINT\s+(\w+)/i)?.[1], opsSnapshot: [...pendingOps] });
        return { rowCount: 0, rows: [] };
      }
      if (/^RELEASE SAVEPOINT/i.test(s)) {
        // pop
        const name = s.match(/RELEASE SAVEPOINT\s+(\w+)/i)?.[1];
        savepoints = savepoints.filter(sp => sp.name !== name);
        return { rowCount: 0, rows: [] };
      }
      if (/^ROLLBACK TO SAVEPOINT/i.test(s)) {
        const name = s.match(/ROLLBACK TO SAVEPOINT\s+(\w+)/i)?.[1];
        const sp = [...savepoints].reverse().find(x => x.name === name);
        if (sp) {
          pendingOps = [...sp.opsSnapshot];
        }
        return { rowCount: 0, rows: [] };
      }
      // Check for injected failure
      if (failOnSql && s.includes(failOnSql)) {
        throw new Error(`injected failure on ${failOnSql}`);
      }
      // Simulate user fetch
      if (/SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = \$1/i.test(s)) {
        const id = Number(params[0]);
        const u = users.get(id);
        if (u) return { rows: [u], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT id, email FROM users WHERE id = \$1/i.test(s)) {
        const id = Number(params[0]);
        const u = users.get(id);
        if (u) return { rows: [u], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      // Simulate DELETEs – track as pending if in transaction, else committed immediately (autocommit)
      if (/^DELETE FROM/i.test(s)) {
        if (inTransaction) {
          pendingOps.push({ sql: s, params });
        } else {
          committedOps.push({ sql: s, params });
        }
        return { rowCount: 1, rows: [] };
      }
      // INSERT for audit log
      if (/INSERT INTO access_audit_log/i.test(s) || /INSERT INTO/i.test(s)) {
        if (inTransaction) pendingOps.push({ sql: s, params });
        else committedOps.push({ sql: s, params });
        return { rowCount: 1, rows: [] };
      }
      // SELECT for admin checks
      if (/SELECT id FROM users WHERE app_role = 'OWNER'/i.test(s)) return { rows: [], rowCount: 0 };
      // fallback
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };
  return client;
}

test('eligible test user can be deleted successfully (atomic per-user)', async () => {
  const user = { id: 9001, email: 'eligible9001@example.com', status: 'expired', access_expires_at: new Date(Date.now() - 86400000).toISOString(), app_role: 'USER' };
  const users = new Map([[9001, user]]);
  const mockClient = createTxMockClient({ users });
  const originalConnect = pool.connect;
  pool.connect = async () => mockClient;
  try {
    const { deleteUserPermanently } = await import('../src/auth/userDeletion.js');
    const result = await deleteUserPermanently(9001, { actorUserId: null });
    assert.equal(result.deleted, true);
    // Verify that at least one delete and the final user delete were committed
    const hasUserDelete = mockClient.committedOps.some(op => op.sql.includes('DELETE FROM users WHERE id'));
    assert.ok(hasUserDelete, 'users row should be deleted and committed');
    const hasSomeChild = mockClient.committedOps.some(op => op.sql.includes('DELETE FROM content_action_permissions'));
    assert.ok(hasSomeChild, 'child tables should be deleted');
  } finally {
    pool.connect = originalConnect;
  }
});

test('all deletion operations for one user are atomic – failure midway rolls back earlier deletes', async () => {
  const user = { id: 9002, email: 'eligible9002@example.com', status: 'expired', access_expires_at: new Date().toISOString(), app_role: 'USER' };
  const users = new Map([[9002, user]]);
  // Fail on item_likes – which is in the middle of USER_TABLE_DELETES
  const mockClient = createTxMockClient({ users, failOnSql: 'DELETE FROM item_likes' });
  // But we need to simulate that safeDelete catches the failure and continues, not throw for that table.
  // To test atomicity of the whole user transaction, we inject failure on the final DELETE FROM users instead
  const mockClient2 = createTxMockClient({ users, failOnSql: 'DELETE FROM users WHERE id' });
  const originalConnect = pool.connect;
  pool.connect = async () => mockClient2;
  try {
    const { deleteUserPermanently } = await import('../src/auth/userDeletion.js');
    await assert.rejects(() => deleteUserPermanently(9002, { actorUserId: null }), /injected failure/);
    // After failure, the whole transaction should be rolled back – no committedOps
    assert.equal(mockClient2.committedOps.length, 0, 'no ops should be committed after rollback');
    // Pending should be discarded
    assert.equal(mockClient2.pendingOps.length, 0);
  } finally {
    pool.connect = originalConnect;
  }
});

test('safeDelete failure on one table does not abort whole user deletion (optional tables)', async () => {
  const user = { id: 9003, email: 'eligible9003@example.com', status: 'expired', access_expires_at: new Date().toISOString(), app_role: 'USER' };
  const users = new Map([[9003, user]]);
  // Fail on a middle table – safeDelete should catch and continue, overall delete should still succeed and commit
  const mockClient = createTxMockClient({ users, failOnSql: 'DELETE FROM item_likes' });
  const originalConnect = pool.connect;
  pool.connect = async () => mockClient;
  try {
    const { deleteUserPermanently } = await import('../src/auth/userDeletion.js');
    const result = await deleteUserPermanently(9003, { actorUserId: null });
    assert.equal(result.deleted, true, 'user should still be deleted even if one optional table fails');
    // Verify that other tables were still committed
    const hasUserDelete = mockClient.committedOps.some(op => op.sql.includes('DELETE FROM users WHERE id'));
    assert.ok(hasUserDelete);
    // The failing table should not be in committedOps (it was rolled back to savepoint)
    const hasFailedTable = mockClient.committedOps.some(op => op.sql.includes('DELETE FROM item_likes'));
    assert.equal(hasFailedTable, false, 'failed table should not be committed, but others should');
  } finally {
    pool.connect = originalConnect;
  }
});

test('a failed user does not prevent the next eligible user from being processed (batch)', async () => {
  process.env.USER_INACTIVE_DELETE_DAYS = '60';
  const userA = { id: 9010, email: 'batch-a@example.com', status: 'expired', app_role: 'USER', last_activity_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(), access_expires_at: new Date().toISOString() };
  const userB = { id: 9011, email: 'batch-b@example.com', status: 'expired', app_role: 'USER', last_activity_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(), access_expires_at: new Date().toISOString() };
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  // Mock pool.connect to give per-user clients: first delete fails, second succeeds
  let deleteIndex = 0;
  const usersMap = new Map([[9010, userA], [9011, userB]]);
  pool.connect = async () => {
    // This is called for each deleteUserPermanently (since we no longer pass client)
    // deleteIndex 0 -> first user (9010) should fail, 1 -> second user (9011) should succeed
    const shouldFail = deleteIndex === 0;
    deleteIndex++;
    return createTxMockClient({ users: usersMap, failOnSql: shouldFail ? 'DELETE FROM users WHERE id' : null });
  };
  // Mock pool.query for find – runInactiveUserCleanup will use the passed client for find
  let findCalls = 0;
  const mockPoolForBatch = {
    query: async (sql, params) => {
      if (/FROM users/i.test(sql) && /last_activity_at/i.test(sql) && /status != 'active'/i.test(sql)) {
        if (findCalls === 0) { findCalls++; return { rows: [userA, userB], rowCount: 2 }; }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  try {
    const { runInactiveUserCleanup } = await import('../src/cleanup/inactiveUsers.js');
    const result = await runInactiveUserCleanup({ client: mockPoolForBatch, batchSize: 10, dryRun: false });
    assert.equal(result.processed, 2);
    assert.equal(result.deleted, 1, 'one should be deleted');
    assert.equal(result.failed, 1, 'one should fail');
    assert.equal(result.failedIds[0].id, 9010);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test('manual single-user deletion still works', async () => {
  const user = { id: 9020, email: 'manual9020@example.com', status: 'expired', app_role: 'USER', access_expires_at: new Date().toISOString() };
  const users = new Map([[9020, user]]);
  const mockClient = createTxMockClient({ users });
  const originalConnect = pool.connect;
  pool.connect = async () => mockClient;
  try {
    const { deleteUserPermanently } = await import('../src/auth/userDeletion.js');
    const result = await deleteUserPermanently(9020, { actorUserId: 1 });
    assert.equal(result.deleted, true);
    assert.ok(mockClient.committedOps.some(op => op.sql.includes('DELETE FROM users WHERE id')));
  } finally {
    pool.connect = originalConnect;
  }
});

test('OWNER/ADMIN protection still works', async () => {
  const owner = { id: 9030, email: 'owner9030@example.com', status: 'expired', app_role: 'OWNER', access_expires_at: new Date().toISOString() };
  const admin = { id: 9031, email: 'admin9031@example.com', status: 'expired', app_role: 'ADMIN', access_expires_at: new Date().toISOString() };
  const users = new Map([[9030, owner], [9031, admin]]);
  const mockClient = createTxMockClient({ users });
  const originalConnect = pool.connect;
  pool.connect = async () => mockClient;
  try {
    const { deleteUserPermanently } = await import('../src/auth/userDeletion.js');
    await assert.rejects(() => deleteUserPermanently(9030, {}), /Cannot delete OWNER or ADMIN/);
    await assert.rejects(() => deleteUserPermanently(9031, {}), /Cannot delete OWNER or ADMIN/);
    assert.equal(mockClient.committedOps.length, 0, 'no deletes should be committed for protected users');
  } finally {
    pool.connect = originalConnect;
  }
});

// Also verify ADMIN_EMAILS protection via find query
test('ADMIN_EMAILS are excluded from eligibility', async () => {
  process.env.ADMIN_EMAILS = 'protected@example.com';
  const { findInactiveUsersForDeletion } = await import('../src/cleanup/inactiveUsers.js');
  let capturedSql = null;
  let capturedParams = null;
  const mockClient = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  };
  await findInactiveUsersForDeletion(mockClient, 60, 10);
  assert.ok(capturedSql.includes('LOWER(email) NOT IN'));
  assert.ok(capturedParams.includes('protected@example.com'));
  delete process.env.ADMIN_EMAILS;
});
