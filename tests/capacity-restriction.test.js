import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPaidProduct,
  updatePaidProduct,
  countUniqueActiveProductMembers,
  isUserActiveMemberOfProduct,
  verifyAndEnforceCapacity,
  createUserProductGrant
} from '../src/auth/paidProducts.js';

test('Paid Products Offering Capacity Restriction Suite', async (t) => {
  // In-memory mock database state
  let roles = [
    { id: 2, name: 'PREMIUM', description: 'Built-in Premium' },
    { id: 3, name: 'PRO_ANALYTICS', description: 'Analytics Suite' }
  ];

  let paid_products = [
    { id: 1, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_enabled: true, max_active_members: 2 },
    { id: 2, code: 'ANALYTICS', name: 'Analytics Suite', role_id: 3, is_enabled: true, max_active_members: null }
  ];

  let user_product_grants = [];
  let users = [
    { id: 101, email: 'user1@example.com', app_role: 'USER' },
    { id: 102, email: 'user2@example.com', app_role: 'USER' },
    { id: 103, email: 'user3@example.com', app_role: 'USER' }
  ];

  const mockClient = {
    query: async (sql, params = []) => {
      // 1. SELECT p.* FROM paid_products
      if (/FROM paid_products/i.test(sql)) {
        if (/p\.id = \$1/i.test(sql)) {
          const prodId = Number(params[0]);
          const match = paid_products.find(p => p.id === prodId);
          if (!match) return { rows: [], rowCount: 0 };
          const r = roles.find(rl => rl.id === match.role_id);
          return { rows: [{ ...match, role_name: r?.name }], rowCount: 1 };
        }
        if (/p\.code = \$1/i.test(sql)) {
          const code = String(params[0]).toUpperCase();
          const match = paid_products.find(p => p.code === code);
          if (!match) return { rows: [], rowCount: 0 };
          const r = roles.find(rl => rl.id === match.role_id);
          return { rows: [{ ...match, role_name: r?.name }], rowCount: 1 };
        }
        return { rows: paid_products, rowCount: paid_products.length };
      }

      // 2. INSERT INTO paid_products
      if (/INSERT INTO paid_products/i.test(sql)) {
        // [code, name, description, role_id, is_enabled, max_active_members]
        const code = params[0];
        const name = params[1];
        const desc = params[2];
        const role_id = params[3];
        const is_enabled = params[4];
        const max_active_members = params[5];
        const newProd = {
          id: paid_products.length + 1,
          code,
          name,
          description: desc,
          role_id,
          is_enabled,
          max_active_members,
          metadata: {}
        };
        paid_products.push(newProd);
        return { rows: [newProd], rowCount: 1 };
      }

      // 3. UPDATE paid_products
      if (/UPDATE paid_products/i.test(sql)) {
        // [name, description, role_id, is_enabled, max_active_members, productId]
        const name = params[0];
        const desc = params[1];
        const role_id = params[2];
        const is_enabled = params[3];
        const max_active_members = params[4];
        const id = Number(params[5]);
        const prod = paid_products.find(p => p.id === id);
        if (prod) {
          prod.name = name;
          prod.description = desc;
          prod.role_id = role_id;
          prod.is_enabled = is_enabled;
          prod.max_active_members = max_active_members;
        }
        return { rows: [prod], rowCount: prod ? 1 : 0 };
      }

      // 4. DISTINCT users check (active members counting)
      if (/SELECT DISTINCT user_id FROM user_product_grants/i.test(sql)) {
        const prodId = params[0];
        const now = new Date();
        const activeGrants = user_product_grants.filter(g => 
          g.product_id === prodId && 
          g.status === 'active' && 
          (g.valid_until === null || new Date(g.valid_until) > now)
        );
        const uniqueUserIds = Array.from(new Set(activeGrants.map(g => g.user_id)));
        return { rows: uniqueUserIds.map(uid => ({ user_id: uid })), rowCount: uniqueUserIds.length };
      }

      // 5. Active legacy user checks or grants checks
      if (/SELECT 1 FROM user_product_grants/i.test(sql)) {
        const userId = params[0];
        const prodId = params[1];
        const now = new Date();
        const found = user_product_grants.some(g =>
          g.user_id === userId &&
          g.product_id === prodId &&
          g.status === 'active' &&
          (g.valid_until === null || new Date(g.valid_until) > now)
        );
        return { rows: found ? [{ '1': 1 }] : [], rowCount: found ? 1 : 0 };
      }

      // 6. Legacy PREMIUM users query
      if (/SELECT id FROM users WHERE app_role = 'PREMIUM'/i.test(sql)) {
        const legacy = users.filter(u => u.app_role === 'PREMIUM');
        return { rows: legacy.map(l => ({ id: l.id })), rowCount: legacy.length };
      }

      // 7. Select app_role for specific user
      if (/SELECT app_role FROM users WHERE id = \$1/i.test(sql)) {
        const userId = params[0];
        const user = users.find(u => u.id === userId);
        return { rows: user ? [{ app_role: user.app_role }] : [], rowCount: user ? 1 : 0 };
      }

      // 8. INSERT INTO user_product_grants
      if (/INSERT INTO user_product_grants/i.test(sql)) {
        // params: [userId, productId, planId, grantType, status, validFrom, validUntil, orderId, subscriptionId, reason, metadata]
        const newGrant = {
          id: user_product_grants.length + 1,
          user_id: params[0],
          product_id: params[1],
          plan_id: params[2],
          grant_type: params[3],
          status: params[4],
          valid_from: params[5],
          valid_until: params[6],
          order_id: params[7],
          subscription_id: params[8],
          grant_reason: params[9],
          metadata: params[10],
          created_at: new Date()
        };
        user_product_grants.push(newGrant);
        return { rows: [newGrant], rowCount: 1 };
      }

      // Fallback
      return { rows: [], rowCount: 0 };
    }
  };

  await t.test('Configure capacity limit on a product (setting & removing it)', async () => {
    // 1. Create product with limit = 5
    const prod1 = await createPaidProduct({
      code: 'CAP_PROD',
      name: 'Capacity Product',
      role_id: 3,
      is_enabled: true,
      max_active_members: 5
    }, mockClient);

    assert.equal(prod1.max_active_members, 5, 'Should correctly set max_active_members to 5');

    // 2. Update to remove limit (unlimited)
    const updated = await updatePaidProduct(prod1.id, {
      name: 'Capacity Product Updated',
      role_id: 3,
      is_enabled: true,
      max_active_members: null
    }, mockClient);

    assert.equal(updated.max_active_members, null, 'Should support removing the capacity limit');
  });

  await t.test('Correct counting of active unique members (excluding expired/inactive, and multi-plan as 1)', async () => {
    // Reset state
    user_product_grants = [];
    users = [
      { id: 101, email: 'u1@example.com', app_role: 'USER' },
      { id: 102, email: 'u2@example.com', app_role: 'USER' },
      { id: 103, email: 'u3@example.com', app_role: 'USER' }
    ];

    // User 101 has active grant
    user_product_grants.push({
      user_id: 101,
      product_id: 1,
      status: 'active',
      valid_until: null
    });

    // User 102 has multiple active grants (e.g. multi-plan) - should count as 1 member
    user_product_grants.push({
      user_id: 102,
      product_id: 1,
      status: 'active',
      valid_until: null
    });
    user_product_grants.push({
      user_id: 102,
      product_id: 1,
      status: 'active',
      valid_until: new Date(Date.now() + 100000)
    });

    // User 103 has expired grant - should NOT consume capacity
    user_product_grants.push({
      user_id: 103,
      product_id: 1,
      status: 'active',
      valid_until: new Date(Date.now() - 10000)
    });

    // Count unique active members
    const count = await countUniqueActiveProductMembers(1, mockClient);
    assert.equal(count, 2, 'Should count exactly 2 unique active members (101 and 102)');
  });

  await t.test('Blocking new grants when at capacity', async () => {
    // Set limit of product id 1 to 2
    const prod = paid_products.find(p => p.id === 1);
    prod.max_active_members = 2;

    // Reset grants: 2 active users already consume all capacity (101 and 102)
    user_product_grants = [
      { user_id: 101, product_id: 1, status: 'active', valid_until: null },
      { user_id: 102, product_id: 1, status: 'active', valid_until: null }
    ];

    // 1. Attempting to add a new user (103) should be blocked by verifyAndEnforceCapacity
    await assert.rejects(
      async () => {
        await verifyAndEnforceCapacity(103, 1, mockClient);
      },
      /at capacity/i,
      'Should block new user from obtaining a grant when at capacity'
    );

    // 2. Confirming that createUserProductGrant also blocks
    await assert.rejects(
      async () => {
        await createUserProductGrant({
          userId: 103,
          productId: 1,
          grantType: 'one_time_purchase',
          status: 'active'
        }, mockClient);
      },
      /at capacity/i,
      'createUserProductGrant must automatically enforce capacity validation'
    );
  });

  await t.test('Allowing existing active members to renew/add plans when over capacity', async () => {
    // If user 101 already has an active grant, they are allowed to buy another/renew
    // even though the offering is at capacity (current count 2 / limit 2)
    await assert.doesNotReject(
      async () => {
        await verifyAndEnforceCapacity(101, 1, mockClient);
      },
      'Should NOT block existing active members from renewal check even when at capacity'
    );
  });
});
