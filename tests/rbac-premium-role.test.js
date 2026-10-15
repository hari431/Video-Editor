import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, getUserRole } from '../src/auth/admin.js';
import { hasAdFreeCapability, isAdVisibleForUser } from '../src/library/ad-visibility.js';
import { grantPremium, revokePremium } from '../src/auth/users.js';
import { pool } from '../src/db/pool.js';

test('PREMIUM user role tests', async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  let userDatabase = {
    10: { id: 10, email: 'owner@example.com', app_role: 'OWNER', status: 'active' },
    11: { id: 11, email: 'admin@example.com', app_role: 'ADMIN', status: 'active' },
    12: { id: 12, email: 'user@example.com', app_role: 'USER', status: 'active' },
    13: { id: 13, email: 'premium@example.com', app_role: 'PREMIUM', status: 'active' }
  };

  let mockQueries = [];

  const mockClient = {
    query: async (sql, params = []) => {
      mockQueries.push({ sql, params });
      if (sql.includes('UPDATE users')) {
        const targetId = params[0];
        const nextRole = sql.includes('PREMIUM') ? 'PREMIUM' : 'USER';
        if (userDatabase[targetId]) {
          userDatabase[targetId].app_role = nextRole;
        }
        return {
          rows: [userDatabase[targetId]],
          rowCount: 1
        };
      }
      if (sql.includes('INSERT INTO role_audit_log')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };

  test.beforeEach(() => {
    mockQueries = [];
    userDatabase = {
      10: { id: 10, email: 'owner@example.com', app_role: 'OWNER', status: 'active' },
      11: { id: 11, email: 'admin@example.com', app_role: 'ADMIN', status: 'active' },
      12: { id: 12, email: 'user@example.com', app_role: 'USER', status: 'active' },
      13: { id: 13, email: 'premium@example.com', app_role: 'PREMIUM', status: 'active' }
    };
    pool.query = async (sql, params = []) => {
      if (sql.includes('users WHERE id =')) {
        const u = userDatabase[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    pool.connect = async () => {
      return mockClient;
    };
  });

  test.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  await t.test('1. Verify PREMIUM role exists in ROLES and is recognized by getUserRole', async () => {
    assert.equal(ROLES.PREMIUM, 'PREMIUM');
    const u = { app_role: 'PREMIUM' };
    assert.equal(getUserRole(u), 'PREMIUM');
  });

  await t.test('2. Verify hasAdFreeCapability returns true for PREMIUM users', async () => {
    const premiumUser = { app_role: 'PREMIUM' };
    assert.equal(hasAdFreeCapability(premiumUser), true);

    const normalUser = { app_role: 'USER' };
    assert.equal(hasAdFreeCapability(normalUser), false);
  });

  await t.test('3. Verify isAdVisibleForUser returns false for PREMIUM users', async () => {
    const premiumUser = { id: 13, app_role: 'PREMIUM' };
    // Ads should not be shown on any safe content path
    const visible = isAdVisibleForUser(premiumUser, 'home', () => true);
    assert.equal(visible, false);
  });

  await t.test('4. Verify grantPremium works and inserts into role_audit_log', async () => {
    // Admin (11) grants premium to User (12)
    const result = await grantPremium(11, 12);
    assert.equal(result.app_role, 'PREMIUM');
    assert.equal(userDatabase[12].app_role, 'PREMIUM');

    // Verify audit log insert was called
    const auditInsert = mockQueries.find(q => q.sql.includes('INSERT INTO role_audit_log'));
    assert.ok(auditInsert);
    assert.deepEqual(auditInsert.params, [12, 11, 'USER', 'PREMIUM', 'grant_premium']);
  });

  await t.test('5. Verify revokePremium works and inserts into role_audit_log', async () => {
    // Owner (10) revokes premium from Premium (13)
    const result = await revokePremium(10, 13);
    assert.equal(result.app_role, 'USER');
    assert.equal(userDatabase[13].app_role, 'USER');

    // Verify audit log insert was called
    const auditInsert = mockQueries.find(q => q.sql.includes('INSERT INTO role_audit_log'));
    assert.ok(auditInsert);
    assert.deepEqual(auditInsert.params, [13, 10, 'PREMIUM', 'USER', 'revoke_premium']);
  });

  await t.test('6. Verify non-admins cannot grant or revoke premium', async () => {
    // Normal user (12) tries to grant premium to user (13)
    await assert.rejects(
      async () => {
        await grantPremium(12, 13);
      },
      /Only administrators can manage premium status/
    );

    // Normal user (12) tries to revoke premium from user (13)
    await assert.rejects(
      async () => {
        await revokePremium(12, 13);
      },
      /Only administrators can manage premium status/
    );
  });

  await t.test('7. Verify validations on grantPremium/revokePremium', async () => {
    // Cannot make an Admin Premium
    await assert.rejects(
      async () => {
        await grantPremium(10, 11);
      },
      /Administrator roles cannot be changed/
    );

    // Cannot make an Owner Premium
    await assert.rejects(
      async () => {
        await grantPremium(11, 10);
      },
      /Administrator roles cannot be changed/
    );

    // Cannot grant premium to an already premium user
    await assert.rejects(
      async () => {
        await grantPremium(11, 13);
      },
      /User is already Premium/
    );

    // Cannot revoke premium from a non-premium user
    await assert.rejects(
      async () => {
        await revokePremium(11, 12);
      },
      /User is not Premium/
    );
  });
});
