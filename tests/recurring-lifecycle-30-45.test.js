import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../src/auth/admin.js';
import {
  getProductByCode,
  getPlanByCode,
  validateUserEntitlement,
  syncProductRbacRole,
  recordRecurringPremiumSubscriptionEvent,
  reconcilePaidProduct
} from '../src/auth/paidProducts.js';
import {
  hasValidPremiumEntitlement,
  syncUserPremiumRole,
  reconcileAllPremiumRoles
} from '../src/auth/premium.js';
import { reconcileExpiredUserStatuses } from '../src/auth/users.js';

function createRecurringMockDb(initialState = {}) {
  const users = [
    {
      id: 201,
      email: 'recurring.user@example.com',
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
    { id: 201, product_id: 100, code: 'recurring_monthly', name: 'Premium Monthly Subscription', duration_days: 30, billing_interval: 'recurring', price_paise: 30000, is_active: true },
    { id: 202, product_id: 100, code: 'monthly', name: 'Premium Monthly Subscription', duration_days: 30, billing_interval: 'recurring', price_paise: 30000, is_active: true }
  ];

  const paid_orders = [...(initialState.paid_orders || [])];
  const paid_subscriptions = [...(initialState.paid_subscriptions || [])];
  const premium_subscriptions = [...(initialState.premium_subscriptions || [])];
  const user_product_grants = [...(initialState.user_product_grants || [])];
  const access_audit_log = [];

  let nextOrderId = 1;
  let nextSubId = 1;
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
      if (/FROM paid_product_plans/i.test(sql) || /FROM paid_plans/i.test(sql)) {
        if (/WHERE product_id = \$1 AND code = \$2/i.test(sql)) {
          const pl = paid_plans.find(x => x.product_id === Number(params[0]) && x.code === params[1]);
          return { rows: pl ? [pl] : [], rowCount: pl ? 1 : 0 };
        }
        if (/WHERE id = \$1/i.test(sql)) {
          const pl = paid_plans.find(x => x.id === Number(params[0]));
          return { rows: pl ? [pl] : [], rowCount: pl ? 1 : 0 };
        }
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
      if (/SELECT DISTINCT u\.id/i.test(sql)) {
        return { rows: users.map(u => ({ id: u.id, app_role: u.app_role, email: u.email })), rowCount: users.length };
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

      // 6. Paid Subscriptions
      if (/INSERT INTO paid_subscriptions/i.test(sql)) {
        const subId = nextSubId++;
        const providerSubId = params[4];
        let existing = paid_subscriptions.find(s => s.provider_subscription_id === providerSubId);
        if (existing) {
          existing.status = params[5];
          existing.current_period_start = params[6] || existing.current_period_start;
          existing.current_period_end = params[7] || existing.current_period_end;
          existing.cancel_at_period_end = params[8];
          existing.updated_at = new Date();
          return { rows: [existing], rowCount: 1 };
        }
        const s = {
          id: subId,
          user_id: Number(params[0]),
          product_id: Number(params[1]),
          plan_id: params[2] ? Number(params[2]) : null,
          provider: 'razorpay',
          provider_customer_id: params[3] || null,
          provider_subscription_id: providerSubId,
          status: params[5],
          current_period_start: params[6],
          current_period_end: params[7],
          cancel_at_period_end: params[8],
          metadata: typeof params[9] === 'string' ? JSON.parse(params[9]) : (params[9] || {}),
          created_at: new Date(),
          updated_at: new Date()
        };
        paid_subscriptions.push(s);
        return { rows: [s], rowCount: 1 };
      }
      if (/UPDATE paid_subscriptions\s+SET status = 'expired'/i.test(sql)) {
        let count = 0;
        const now = new Date();
        for (const s of paid_subscriptions) {
          if (s.status === 'active' && s.current_period_end && new Date(s.current_period_end) <= now) {
            s.status = 'expired';
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }
      if (/FROM\s+paid_subscriptions[\s\S]+WHERE\s+user_id\s*=\s*\$1/i.test(sql)) {
        const sub = paid_subscriptions.find(s =>
          s.user_id === Number(params[0]) &&
          ['active', 'authenticated'].includes(s.status) &&
          (s.current_period_end == null || new Date(s.current_period_end) > new Date())
        );
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }

      // 7. Premium Subscriptions (legacy table)
      if (/FROM\s+premium_subscriptions[\s\S]+WHERE\s+user_id\s*=\s*\$1/i.test(sql)) {
        const sub = premium_subscriptions.find(s =>
          s.user_id === Number(params[0]) &&
          ['active', 'authenticated'].includes(s.status) &&
          (s.current_period_end == null || new Date(s.current_period_end) > new Date())
        );
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }
      if (/UPDATE premium_subscriptions\s+SET status = 'expired'/i.test(sql)) {
        let count = 0;
        const now = new Date();
        for (const s of premium_subscriptions) {
          if (['active', 'authenticated'].includes(s.status) && s.current_period_end && new Date(s.current_period_end) <= now) {
            s.status = 'expired';
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }

      // 8. Paid Orders
      if (/SELECT id FROM paid_orders WHERE provider_payment_id = \$1/i.test(sql)) {
        const ord = paid_orders.find(x => x.provider_payment_id === params[0]);
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
          created_at: new Date(),
          updated_at: new Date()
        };
        paid_orders.push(ord);
        return { rows: [ord], rowCount: 1 };
      }

      // 9. User Product Grants
      if (/SELECT id FROM user_product_grants WHERE subscription_id = \$1/i.test(sql)) {
        const subId = Number(params[0]);
        const prodId = Number(params[1]);
        const validUntil = params[2];
        const payId = params[3];
        const invId = params[4];
        const match = user_product_grants.find(g =>
          g.subscription_id === subId &&
          g.product_id === prodId &&
          (
            (g.valid_until && new Date(g.valid_until).getTime() === new Date(validUntil).getTime()) ||
            g.metadata?.provider_payment_id === payId ||
            g.metadata?.invoice_id === invId
          )
        );
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
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
      if (/SELECT \* FROM user_product_grants/i.test(sql) && sql.includes("status = 'active'") && sql.includes('valid_until > NOW()')) {
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
      if (/INSERT INTO user_product_grants/i.test(sql)) {
        const g = {
          id: nextGrantId++,
          user_id: Number(params[0]),
          product_id: Number(params[1]),
          plan_id: params[2] ? Number(params[2]) : null,
          grant_type: 'subscription_cycle',
          status: 'active',
          valid_from: params[3] ? new Date(params[3]) : new Date(),
          valid_until: params[4] ? new Date(params[4]) : null,
          subscription_id: params[5] ? Number(params[5]) : null,
          order_id: params[6] ? Number(params[6]) : null,
          grant_reason: params[7] || 'Subscription cycle',
          metadata: typeof params[8] === 'string' ? JSON.parse(params[8]) : (params[8] || {}),
          created_at: new Date(),
          updated_at: new Date()
        };
        user_product_grants.push(g);
        return { rows: [g], rowCount: 1 };
      }
      if (/UPDATE user_product_grants\s+SET status = 'expired'/i.test(sql)) {
        let count = 0;
        const now = new Date();
        for (const g of user_product_grants) {
          if (g.status === 'active' && g.valid_until && new Date(g.valid_until) <= now) {
            g.status = 'expired';
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }

      // 10. Audit logs
      if (/INSERT INTO role_audit_log/i.test(sql) || /INSERT INTO access_audit_log/i.test(sql) || /INSERT INTO paid_product_events/i.test(sql)) {
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

test('Recurring Premium 30+45 Day Lifecycle Suite', async (t) => {
  await t.test('1. Day 0: 15-day base account + 30-day recurring subscription => 30-day cycle grant / 45-day base access', async () => {
    const now = Date.now();
    const fifteenDaysMs = 15 * 24 * 3600 * 1000;
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    const initialBaseExpiry = new Date(now + fifteenDaysMs);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.USER,
        status: 'active',
        access_expires_at: initialBaseExpiry
      }
    });

    // Cycle 1: Day 0 to Day 30
    const cycle1Start = new Date(now);
    const cycle1End = new Date(now + thirtyDaysMs);

    // Initial purchase extends base access to 45 days (15 + 30 = 45 days)
    db.users[0].access_expires_at = new Date(initialBaseExpiry.getTime() + thirtyDaysMs);

    // Record initial recurring subscription cycle event
    await recordRecurringPremiumSubscriptionEvent({
      userId: 201,
      providerSubscriptionId: 'sub_rec_001',
      status: 'active',
      currentPeriodStart: cycle1Start,
      currentPeriodEnd: cycle1End,
      cancelAtPeriodEnd: false,
      paymentId: 'pay_rec_001',
      invoiceId: 'inv_rec_001',
      amountPaise: 30000,
      currency: 'INR',
      eventType: 'subscription.charged',
      metadata: { customer_id: 'cust_001' }
    }, db.mockClient);

    // Sync roles upon subscription charge
    await syncUserPremiumRole(201, db.mockClient);
    await syncProductRbacRole(201, 100, db.mockClient);

    // Verifications at Day 0:
    // 1. Cycle grant valid_until is strictly Day 30 (NOT 45 days)
    assert.equal(db.user_product_grants.length, 1);
    const grant = db.user_product_grants[0];
    assert.equal(grant.grant_type, 'subscription_cycle');
    const grantExpiry = new Date(grant.valid_until).getTime();
    assert.ok(Math.abs(grantExpiry - (now + thirtyDaysMs)) < 5000, 'Cycle grant valid_until must be ~30 days');

    // 2. Base account access_expires_at is Day 45
    const baseExpiry = new Date(db.users[0].access_expires_at).getTime();
    assert.ok(Math.abs(baseExpiry - (now + 45 * 24 * 3600 * 1000)) < 5000, 'Base access_expires_at must be ~45 days');

    // 3. User is active with PREMIUM role
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
    assert.equal(db.users[0].status, 'active');
    assert.equal(db.users[0].premium_source, 'subscription');
    assert.ok(db.user_roles.some(r => r.user_id === 201 && r.role_id === 2 && r.assignment_source === 'payment_system'));

    // 4. Entitlement check returns active with furthestExpiry = Day 30
    const entitlement = await validateUserEntitlement(201, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, true);
    assert.equal(entitlement.primaryGrantType, 'subscription_cycle');
    assert.ok(Math.abs(new Date(entitlement.furthestExpiry).getTime() - (now + thirtyDaysMs)) < 5000);
  });

  await t.test('2. Entitlement expiry is strictly independent of base access expiry', async () => {
    const now = Date.now();
    const cycleEnd = new Date(now + 20 * 24 * 3600 * 1000); // 20 days remaining
    const farFutureBase = new Date(now + 120 * 24 * 3600 * 1000); // 120 days base access

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.PREMIUM,
        premium_source: 'subscription',
        status: 'active',
        access_expires_at: farFutureBase
      },
      paid_subscriptions: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          provider_subscription_id: 'sub_rec_001',
          status: 'active',
          current_period_start: new Date(now - 10 * 24 * 3600 * 1000),
          current_period_end: cycleEnd
        }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          grant_type: 'subscription_cycle',
          status: 'active',
          valid_from: new Date(now - 10 * 24 * 3600 * 1000),
          valid_until: cycleEnd
        }
      ],
      user_roles: [
        { user_id: 201, role_id: 2, assignment_source: 'payment_system' }
      ]
    });

    const entitlement = await validateUserEntitlement(201, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, true);
    // furthestExpiry must match cycleEnd (~20 days), NEVER farFutureBase (120 days)
    assert.equal(new Date(entitlement.furthestExpiry).getTime(), cycleEnd.getTime());
    assert.notEqual(new Date(entitlement.furthestExpiry).getTime(), farFutureBase.getTime());
  });

  await t.test('3. Renewal path: successful renewal extends Premium entitlement to Day 60 and base access to Day 75', async () => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    const initialBaseExpiry = new Date(now + 15 * 24 * 3600 * 1000);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.USER,
        status: 'active',
        access_expires_at: initialBaseExpiry
      }
    });

    // Cycle 1: Day 0 -> Day 30
    const cycle1End = new Date(now + thirtyDaysMs);
    db.users[0].access_expires_at = new Date(initialBaseExpiry.getTime() + thirtyDaysMs); // Day 45

    await recordRecurringPremiumSubscriptionEvent({
      userId: 201,
      providerSubscriptionId: 'sub_rec_001',
      status: 'active',
      currentPeriodStart: new Date(now),
      currentPeriodEnd: cycle1End,
      cancelAtPeriodEnd: false,
      paymentId: 'pay_rec_001',
      invoiceId: 'inv_rec_001',
      amountPaise: 30000,
      currency: 'INR',
      eventType: 'subscription.charged'
    }, db.mockClient);

    // Now simulate Day 30 renewal: payment succeeds for Cycle 2 (Day 30 -> Day 60)
    const cycle2Start = cycle1End;
    const cycle2End = new Date(now + 60 * 24 * 3600 * 1000);
    // Base access extended by another 30 days: 45 + 30 = 75 days
    db.users[0].access_expires_at = new Date(db.users[0].access_expires_at.getTime() + thirtyDaysMs);

    await recordRecurringPremiumSubscriptionEvent({
      userId: 201,
      providerSubscriptionId: 'sub_rec_001',
      status: 'active',
      currentPeriodStart: cycle2Start,
      currentPeriodEnd: cycle2End,
      cancelAtPeriodEnd: false,
      paymentId: 'pay_rec_002',
      invoiceId: 'inv_rec_002',
      amountPaise: 30000,
      currency: 'INR',
      eventType: 'subscription.charged'
    }, db.mockClient);

    await syncUserPremiumRole(201, db.mockClient);
    await syncProductRbacRole(201, 100, db.mockClient);

    // Check grants: now 2 cycle grants
    assert.equal(db.user_product_grants.length, 2);
    // Entitlement is active until Day 60
    const entitlement = await validateUserEntitlement(201, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, true);
    assert.ok(Math.abs(new Date(entitlement.furthestExpiry).getTime() - (now + 60 * 24 * 3600 * 1000)) < 5000);

    // Base access is active until Day 75
    const baseExpiry = new Date(db.users[0].access_expires_at).getTime();
    assert.ok(Math.abs(baseExpiry - (now + 75 * 24 * 3600 * 1000)) < 5000);

    // Premium role remains active
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
    assert.ok(db.user_roles.some(r => r.user_id === 201 && r.role_id === 2));
  });

  await t.test('4. Non-renewal path: Day 31 Premium role revoked, but base account remains ACTIVE until Day 45', async () => {
    const now = Date.now();
    // Simulate Day 31:
    // Cycle 1 ended 1 day ago (Day 30 in the past)
    const cycle1Start = new Date(now - 31 * 24 * 3600 * 1000);
    const cycle1End = new Date(now - 1 * 24 * 3600 * 1000);
    // Base access still has 14 days remaining (expires on Day 45, which is in +14 days)
    const baseExpiry = new Date(now + 14 * 24 * 3600 * 1000);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.PREMIUM,
        premium_source: 'subscription',
        status: 'active',
        access_expires_at: baseExpiry
      },
      paid_subscriptions: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          provider_subscription_id: 'sub_rec_001',
          status: 'active', // not yet marked expired by scheduler
          current_period_start: cycle1Start,
          current_period_end: cycle1End
        }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          grant_type: 'subscription_cycle',
          status: 'active',
          valid_from: cycle1Start,
          valid_until: cycle1End // expired 1 day ago
        }
      ],
      user_roles: [
        { user_id: 201, role_id: 2, assignment_source: 'payment_system' }
      ]
    });

    // 1. Entitlement check MUST be false at Day 31, even though users.access_expires_at is +14 days
    const entitlement = await validateUserEntitlement(201, 'PREMIUM', db.mockClient);
    assert.equal(entitlement.hasEntitlement, false, 'Expired subscription cycle must NOT grant entitlement');
    assert.equal(hasValidPremiumEntitlement(db.users[0], false, true), false);

    // 2. Reconcile roles (what daily reconciliation or syncUserPremiumRole does)
    const syncRes = await syncUserPremiumRole(201, db.mockClient);

    assert.equal(syncRes.action, 'revoked', 'Premium app_role must be revoked');
    assert.equal(syncRes.rbac?.rbacAction, 'revoked', 'Premium RBAC role must be revoked');

    // 3. User app_role is downgraded to USER
    assert.equal(db.users[0].app_role, ROLES.USER);
    assert.equal(db.users[0].premium_source, null);

    // 4. Premium role removed from user_roles
    assert.equal(db.user_roles.some(r => r.role_id === 2), false);

    // 5. CRITICAL: Base account MUST remain active with 14 days remaining!
    assert.equal(db.users[0].status, 'active', 'Base account must remain active');
    assert.equal(new Date(db.users[0].access_expires_at).getTime(), baseExpiry.getTime());
    assert.ok(new Date(db.users[0].access_expires_at).getTime() > Date.now(), 'Base access must be unexpired');
  });

  await t.test('5. Day 45: Base account expires after remaining 15 days elapse', async () => {
    const now = Date.now();
    // Simulate Day 46:
    // Base access expired 1 day ago
    const pastBaseExpiry = new Date(now - 1 * 24 * 3600 * 1000);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.USER, // already downgraded on Day 30
        premium_source: null,
        status: 'active', // waiting for base status expiry
        access_expires_at: pastBaseExpiry
      },
      user_product_grants: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          status: 'expired',
          valid_until: new Date(now - 16 * 24 * 3600 * 1000)
        }
      ]
    });

    // Reconcile base user account statuses
    const userStatusRes = await reconcileExpiredUserStatuses({ client: db.mockClient, dryRun: false });
    assert.equal(userStatusRes.usersExpired, 1, 'User base status should be marked expired');

    // Verify user status is now expired
    assert.equal(db.users[0].status, 'expired', 'User status must transition from active to expired on Day 45+');
  });

  await t.test('6. Reconciliation job cleanly expires subscriptions and revokes roles while leaving base access intact', async () => {
    const now = Date.now();
    const pastCycleEnd = new Date(now - 2 * 24 * 3600 * 1000);
    const futureBaseAccess = new Date(now + 13 * 24 * 3600 * 1000);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.PREMIUM,
        premium_source: 'subscription',
        status: 'active',
        access_expires_at: futureBaseAccess
      },
      paid_subscriptions: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          provider_subscription_id: 'sub_rec_001',
          status: 'active',
          current_period_end: pastCycleEnd
        }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          grant_type: 'subscription_cycle',
          status: 'active',
          valid_until: pastCycleEnd
        }
      ],
      user_roles: [
        { user_id: 201, role_id: 2, assignment_source: 'payment_system' }
      ]
    });

    const reconRes = await reconcilePaidProduct(db.paid_products[0], { client: db.mockClient, dryRun: false });
    assert.equal(reconRes.success, true);
    assert.equal(reconRes.subscriptionsExpired, 1, 'Stale subscription must be marked expired');
    assert.equal(reconRes.grantsExpired, 1, 'Stale cycle grant must be marked expired');
    assert.equal(reconRes.rolesRevoked, 1, 'Premium role must be revoked');

    // User is now USER, no premium role
    assert.equal(db.user_roles.length, 0);
    assert.equal(db.paid_subscriptions[0].status, 'expired');
    assert.equal(db.user_product_grants[0].status, 'expired');

    // Base account status is still active with 13 days left
    assert.equal(db.users[0].status, 'active');
    assert.equal(new Date(db.users[0].access_expires_at).getTime(), futureBaseAccess.getTime());
  });

  await t.test('7. Manual Premium assignment is protected even if recurring subscription expires', async () => {
    const now = Date.now();
    const pastCycleEnd = new Date(now - 5 * 24 * 3600 * 1000);

    const db = createRecurringMockDb({
      user: {
        id: 201,
        app_role: ROLES.PREMIUM,
        premium_source: 'manual',
        status: 'active',
        access_expires_at: null
      },
      paid_subscriptions: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          provider_subscription_id: 'sub_rec_old',
          status: 'expired',
          current_period_end: pastCycleEnd
        }
      ],
      user_product_grants: [
        {
          id: 1,
          user_id: 201,
          product_id: 100,
          status: 'expired',
          valid_until: pastCycleEnd
        }
      ],
      user_roles: [
        { user_id: 201, role_id: 2, assignment_source: 'manual' }
      ]
    });

    const syncRes = await syncUserPremiumRole(201, db.mockClient);
    const rbacRes = await syncProductRbacRole(201, 100, db.mockClient);

    assert.equal(syncRes.action, 'preserved_manual', 'Manual app_role must be preserved');
    assert.equal(rbacRes.action, 'preserved_manual', 'Manual RBAC role must be preserved');
    assert.equal(db.users[0].app_role, ROLES.PREMIUM);
    assert.equal(db.user_roles.length, 1);
    assert.equal(db.user_roles[0].assignment_source, 'manual');
  });
});
