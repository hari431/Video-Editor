import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../src/auth/admin.js';
import {
  getProductByCode,
  validateUserEntitlement,
  syncProductRbacRole,
  recordOneTimePremiumPayment,
  recordRecurringPremiumSubscriptionEvent
} from '../src/auth/paidProducts.js';
import {
  hasValidPremiumEntitlement,
  syncUserPremiumRole,
  reconcileAllPremiumRoles
} from '../src/auth/premium.js';
import { reconcileExpiredUserStatuses } from '../src/auth/users.js';

function createLifecycleMockDb(initialState = {}) {
  const users = [
    {
      id: 101,
      email: 'user3045@example.com',
      app_role: ROLES.USER,
      status: 'active',
      premium_source: null,
      access_expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...(initialState.user || {})
    }
  ];

  const roles = [
    { id: 1, name: 'USER', description: 'Standard user' },
    { id: 2, name: 'PREMIUM', description: 'Built-in Premium role' },
    { id: 3, name: 'ADMIN', description: 'Admin role' },
    { id: 4, name: 'OWNER', description: 'Owner role' }
  ];

  const user_roles = [...(initialState.user_roles || [])];
  const paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_active: true }
  ];
  const paid_plans = [
    { id: 201, product_id: 100, code: 'one_time', name: 'One-Time 30 Days', duration_days: 30, billing_interval: 'one_time', price_paise: 30000, is_active: true }
  ];

  const paid_orders = [...(initialState.paid_orders || [])];
  const paid_subscriptions = [...(initialState.paid_subscriptions || [])];
  const premium_subscriptions = [...(initialState.premium_subscriptions || [])];
  const user_product_grants = [...(initialState.user_product_grants || [])];
  const access_audit_log = [];

  let nextOrderId = 1;
  let nextGrantId = 1;

  const mockClient = {
    query: async (sql, params = []) => {
      // 1. Roles
      if (/FROM roles WHERE name =/i.test(sql)) {
        const r = roles.find(x => x.name === params[0]);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/FROM roles WHERE id =/i.test(sql)) {
        const r = roles.find(x => x.id === Number(params[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }

      // 2. Paid Products
      if (/FROM paid_products p/i.test(sql) && /WHERE p\.code =/i.test(sql)) {
        const p = paid_products.find(x => x.code === params[0] || x.code.toLowerCase() === params[0]?.toLowerCase());
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM paid_products p/i.test(sql) && /WHERE p\.id =/i.test(sql)) {
        const p = paid_products.find(x => x.id === Number(params[0]));
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 3. Paid Plans
      if (/FROM paid_plans WHERE product_id = \$1 AND code = \$2/i.test(sql)) {
        const pl = paid_plans.find(x => x.product_id === Number(params[0]) && x.code === params[1]);
        return { rows: pl ? [pl] : [], rowCount: pl ? 1 : 0 };
      }

      // 4. Users
      if (/SELECT access_expires_at, premium_source FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [{ access_expires_at: u.access_expires_at, premium_source: u.premium_source }] : [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT access_expires_at FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [{ access_expires_at: u.access_expires_at }] : [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT id, email, app_role, premium_source, access_expires_at FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT id, email, app_role, premium_source, access_expires_at FROM users/i.test(sql)) {
        return { rows: users, rowCount: users.length };
      }
      if (/FROM users WHERE id = \$1/i.test(sql) && !/UPDATE/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users\s+SET\s+app_role\s*=\s*'PREMIUM'/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        if (u) {
          u.app_role = ROLES.PREMIUM;
          u.premium_source = sql.includes("'subscription'") ? 'subscription' : 'one_time';
          u.updated_at = new Date();
        }
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users\s+SET\s+app_role\s*=\s*'USER'/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        if (u) {
          u.app_role = ROLES.USER;
          u.premium_source = null;
          u.updated_at = new Date();
        }
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users\s+SET app_role = \$1, premium_source = \$2/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[2]));
        if (u) {
          u.app_role = params[0];
          u.premium_source = params[1];
          u.updated_at = new Date();
        }
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users\s+SET premium_source = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[1]));
        if (u) {
          u.premium_source = params[0];
          u.updated_at = new Date();
        }
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
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

      // 5. User Roles
      if (/SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = \$1 AND role_id = \$2/i.test(sql)) {
        const ur = user_roles.find(x => x.user_id === Number(params[0]) && x.role_id === Number(params[1]));
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }
      if (/SELECT 1 FROM user_roles WHERE user_id = \$1 AND role_id = \$2/i.test(sql)) {
        const ur = user_roles.find(x => x.user_id === Number(params[0]) && x.role_id === Number(params[1]));
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }
      if (/INSERT INTO user_roles/i.test(sql)) {
        const ur = { user_id: Number(params[0]), role_id: Number(params[1]), assignment_source: params[2] || 'payment_system' };
        user_roles.push(ur);
        return { rows: [ur], rowCount: 1 };
      }
      if (/DELETE FROM user_roles WHERE user_id = \$1 AND role_id = \$2 AND assignment_source = \$3/i.test(sql)) {
        const idx = user_roles.findIndex(x => x.user_id === Number(params[0]) && x.role_id === Number(params[1]) && x.assignment_source === params[2]);
        if (idx >= 0) {
          user_roles.splice(idx, 1);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 6. Paid Orders
      if (/SELECT \* FROM paid_orders WHERE provider = 'razorpay' AND provider_order_id = \$1/i.test(sql)) {
        const ord = paid_orders.find(x => x.provider === 'razorpay' && x.provider_order_id === params[0]);
        return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
      }
      if (/INSERT INTO paid_orders/i.test(sql)) {
        const ord = {
          id: nextOrderId++,
          user_id: Number(params[0]),
          product_id: Number(params[1]),
          plan_id: params[2] ? Number(params[2]) : null,
          amount_paise: Number(params[3]),
          currency: params[4],
          status: 'paid',
          provider: 'razorpay',
          provider_order_id: params[5],
          provider_payment_id: params[6],
          promo_code: params[7] || null,
          discount_paise: params[8] || 0,
          metadata: typeof params[9] === 'string' ? JSON.parse(params[9]) : (params[9] || {}),
          created_at: new Date(),
          updated_at: new Date()
        };
        paid_orders.push(ord);
        return { rows: [ord], rowCount: 1 };
      }

      // 7. Subscriptions
      if (/FROM\s+premium_subscriptions[\s\S]+WHERE\s+user_id\s*=\s*\$1/i.test(sql)) {
        const sub = premium_subscriptions.find(s =>
          s.user_id === Number(params[0]) &&
          ['active', 'authenticated'].includes(s.status) &&
          (s.current_period_end == null || new Date(s.current_period_end) > new Date())
        );
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }
      if (/FROM\s+paid_subscriptions[\s\S]+WHERE\s+user_id\s*=\s*\$1/i.test(sql)) {
        const sub = paid_subscriptions.find(s =>
          s.user_id === Number(params[0]) &&
          ['active', 'authenticated'].includes(s.status) &&
          (s.current_period_end == null || new Date(s.current_period_end) > new Date())
        );
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }

      // 8. User Product Grants
      if (/SELECT MAX\(g\.valid_until\) as max_until FROM user_product_grants/i.test(sql)) {
        const activeGrants = user_product_grants.filter(g =>
          g.user_id === Number(params[0]) &&
          g.status === 'active' &&
          (g.valid_until == null || new Date(g.valid_until) > new Date())
        );
        if (activeGrants.length === 0) {
          return { rows: [{ max_until: null }], rowCount: 1 };
        }
        const max = new Date(Math.max(...activeGrants.map(g => new Date(g.valid_until).getTime())));
        return { rows: [{ max_until: max }], rowCount: 1 };
      }
      if (/SELECT 1 FROM user_product_grants WHERE user_id = \$1 AND product_id = \$2/i.test(sql)) {
        const hasAny = user_product_grants.some(g => g.user_id === Number(params[0]) && g.product_id === Number(params[1]));
        return { rows: hasAny ? [{ '?column?': 1 }] : [], rowCount: hasAny ? 1 : 0 };
      }
      if (/SELECT g\.id FROM user_product_grants g/i.test(sql)) {
        const checkActive = /g\.status = 'active'/i.test(sql);
        const checkValidUntil = /g\.valid_until > NOW\(\)/i.test(sql);
        const matches = user_product_grants.filter(g => {
          if (g.user_id !== Number(params[0])) return false;
          if (checkActive && g.status !== 'active') return false;
          if (checkValidUntil && g.valid_until && new Date(g.valid_until) <= new Date()) return false;
          return true;
        });
        return { rows: matches.map(m => ({ id: m.id })), rowCount: matches.length };
      }
      if (/SELECT \* FROM user_product_grants/i.test(sql)) {
        if (sql.includes('WHERE (order_id = $1 OR')) {
          const ordId = Number(params[0]);
          const payId = params[1];
          const prodId = Number(params[2]);
          const g = user_product_grants.find(x =>
            (x.order_id === ordId || x.metadata?.provider_payment_id === payId) &&
            x.product_id === prodId
          );
          return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
        }
        // getActiveGrants query
        if (sql.includes("status = 'active'") && sql.includes('valid_until > NOW()')) {
          const uId = Number(params[0]);
          const pId = Number(params[1]);
          const active = user_product_grants.filter(g =>
            g.user_id === uId &&
            g.product_id === pId &&
            g.status === 'active' &&
            (g.valid_until == null || new Date(g.valid_until) > new Date())
          );
          return { rows: active, rowCount: active.length };
        }
      }
      if (/INSERT INTO user_product_grants/i.test(sql)) {
        const g = {
          id: nextGrantId++,
          user_id: Number(params[0]),
          product_id: Number(params[1]),
          plan_id: params[2] ? Number(params[2]) : null,
          grant_type: 'one_time_purchase',
          status: 'active',
          valid_from: new Date(),
          valid_until: params[3] ? new Date(params[3]) : null,
          order_id: params[4] ? Number(params[4]) : null,
          grant_reason: 'Verified one-time Premium payment',
          metadata: typeof params[5] === 'string' ? JSON.parse(params[5]) : (params[5] || {}),
          created_at: new Date(),
          updated_at: new Date()
        };
        user_product_grants.push(g);
        return { rows: [g], rowCount: 1 };
      }

      // Audit logs & events
      if (/INSERT INTO role_audit_log/i.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        access_audit_log.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO paid_product_events/i.test(sql)) {
        return { rowCount: 1, rows: [] };
      }

      return { rows: [], rowCount: 0 };
    }
  };

  return {
    users,
    roles,
    user_roles,
    paid_products,
    paid_plans,
    paid_orders,
    paid_subscriptions,
    premium_subscriptions,
    user_product_grants,
    access_audit_log,
    mockClient
  };
}

test('Premium 30+45 Day Lifecycle Suite', async (t) => {
  await t.test('1. 15-day base + 30-day Premium => 30-day grant / 45-day base expiry', async () => {
    const now = Date.now();
    const fifteenDaysMs = 15 * 24 * 3600 * 1000;
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    const initialBaseExpiry = new Date(now + fifteenDaysMs);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.USER,
        status: 'active',
        access_expires_at: initialBaseExpiry
      }
    });

    // Step 1: In /api/premium/verify-one-time-payment, the base account is extended by 30 days
    const currentBase = new Date(db.users[0].access_expires_at);
    const extendedBase = new Date(currentBase.getTime() + thirtyDaysMs);
    db.users[0].access_expires_at = extendedBase;

    // Step 2: In verify-one-time-payment, grant valid_until is calculated strictly from the Premium duration (30 days)
    const grantValidUntil = new Date(now + thirtyDaysMs);

    await recordOneTimePremiumPayment({
      userId: 101,
      orderId: 'order_12345',
      paymentId: 'pay_12345',
      amountPaise: 30000,
      currency: 'INR',
      promoCode: null,
      discountPaise: 0,
      validUntil: grantValidUntil,
      metadata: { source: 'test' }
    }, db.mockClient);

    // Sync roles immediately upon purchase
    await syncUserPremiumRole(101, db.mockClient);
    await syncProductRbacRole(101, 100, db.mockClient);

    // Verifications at Day 0:
    // 1. Grant valid_until must be 30 days from now (NOT 45 days)
    assert.equal(db.user_product_grants.length, 1);
    const grantExpiry = new Date(db.user_product_grants[0].valid_until).getTime();
    assert.ok(Math.abs(grantExpiry - (now + thirtyDaysMs)) < 5000, 'Grant valid_until should be ~30 days');

    // 2. Base account access_expires_at must be ~45 days from now
    const userBaseExpiry = new Date(db.users[0].access_expires_at).getTime();
    assert.ok(Math.abs(userBaseExpiry - (now + 45 * 24 * 3600 * 1000)) < 5000, 'User base access_expires_at should be ~45 days');

    // 3. User is active with PREMIUM role
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
    assert.equal(db.users[0].status, 'active');
    assert.ok(db.user_roles.some(r => r.user_id === 101 && r.role_id === 2 && r.assignment_source === 'payment_system'));
  });

  await t.test('2. Day 30: Premium role/access revoked while base account remains active', async () => {
    const now = Date.now();
    // Simulate Day 31:
    // Grant valid_until was 1 day ago (expired)
    // Base access_expires_at is still 14 days in the future!
    const pastGrantExpiry = new Date(now - 1 * 24 * 3600 * 1000);
    const remainingBaseExpiry = new Date(now + 14 * 24 * 3600 * 1000);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.PREMIUM,
        premium_source: 'one_time',
        status: 'active',
        access_expires_at: remainingBaseExpiry
      },
      user_roles: [
        { user_id: 101, role_id: 2, assignment_source: 'payment_system' }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 101,
          product_id: 100,
          plan_id: 201,
          grant_type: 'one_time_purchase',
          status: 'active',
          valid_from: new Date(now - 31 * 24 * 3600 * 1000),
          valid_until: pastGrantExpiry,
          order_id: 1,
          metadata: {}
        }
      ]
    });

    // Run reconciliation / sync
    const syncRes = await syncUserPremiumRole(101, db.mockClient);
    const rbacRes = await syncProductRbacRole(101, 100, db.mockClient);

    // Verification on Day 30+:
    // 1. Premium role is revoked from users table
    assert.equal(syncRes.action, 'revoked');
    assert.equal(db.users[0].app_role, ROLES.USER, 'App role must be reverted to USER');
    assert.equal(db.users[0].premium_source, null, 'premium_source must be cleared');

    // 2. Premium RBAC role is revoked from user_roles
    assert.equal(syncRes.rbac?.rbacAction, 'revoked');
    assert.equal(db.user_roles.filter(r => r.user_id === 101 && r.role_id === 2).length, 0, 'PREMIUM role must be removed from user_roles');

    // 3. CRITICAL: Base account remains ACTIVE with its remaining 14 days!
    assert.equal(db.users[0].status, 'active', 'Base account must remain active');
    assert.equal(db.users[0].access_expires_at, remainingBaseExpiry, 'Base access_expires_at must not be modified');
  });

  await t.test('3. Day 45: Base account expires', async () => {
    const now = Date.now();
    // Simulate Day 46:
    // Base access_expires_at was 1 day ago
    const expiredBase = new Date(now - 1 * 24 * 3600 * 1000);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.USER,
        status: 'active',
        access_expires_at: expiredBase
      }
    });

    // Run user base account expiry reconciliation
    const result = await reconcileExpiredUserStatuses({ client: db.mockClient, dryRun: false });

    // Verification:
    assert.equal(result.usersExpired, 1, 'Base user must be expired');
    assert.equal(db.users[0].status, 'expired', 'User status must now be expired');
  });

  await t.test('4. Expired grant cannot fall back to base expiry', async () => {
    const now = Date.now();
    const pastDate = new Date(now - 2 * 24 * 3600 * 1000);
    const futureBaseExpiry = new Date(now + 20 * 24 * 3600 * 1000);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.PREMIUM,
        premium_source: 'one_time',
        status: 'active',
        access_expires_at: futureBaseExpiry
      },
      user_product_grants: [
        {
          id: 1,
          user_id: 101,
          product_id: 100,
          status: 'active',
          valid_until: pastDate
        }
      ]
    });

    // validateUserEntitlement must report NO entitlement despite future access_expires_at
    const entitlement = await validateUserEntitlement(101, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, false, 'Expired grant must not fall back to access_expires_at');

    // hasValidPremiumEntitlement with hasProductGrants=true must also return false
    const valid = hasValidPremiumEntitlement(db.users[0], false, true);
    assert.equal(valid, false, 'hasValidPremiumEntitlement must return false when product grants exist and are expired');
  });

  await t.test('5. Manual Premium remains protected from revocation', async () => {
    const now = Date.now();
    const pastDate = new Date(now - 5 * 24 * 3600 * 1000);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.PREMIUM,
        premium_source: 'manual',
        status: 'active',
        access_expires_at: null
      },
      user_roles: [
        { user_id: 101, role_id: 2, assignment_source: 'manual' }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 101,
          product_id: 100,
          status: 'active',
          valid_until: pastDate
        }
      ]
    });

    const syncRes = await syncUserPremiumRole(101, db.mockClient);
    const rbacRes = await syncProductRbacRole(101, 100, db.mockClient);

    assert.equal(syncRes.action, 'preserved_manual', 'Manual app_role must be preserved');
    assert.equal(rbacRes.action, 'preserved_manual', 'Manual RBAC role must be preserved');
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
    assert.equal(db.user_roles.length, 1);
    assert.equal(db.user_roles[0].assignment_source, 'manual');
  });

  await t.test('6. Recurring Premium unaffected', async () => {
    const now = Date.now();
    const futurePeriodEnd = new Date(now + 28 * 24 * 3600 * 1000);

    const db = createLifecycleMockDb({
      user: {
        id: 101,
        app_role: ROLES.PREMIUM,
        premium_source: 'subscription',
        status: 'active',
        access_expires_at: null
      },
      paid_subscriptions: [
        {
          id: 1,
          user_id: 101,
          product_id: 100,
          status: 'active',
          current_period_end: futurePeriodEnd
        }
      ]
    });

    const entitlement = await validateUserEntitlement(101, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, true, 'Active subscription must provide entitlement');
    assert.equal(entitlement.primaryGrantType, 'subscription_cycle');

    const syncRes = await syncUserPremiumRole(101, db.mockClient);
    assert.equal(syncRes.action, 'no_change');
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
  });

  await t.test('7. Existing legacy Premium users remain compatible', async () => {
    const now = Date.now();
    const futureDate = new Date(now + 10 * 24 * 3600 * 1000);
    const pastDate = new Date(now - 10 * 24 * 3600 * 1000);

    // Active legacy user: no user_product_grants, but premium_source='one_time' and future access_expires_at
    const activeLegacyDb = createLifecycleMockDb({
      user: {
        id: 102,
        app_role: ROLES.PREMIUM,
        premium_source: 'one_time',
        status: 'active',
        access_expires_at: futureDate
      }
    });

    const activeLegacyEntitlement = await validateUserEntitlement(102, 'PREMIUM', activeLegacyDb.mockClient);
    assert.equal(activeLegacyEntitlement.hasEntitlement, true, 'Active legacy user should have entitlement');
    assert.equal(hasValidPremiumEntitlement(activeLegacyDb.users[0], false, false), true);

    // Expired legacy user: no user_product_grants, premium_source='one_time', past access_expires_at
    const expiredLegacyDb = createLifecycleMockDb({
      user: {
        id: 103,
        app_role: ROLES.USER,
        premium_source: 'one_time',
        status: 'active',
        access_expires_at: pastDate
      }
    });

    const expiredLegacyEntitlement = await validateUserEntitlement(103, 'PREMIUM', expiredLegacyDb.mockClient);
    assert.equal(expiredLegacyEntitlement.hasEntitlement, false, 'Expired legacy user must not have entitlement');
    assert.equal(hasValidPremiumEntitlement(expiredLegacyDb.users[0], false, false), false);
  });
});
