import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileExpiredUserStatuses } from '../src/auth/users.js';
import { reconcileAllPaidProducts } from '../src/auth/paidProducts.js';

test('User Base Account Status Reconciliation Suite', async (t) => {
  await t.test('1. Updates active user with past access_expires_at to expired status', async () => {
    let users = [
      { id: 101, email: 'expired@example.com', status: 'active', access_expires_at: '2026-09-01T00:00:00.000Z', app_role: 'USER' }
    ];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/UPDATE users\s+SET status = 'expired'/i.test(sql)) {
          const updated = [];
          for (const u of users) {
            if (u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role)) {
              u.status = 'expired';
              updated.push(u);
            }
          }
          return { rowCount: updated.length, rows: updated };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: false });
    assert.equal(res.usersExpired, 1, 'Should expire 1 user');
    assert.equal(users[0].status, 'expired', 'User status must be set to expired');
  });

  await t.test('2. Preserves active user with future access_expires_at', async () => {
    let users = [
      { id: 102, email: 'active@example.com', status: 'active', access_expires_at: '2027-01-01T00:00:00.000Z', app_role: 'USER' }
    ];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/UPDATE users\s+SET status = 'expired'/i.test(sql)) {
          const updated = [];
          for (const u of users) {
            if (u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role)) {
              u.status = 'expired';
              updated.push(u);
            }
          }
          return { rowCount: updated.length, rows: updated };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: false });
    assert.equal(res.usersExpired, 0, 'Should not expire active user with future expiry');
    assert.equal(users[0].status, 'active', 'User status must remain active');
  });

  await t.test('3. Does NOT modify OWNER or ADMIN users even if access_expires_at is past', async () => {
    let users = [
      { id: 1, email: 'owner@example.com', status: 'active', access_expires_at: '2026-01-01T00:00:00.000Z', app_role: 'OWNER' },
      { id: 2, email: 'admin@example.com', status: 'active', access_expires_at: '2026-01-01T00:00:00.000Z', app_role: 'ADMIN' }
    ];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/UPDATE users\s+SET status = 'expired'/i.test(sql)) {
          const updated = [];
          for (const u of users) {
            if (u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role)) {
              u.status = 'expired';
              updated.push(u);
            }
          }
          return { rowCount: updated.length, rows: updated };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: false });
    assert.equal(res.usersExpired, 0, 'Must not expire ADMIN/OWNER users');
    assert.equal(users[0].status, 'active');
    assert.equal(users[1].status, 'active');
  });

  await t.test('4. Does NOT modify non-active statuses (e.g. revoked, pending, expired)', async () => {
    let users = [
      { id: 103, email: 'revoked@example.com', status: 'revoked', access_expires_at: '2026-01-01T00:00:00.000Z', app_role: 'USER' }
    ];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/UPDATE users\s+SET status = 'expired'/i.test(sql)) {
          const updated = [];
          for (const u of users) {
            if (u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role)) {
              u.status = 'expired';
              updated.push(u);
            }
          }
          return { rowCount: updated.length, rows: updated };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: false });
    assert.equal(res.usersExpired, 0, 'Must not change non-active status');
    assert.equal(users[0].status, 'revoked');
  });

  await t.test('5. Dry-run mode evaluates count without mutating database', async () => {
    let users = [
      { id: 104, email: 'dryrun@example.com', status: 'active', access_expires_at: '2026-01-01T00:00:00.000Z', app_role: 'USER' }
    ];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/SELECT COUNT/i.test(sql)) {
          const matching = users.filter(u => u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role));
          return { rowCount: 1, rows: [{ count: matching.length }] };
        }
        if (/UPDATE users/i.test(sql)) {
          throw new Error('Update should not be called in dry-run mode');
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.usersExpired, 1, 'Dry run should report 1 expired user');
    assert.equal(users[0].status, 'active', 'DB status must remain active during dry run');
  });

  await t.test('6. User status reconciliation DB failure throws error directly', async () => {
    const failingClient = {
      query: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }
    };

    await assert.rejects(
      async () => {
        await reconcileExpiredUserStatuses({ client: failingClient });
      },
      { message: 'connect ECONNREFUSED 127.0.0.1:5432' }
    );
  });

  await t.test('7. Full reconciliation surfaces DB failure as success=false with error details', async () => {
    const failingClient = {
      query: async (sql) => {
        if (/SELECT \* FROM paid_products/i.test(sql)) {
          return { rows: [] };
        }
        if (/UPDATE users/i.test(sql)) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        }
        return { rows: [] };
      }
    };

    const res = await reconcileAllPaidProducts({ client: failingClient, dryRun: false });
    assert.equal(res.success, false, 'Reconciliation must fail when user status DB query errors');
    assert.ok(res.errors.length > 0, 'Must record the error in errors list');
    assert.equal(res.errors[0].productCode, 'SYSTEM_USER_STATUS');
    assert.equal(res.errors[0].error, 'connect ECONNREFUSED 127.0.0.1:5432');
  });

  await t.test('8. Inserts expire action into access_audit_log on user status reconciliation', async () => {
    let users = [
      { id: 105, email: 'audit_test@example.com', status: 'active', access_expires_at: '2026-08-01T00:00:00.000Z', app_role: 'USER' }
    ];
    const auditLogs = [];

    const mockClient = {
      query: async (sql, params = []) => {
        if (/UPDATE users\s+SET status = 'expired'/i.test(sql)) {
          const updated = [];
          for (const u of users) {
            if (u.status === 'active' && u.access_expires_at && new Date(u.access_expires_at) <= new Date() && !['OWNER', 'ADMIN'].includes(u.app_role)) {
              u.status = 'expired';
              updated.push(u);
            }
          }
          return { rowCount: updated.length, rows: updated };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          auditLogs.push({ sql, params });
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const res = await reconcileExpiredUserStatuses({ client: mockClient, dryRun: false });
    assert.equal(res.usersExpired, 1);
    assert.equal(auditLogs.length, 1, 'Should record audit log for expired user');
    assert.equal(auditLogs[0].params[0], 105, 'Audit log user_id must match');
    assert.match(auditLogs[0].sql, /'expire'/, 'Audit action must be expire');
  });
});

