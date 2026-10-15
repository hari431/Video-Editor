import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasValidPremiumEntitlement,
  syncUserPremiumRole
} from '../src/auth/premium.js';
import {
  validateUserEntitlement,
  syncProductRbacRole
} from '../src/auth/paidProducts.js';

test('Reconciliation Decision Logic: validateUserEntitlement unit tests', async (t) => {
  await t.test('User with active grant in user_product_grants HAS entitlement', async () => {
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products') && (sql.includes('code = $1') || sql.includes('id = $1'))) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [{ id: 1, user_id: 10, product_id: 100, status: 'active', valid_until: new Date(Date.now() + 86400000) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const res = await validateUserEntitlement(10, 'PREMIUM', mockClient);
    assert.equal(res.hasEntitlement, true);
  });

  await t.test('Standard approved user (Hari Chandana) with NO grants/subs and future access_expires_at has NO entitlement', async () => {
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products') && (sql.includes('code = $1') || sql.includes('id = $1'))) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [{ id: 10, email: 'harichandana@example.com', access_expires_at: new Date(Date.now() + 30 * 86400000), premium_source: null }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const res = await validateUserEntitlement(10, 'PREMIUM', mockClient);
    assert.equal(res.hasEntitlement, false, 'Standard user with future base access date MUST NOT have Premium entitlement');
  });

  await t.test('User with ONLY expired grants in user_product_grants has NO entitlement', async () => {
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products') && (sql.includes('code = $1') || sql.includes('id = $1'))) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [{ id: 11, email: 'expired@example.com', access_expires_at: new Date(Date.now() - 86400000), premium_source: null }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const res = await validateUserEntitlement(11, 'PREMIUM', mockClient);
    assert.equal(res.hasEntitlement, false, 'User with expired grant has NO entitlement');
  });

  await t.test('Legacy one_time premium source with future access_expires_at has entitlement', async () => {
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products') && (sql.includes('code = $1') || sql.includes('id = $1'))) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [{ id: 12, email: 'legacy@example.com', access_expires_at: new Date(Date.now() + 10 * 86400000), premium_source: 'one_time' }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const res = await validateUserEntitlement(12, 'PREMIUM', mockClient);
    assert.equal(res.hasEntitlement, true, 'Legacy one_time with future expiry has entitlement');
  });
});

test('Reconciliation Decision Logic: hasValidPremiumEntitlement unit tests', async (t) => {
  await t.test('Hari Chandana state (null premium_source, future access_expires_at, hasActiveSub=false)', () => {
    const user = { id: 10, email: 'harichandana@example.com', premium_source: null, access_expires_at: new Date(Date.now() + 30 * 86400000) };
    assert.equal(hasValidPremiumEntitlement(user, false), false, 'Base account access MUST NOT grant Premium entitlement');
  });

  await t.test('User with active subscription but NO grant row (hasActiveSub=true, hasProductGrants=false)', () => {
    const user = { id: 11, email: 'active@example.com', premium_source: 'subscription', access_expires_at: null };
    assert.equal(hasValidPremiumEntitlement(user, true, false), false, 'Active sub alone without grant row must NOT grant entitlement');
  });

  await t.test('User with expired subscription (hasActiveSub=false)', () => {
    const user = { id: 12, email: 'sub_expired@example.com', premium_source: 'subscription', access_expires_at: null };
    assert.equal(hasValidPremiumEntitlement(user, false), false);
  });

  await t.test('User with manual source (premium_source=manual, hasActiveSub=false)', () => {
    const user = { id: 13, email: 'manual@example.com', premium_source: 'manual', access_expires_at: new Date(Date.now() + 10 * 86400000) };
    assert.equal(hasValidPremiumEntitlement(user, false), false, 'Manual role source is not a payment entitlement');
  });

  await t.test('Legacy one_time with future expiry', () => {
    const user = { id: 14, email: 'onetime@example.com', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 5 * 86400000) };
    assert.equal(hasValidPremiumEntitlement(user, false), true);
  });

  await t.test('Legacy one_time with past expiry', () => {
    const user = { id: 15, email: 'onetime_exp@example.com', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) };
    assert.equal(hasValidPremiumEntitlement(user, false), false);
  });
});

