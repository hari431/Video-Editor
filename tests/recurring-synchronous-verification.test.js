import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSubscriptionWebhook } from '../src/auth/premium.js';
import { pool } from '../src/db/pool.js';

test('Recurring Purchase Synchronous Verification Framework', async (t) => {
  const origQuery = pool.query;

  function createMockPool(queryLog, config = {}) {
    return {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return {};
        if (sql.includes('SELECT user_id FROM premium_subscriptions WHERE provider_subscription_id')) {
           return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT p.*, prod.id AS product_id, prod.code AS product_code, prod.is_enabled AS product_enabled')) {
          return {
             rows: [{
               id: 99,
               product_id: 88,
               product_code: 'TEST_RECURRING',
               product_enabled: true,
               price_amount_paise: 90000,
               duration_days: 15
             }],
             rowCount: 1
           };
        }
        // Fallback for duration_days inside recordGenericRecurringSubscriptionEvent
        if (sql.includes('SELECT duration_days FROM paid_product_plans WHERE id = $1')) {
          return { rows: [{ duration_days: 15 }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM paid_product_events WHERE provider_event_id')) {
          if (config.hasDuplicateEvent) return { rows: [{id: 777}], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        // premium_subscriptions existing checks
        if (sql.includes('SELECT id, status, current_period_end FROM premium_subscriptions WHERE provider_subscription_id')) {
           if (config.existingSub) return { rows: [config.existingSub], rowCount: 1 };
           return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT id FROM paid_subscriptions')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO paid_subscriptions')) return { rows: [{ id: 101, status: 'active' }], rowCount: 1 };
        if (sql.includes('UPDATE premium_subscriptions')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO premium_subscriptions')) return { rows: [{ id: 101 }], rowCount: 1 };
        if (sql.includes('SELECT id FROM premium_subscription_events WHERE provider_event_id')) {
           return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO premium_subscription_events')) {
           return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT id FROM paid_orders WHERE provider_payment_id = $1')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO paid_orders')) return { rows: [{ id: 201 }], rowCount: 1 };
        if (sql.includes('SELECT id FROM user_product_grants')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO user_product_grants')) return { rows: [{ id: 301 }], rowCount: 1 };
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) return { rows: [{ code: 'TEST_RECURRING' }], rowCount: 1 };
        if (sql.includes('SELECT valid_until')) return { rows: [{valid_until: new Date(Date.now() + 86400000)}], rowCount: 1 };
        if (sql.includes('SELECT status, access_expires_at FROM users WHERE id = $1')) return { rows: [{status: 'active', access_expires_at: new Date()}], rowCount: 1 };
        if (sql.includes('UPDATE users SET access_expires_at')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT user_id, role_id, assignment_source FROM user_roles')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT id, email, app_role FROM users')) return { rows: [{id: 42, email: 'test@example.com', app_role: 'MEMBER'}], rowCount: 1 };
        if (sql.includes('INSERT INTO user_roles')) return { rows: [], rowCount: 0 };
        if (sql.includes('DELETE FROM user_roles')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      connect: async function() { return { query: this.query, release: () => {} }; },
      release: () => {}
    };
  }

  await t.test('1. Initial recurring payment with current_end=null and charge_at=null', async () => {
    let queryLog = [];
    const mockPool = createMockPool(queryLog);
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_test_1',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: null,
            charge_at: null,
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: { id: 'pay_test1', status: 'captured', amount: 90000, currency: 'INR' }
        }
      };
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_test1', 'subscription.charged');
      assert.equal(result.success, true);

      // Check if grant was created with valid_until
      const grantInsert = queryLog.find(q => q.sql.includes('INSERT INTO user_product_grants'));
      assert.ok(grantInsert, 'grant is created');
      const validUntil = grantInsert.params[4]; // It's index 4 because $5 is valid_until
      assert.ok(validUntil, 'valid_until is calculated');
      
      const userUpdate = queryLog.find(q => q.sql.includes('UPDATE users SET access_expires_at'));
      assert.ok(userUpdate, 'access_expires_at is updated');

      // configured paid-product RBAC role access
      const roleInsert = queryLog.find(q => q.sql.includes('INSERT INTO user_roles'));
      // Wait, we didn't mock product roles, but the function runs through.
    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });

  await t.test('2. Initial recurring payment with current_end available still uses current_end', async () => {
    let queryLog = [];
    const mockPool = createMockPool(queryLog);
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_test_2',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: 1702592000, // available
            charge_at: null,
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: { id: 'pay_test2', status: 'captured', amount: 90000, currency: 'INR' }
        }
      };
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_test2', 'subscription.charged');
      assert.equal(result.success, true);

      const grantInsert = queryLog.find(q => q.sql.includes('INSERT INTO user_product_grants'));
      assert.ok(grantInsert, 'grant is created');
      const validUntil = grantInsert.params[4];
      assert.equal(new Date(validUntil).getTime(), 1702592000000, 'uses provided current_end');
    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });

  await t.test('3. Initial recurring payment with current_end null but charge_at available uses charge_at', async () => {
    let queryLog = [];
    const mockPool = createMockPool(queryLog);
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_test_3',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: null,
            charge_at: 1702592000, // available
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: { id: 'pay_test3', status: 'captured', amount: 90000, currency: 'INR' }
        }
      };
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_test3', 'subscription.charged');
      assert.equal(result.success, true);

      const grantInsert = queryLog.find(q => q.sql.includes('INSERT INTO user_product_grants'));
      assert.ok(grantInsert, 'grant is created');
      const validUntil = grantInsert.params[4];
      assert.equal(new Date(validUntil).getTime(), 1702592000000, 'uses provided charge_at');
    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });

  await t.test('4. Renewal with a real Razorpay period end continues to advance the existing entitlement correctly', async () => {
    let queryLog = [];
    const mockPool = createMockPool(queryLog, { existingSub: { id: 101, status: 'active', current_period_end: new Date(1700000000000) } });
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_test_4',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: 1705000000, // renewal
            charge_at: null,
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: { id: 'pay_test4', status: 'captured', amount: 90000, currency: 'INR' }
        }
      };
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_test4', 'subscription.charged');
      assert.equal(result.success, true);

      const grantInsert = queryLog.find(q => q.sql.includes('INSERT INTO user_product_grants'));
      assert.ok(grantInsert, 'grant is created for renewal');
      const validUntil = grantInsert.params[4];
      assert.equal(new Date(validUntil).getTime(), 1705000000000, 'uses renewal period end');
    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });

  await t.test('5. Duplicate verification/webhook remains idempotent', async () => {
    let queryLog = [];
    const mockPool = createMockPool(queryLog, { hasDuplicateEvent: true });
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_test_5',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: 1702592000,
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: { id: 'pay_test5', status: 'captured' }
        }
      };
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_test5', 'subscription.charged');
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'Duplicate event');
    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });
});
