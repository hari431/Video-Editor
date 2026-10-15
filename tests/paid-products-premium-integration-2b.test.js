import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { ROLES } from '../src/auth/admin.js';
import {
  getProductByCode,
  validateUserEntitlement,
  syncProductRbacRole,
  recordOneTimePremiumPayment,
  recordRecurringPremiumSubscriptionEvent
} from '../src/auth/paidProducts.js';

// --- In-Memory Mock Store for Phase 2B Integration Tests ---
function createMockDb() {
  const users = [
    { id: 1, email: 'owner@example.com', app_role: ROLES.OWNER, status: 'active', premium_source: null, access_expires_at: null },
    { id: 2, email: 'admin@example.com', app_role: ROLES.ADMIN, status: 'active', premium_source: null, access_expires_at: null },
    { id: 10, email: 'user10@example.com', app_role: ROLES.USER, status: 'active', premium_source: null, access_expires_at: null },
    { id: 11, email: 'manual@example.com', app_role: ROLES.USER, status: 'active', premium_source: 'manual', access_expires_at: null },
    { id: 12, email: 'legacy@example.com', app_role: ROLES.USER, status: 'active', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 86400000) }
  ];

  const roles = [
    { id: 1, name: 'USER', description: 'Standard user' },
    { id: 2, name: 'PREMIUM', description: 'Built-in Premium role' },
    { id: 3, name: 'ADMIN', description: 'Admin role' },
    { id: 4, name: 'OWNER', description: 'Owner role' }
  ];

  const user_roles = [
    // user 11 has manual PREMIUM assignment
    { user_id: 11, role_id: 2, assignment_source: 'manual' }
  ];

  const paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_active: true }
  ];

  const paid_plans = [
    { id: 201, product_id: 100, code: 'one_time', name: 'One-Time 30 Days', billing_interval: 'one_time', price_paise: 30000, is_active: true },
    { id: 202, product_id: 100, code: 'recurring_monthly', name: 'Monthly Recurring', billing_interval: 'month', price_paise: 30000, is_active: true }
  ];

  const paid_orders = [];
  const paid_subscriptions = [];
  const user_product_grants = [];
  const paid_product_events = [];
  const premium_subscriptions = [];

  let nextOrderId = 1;
  let nextSubId = 1;
  let nextGrantId = 1;
  let nextEventId = 1;

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
        const p = paid_products.find(x => x.code === params[0]);
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
      if (/FROM users WHERE id = \$1/i.test(sql) && !/UPDATE/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 5. User Roles
      if (/SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = \$1 AND role_id = \$2/i.test(sql)) {
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
      if (/SELECT id FROM paid_orders WHERE provider_payment_id = \$1/i.test(sql)) {
        const ord = paid_orders.find(x => x.provider_payment_id === params[0]);
        return { rows: ord ? [{ id: ord.id }] : [], rowCount: ord ? 1 : 0 };
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
      if (/UPDATE paid_orders/i.test(sql)) {
        const id = Number(params[0]);
        const ord = paid_orders.find(x => x.id === id);
        if (ord) {
          ord.status = 'paid';
          ord.provider_payment_id = params[1];
          ord.updated_at = new Date();
        }
        return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
      }

      // 7. Paid Subscriptions
      if (/INSERT INTO paid_subscriptions/i.test(sql)) {
        const subId = params[4];
        let sub = paid_subscriptions.find(x => x.provider_subscription_id === subId);
        if (sub) {
          sub.status = params[5];
          sub.current_period_start = params[6];
          sub.current_period_end = params[7];
          sub.cancel_at_period_end = params[8];
          sub.updated_at = new Date();
        } else {
          sub = {
            id: nextSubId++,
            user_id: Number(params[0]),
            product_id: Number(params[1]),
            plan_id: params[2] ? Number(params[2]) : null,
            provider: 'razorpay',
            provider_customer_id: params[3] || null,
            provider_subscription_id: subId,
            status: params[5],
            current_period_start: params[6],
            current_period_end: params[7],
            cancel_at_period_end: params[8],
            metadata: typeof params[9] === 'string' ? JSON.parse(params[9]) : (params[9] || {}),
            created_at: new Date(),
            updated_at: new Date()
          };
          paid_subscriptions.push(sub);
        }
        return { rows: [sub], rowCount: 1 };
      }

      // 8. User Product Grants
      if (/SELECT \* FROM user_product_grants/i.test(sql) || /SELECT id FROM user_product_grants/i.test(sql)) {
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
        if (sql.includes('WHERE subscription_id = $1 AND product_id = $2')) {
          const subId = Number(params[0]);
          const prodId = Number(params[1]);
          const validUntil = params[2];
          const payId = params[3];
          const invId = params[4];
          const g = user_product_grants.find(x =>
            x.subscription_id === subId &&
            x.product_id === prodId &&
            (
              (validUntil && x.valid_until && new Date(x.valid_until).getTime() === new Date(validUntil).getTime()) ||
              (payId && x.metadata?.provider_payment_id === payId) ||
              (invId && x.metadata?.invoice_id === invId)
            )
          );
          return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
        }
        if (sql.includes('user_id = $1') && sql.includes('product_id = $2')) {
          const uid = Number(params[0]);
          const prodId = Number(params[1]);
          const rows = user_product_grants.filter(x =>
            x.user_id === uid &&
            x.product_id === prodId &&
            x.status === 'active' &&
            (x.valid_until === null || new Date(x.valid_until) > new Date())
          );
          return { rows, rowCount: rows.length };
        }
      }

      if (/INSERT INTO user_product_grants/i.test(sql)) {
        const isOneTime = sql.includes("'one_time_purchase'");
        const grant = {
          id: nextGrantId++,
          user_id: Number(params[0]),
          product_id: Number(params[1]),
          plan_id: params[2] ? Number(params[2]) : null,
          grant_type: isOneTime ? 'one_time_purchase' : 'subscription_cycle',
          status: 'active',
          valid_from: isOneTime ? new Date() : params[3],
          valid_until: isOneTime ? params[3] : params[4],
          order_id: isOneTime ? params[4] : params[6],
          subscription_id: isOneTime ? null : params[5],
          grant_reason: isOneTime ? 'Verified one-time Premium payment' : params[7],
          metadata: isOneTime ? (typeof params[5] === 'string' ? JSON.parse(params[5]) : params[5]) : (typeof params[8] === 'string' ? JSON.parse(params[8]) : params[8]),
          created_at: new Date(),
          updated_at: new Date()
        };
        user_product_grants.push(grant);
        return { rows: [grant], rowCount: 1 };
      }

      // 9. Paid Product Events
      if (/INSERT INTO paid_product_events/i.test(sql)) {
        const ev = { id: nextEventId++, event_type: params[3], created_at: new Date() };
        paid_product_events.push(ev);
        return { rows: [ev], rowCount: 1 };
      }

      // 10. Fallback
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
    user_product_grants,
    paid_product_events,
    mockClient
  };
}

// --- Tests ---

test('Phase 2B: One-Time Premium payment creates paid_orders and user_product_grants', async () => {
  const db = createMockDb();
  const userId = 10;
  const orderId = 'order_ot_123';
  const paymentId = 'pay_ot_456';
  const expiry = new Date(Date.now() + 30 * 86400000);

  const result = await recordOneTimePremiumPayment({
    userId,
    orderId,
    paymentId,
    amountPaise: 27000,
    currency: 'INR',
    promoCode: 'DISCOUNT10',
    discountPaise: 3000,
    validUntil: expiry,
    metadata: { source: 'web_checkout' }
  }, db.mockClient);

  assert.ok(result, 'Expected result from recordOneTimePremiumPayment');
  assert.equal(db.paid_orders.length, 1, 'Should create 1 paid_orders record');
  assert.equal(db.paid_orders[0].user_id, userId);
  assert.equal(db.paid_orders[0].status, 'paid');
  assert.equal(db.paid_orders[0].provider_order_id, orderId);
  assert.equal(db.paid_orders[0].provider_payment_id, paymentId);
  assert.equal(db.paid_orders[0].promo_code, 'DISCOUNT10');
  assert.equal(db.paid_orders[0].discount_paise, 3000);

  assert.equal(db.user_product_grants.length, 1, 'Should create 1 user_product_grants record');
  assert.equal(db.user_product_grants[0].grant_type, 'one_time_purchase');
  assert.equal(db.user_product_grants[0].status, 'active');
  assert.equal(db.user_product_grants[0].user_id, userId);
  assert.equal(db.user_product_grants[0].valid_until, expiry);

  // Check RBAC role was granted
  const ur = db.user_roles.find(r => r.user_id === userId && r.role_id === 2);
  assert.ok(ur, 'User should receive PREMIUM role in user_roles');
  assert.equal(ur.assignment_source, 'payment_system', 'Role should be assigned via payment_system');
});

test('Phase 2B: One-Time payment is idempotent and does not create duplicate grants', async () => {
  const db = createMockDb();
  const userId = 10;
  const orderId = 'order_ot_dup';
  const paymentId = 'pay_ot_dup';
  const expiry = new Date(Date.now() + 30 * 86400000);

  // First call
  await recordOneTimePremiumPayment({
    userId,
    orderId,
    paymentId,
    amountPaise: 30000,
    validUntil: expiry
  }, db.mockClient);

  assert.equal(db.paid_orders.length, 1);
  assert.equal(db.user_product_grants.length, 1);

  // Second call with same payment / order
  await recordOneTimePremiumPayment({
    userId,
    orderId,
    paymentId,
    amountPaise: 30000,
    validUntil: expiry
  }, db.mockClient);

  assert.equal(db.paid_orders.length, 1, 'Order must not duplicate');
  assert.equal(db.user_product_grants.length, 1, 'Grant must not duplicate');
});

test('Phase 2B: Recurring subscription event creates paid_subscriptions, paid_orders, and subscription_cycle grant', async () => {
  const db = createMockDb();
  const userId = 10;
  const subId = 'sub_rec_789';
  const paymentId = 'pay_rec_001';
  const currentStart = new Date();
  const currentEnd = new Date(Date.now() + 30 * 86400000);

  const result = await recordRecurringPremiumSubscriptionEvent({
    userId,
    providerSubscriptionId: subId,
    status: 'active',
    currentPeriodStart: currentStart,
    currentPeriodEnd: currentEnd,
    cancelAtPeriodEnd: false,
    paymentId,
    invoiceId: 'inv_101',
    amountPaise: 30000,
    eventType: 'subscription.charged'
  }, db.mockClient);

  assert.ok(result, 'Expected result from recordRecurringPremiumSubscriptionEvent');
  assert.equal(db.paid_subscriptions.length, 1, 'Should record in paid_subscriptions');
  assert.equal(db.paid_subscriptions[0].status, 'active');
  assert.equal(db.paid_subscriptions[0].provider_subscription_id, subId);

  assert.equal(db.paid_orders.length, 1, 'Should record payment in paid_orders');
  assert.equal(db.paid_orders[0].provider_payment_id, paymentId);
  assert.equal(db.paid_orders[0].status, 'paid');

  assert.equal(db.user_product_grants.length, 1, 'Should create subscription_cycle grant');
  assert.equal(db.user_product_grants[0].grant_type, 'subscription_cycle');
  assert.equal(db.user_product_grants[0].status, 'active');
  assert.equal(db.user_product_grants[0].valid_until, currentEnd);

  // Check RBAC role
  const ur = db.user_roles.find(r => r.user_id === userId && r.role_id === 2);
  assert.ok(ur, 'User should receive PREMIUM role in user_roles');
  assert.equal(ur.assignment_source, 'payment_system');
});

test('Phase 2B: Recurring subscription deduplicates cycle grants', async () => {
  const db = createMockDb();
  const userId = 10;
  const subId = 'sub_rec_dedup';
  const paymentId = 'pay_rec_dedup';
  const currentStart = new Date();
  const currentEnd = new Date(Date.now() + 30 * 86400000);

  // Webhook: subscription.activated
  await recordRecurringPremiumSubscriptionEvent({
    userId,
    providerSubscriptionId: subId,
    status: 'active',
    currentPeriodStart: currentStart,
    currentPeriodEnd: currentEnd,
    paymentId,
    eventType: 'subscription.activated'
  }, db.mockClient);

  assert.equal(db.user_product_grants.length, 1);

  // Webhook: subscription.charged for same payment / period
  await recordRecurringPremiumSubscriptionEvent({
    userId,
    providerSubscriptionId: subId,
    status: 'active',
    currentPeriodStart: currentStart,
    currentPeriodEnd: currentEnd,
    paymentId,
    eventType: 'subscription.charged'
  }, db.mockClient);

  assert.equal(db.user_product_grants.length, 1, 'Grant should not duplicate for same billing period/payment');
});

test('Phase 2B: Manual RBAC assignments are strictly preserved', async () => {
  const db = createMockDb();
  const manualUserId = 11; // User 11 has manual assignment in user_roles

  // Sync without entitlement
  const syncResult = await syncProductRbacRole(manualUserId, 100, db.mockClient);
  assert.equal(syncResult.action, 'preserved_manual');

  // Verify role still present in user_roles
  const ur = db.user_roles.find(r => r.user_id === manualUserId && r.role_id === 2);
  assert.ok(ur, 'Manual role assignment must be preserved');
  assert.equal(ur.assignment_source, 'manual');
});

test('Phase 2B: OWNER and ADMIN users are strictly protected from modification', async () => {
  const db = createMockDb();

  // Try sync for OWNER (user 1)
  const ownerSync = await syncProductRbacRole(1, 100, db.mockClient);
  assert.equal(ownerSync.action, 'skipped_protected');

  // Try sync for ADMIN (user 2)
  const adminSync = await syncProductRbacRole(2, 100, db.mockClient);
  assert.equal(adminSync.action, 'skipped_protected');

  // Verify no roles were modified
  assert.equal(db.user_roles.filter(r => r.user_id === 1 || r.user_id === 2).length, 0);
});

test('Phase 2B: validateUserEntitlement recognizes legacy active users when grants table is empty', async () => {
  const db = createMockDb();
  // User 12 has legacy one_time expiry in users table
  const ent = await validateUserEntitlement(12, 'PREMIUM', db.mockClient);
  assert.equal(ent.hasEntitlement, true, 'Should recognize legacy entitlement');
  assert.equal(ent.primaryGrantType, 'one_time_purchase');
});

test('Phase 2B: Multiple distinct one-time payments stack grants cleanly', async () => {
  const db = createMockDb();
  const userId = 10;
  const expiry1 = new Date(Date.now() + 30 * 86400000);
  const expiry2 = new Date(Date.now() + 60 * 86400000);

  // First purchase
  await recordOneTimePremiumPayment({
    userId,
    orderId: 'order_stack_1',
    paymentId: 'pay_stack_1',
    amountPaise: 30000,
    validUntil: expiry1
  }, db.mockClient);

  // Second purchase (stacked extension)
  await recordOneTimePremiumPayment({
    userId,
    orderId: 'order_stack_2',
    paymentId: 'pay_stack_2',
    amountPaise: 30000,
    validUntil: expiry2
  }, db.mockClient);

  assert.equal(db.paid_orders.length, 2, 'Two orders should exist');
  assert.equal(db.user_product_grants.length, 2, 'Two grants should exist');
  
  const ent = await validateUserEntitlement(userId, 100, db.mockClient);
  assert.equal(ent.hasEntitlement, true);
  assert.equal(ent.activeGrants.length, 2);
  assert.equal(ent.furthestExpiry.getTime(), expiry2.getTime());
});