test('Reconciliation Decision Logic: All 5 State Requirements', async (t) => {
  await t.test('Requirement 1: Active entitlement + missing payment-system role -> ADD role', async () => {
    let insertedRole = null;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'JAVA_PRO', role_id: 10, is_enabled: true }], rowCount: 1 };
        }
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 101, app_role: 'USER' }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [{ id: 1, user_id: 101, product_id: 100, status: 'active', valid_until: new Date(Date.now() + 86400000) }], rowCount: 1 };
        }
        if (sql.includes('FROM user_roles WHERE user_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO user_roles')) {
          insertedRole = { userId: params[0], roleId: params[1], source: 'payment_system' };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncProductRbacRole(101, 100, mockClient);
    assert.equal(res.action, 'granted');
    assert.notEqual(insertedRole, null);
    assert.equal(insertedRole.source, 'payment_system');
  });

  await t.test('Requirement 2: No active entitlement + existing payment-system role -> REMOVE role', async () => {
    let deletedRole = false;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'JAVA_PRO', role_id: 10, is_enabled: true }], rowCount: 1 };
        }
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 102, app_role: 'USER' }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('DELETE FROM user_roles')) {
          deletedRole = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM user_roles')) {
          return { rows: [{ user_id: 102, role_id: 10, assignment_source: 'payment_system' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncProductRbacRole(102, 100, mockClient);
    assert.equal(res.action, 'revoked');
    assert.equal(deletedRole, true);
  });

  await t.test('Requirement 3a: No active entitlement + no payment-system role (Hari Chandana case: NO Premium history) -> DO NOTHING', async () => {
    let updatedUser = false;
    let insertedRole = false;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 103, email: 'harichandana@example.com', app_role: 'USER', premium_source: null, access_expires_at: new Date(Date.now() + 30 * 86400000) }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions') || sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_roles WHERE user_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('UPDATE users')) {
          updatedUser = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO user_roles')) {
          insertedRole = true;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncUserPremiumRole(103, mockClient);
    assert.equal(res.action, 'no_change');
    assert.equal(updatedUser, false, 'User MUST NOT be updated to PREMIUM');
    assert.equal(insertedRole, false, 'User_roles MUST NOT be inserted');
  });

  await t.test('Requirement 3b: User with ONLY expired Premium history and app_role=USER -> DO NOTHING', async () => {
    let updatedUser = false;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 104, email: 'expired_hist@example.com', app_role: 'USER', premium_source: null, access_expires_at: new Date(Date.now() - 86400000) }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions') || sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_roles')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('UPDATE users')) {
          updatedUser = true;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncUserPremiumRole(104, mockClient);
    assert.equal(res.action, 'no_change');
    assert.equal(updatedUser, false, 'Expired history MUST NOT grant Premium role');
  });

  await t.test('Requirement 4: Expired/historical grants, subscriptions, legacy Premium records, app_role MUST NEVER cause new role to be granted', async () => {
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 105, email: 'legacy_rec@example.com', app_role: 'USER', premium_source: 'subscription', access_expires_at: null }], rowCount: 1 };
        }
        if (sql.includes('FROM premium_subscriptions') || sql.includes('FROM paid_subscriptions') || sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'PREMIUM', role_id: 2 }], rowCount: 1 };
        }
        if (sql.includes('FROM user_roles')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncUserPremiumRole(105, mockClient);
    assert.equal(res.action, 'no_change');
  });

  await t.test('Requirement 5: Manual roles MUST remain protected', async () => {
    let deletedRole = false;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('FROM paid_products')) {
          return { rows: [{ id: 100, code: 'JAVA_PRO', role_id: 10, is_enabled: true }], rowCount: 1 };
        }
        if (sql.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: 106, app_role: 'USER' }], rowCount: 1 };
        }
        if (sql.includes('FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM user_roles WHERE user_id = $1')) {
          return { rows: [{ user_id: 106, role_id: 10, assignment_source: 'manual' }], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM user_roles')) {
          deletedRole = true;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res = await syncProductRbacRole(106, 100, mockClient);
    assert.equal(res.action, 'preserved_manual');
    assert.equal(deletedRole, false, 'Manual role assignment MUST NOT be deleted by reconciliation');
  });
});
