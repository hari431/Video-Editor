import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

import {
  recordGenericRecurringSubscriptionEvent
} from '../src/auth/paidProducts.js';

test('Phase 2G-2 - Generic Recurring Payment Flow Suite', async (t) => {

  await t.test('1. recordGenericRecurringSubscriptionEvent upserts subscriptions, records orders and creates cycle grants', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        if (sql.includes('INSERT INTO paid_subscriptions')) {
          return { rows: [{ id: 101, status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('users') && (sql.includes('app_role') || sql.includes('email'))) {
          return { rows: [{ id: 42, email: 'user@test.com', app_role: 'MEMBER' }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM paid_orders WHERE provider_payment_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO paid_orders')) {
          return { rows: [{ id: 201 }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT * FROM user_product_grants')) {
          return { rows: [{ id: 301, status: 'active', valid_until: null }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO user_product_grants')) {
          return { rows: [{ id: 301 }], rowCount: 1 };
        }
        if (sql.includes('paid_products p') && sql.includes('JOIN roles r')) {
          return { rows: [{ id: 5, code: 'TEST_RECUR', is_enabled: true, role_id: 11, role_name: 'TEST_MEMBER' }], rowCount: 1 };
        }
        if (sql.includes('SELECT r.name FROM user_roles ur')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('roles') && sql.includes('name = $1')) {
          return { rows: [{ id: 11 }], rowCount: 1 };
        }
        if (sql.includes('user_roles') && sql.includes('assignment_source')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO user_roles')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) {
          return { rows: [{ code: 'TEST_RECUR' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const result = await recordGenericRecurringSubscriptionEvent({
        userId: 42,
        productId: 5,
        planId: 10,
        providerSubscriptionId: 'sub_xyz123',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        paymentId: 'pay_xyz789',
        amountPaise: 49900,
        currency: 'INR'
      });

      assert.ok(result, 'Should return subscription mapping');
      assert.equal(result.subscription.id, 101);

      // Verify that the sub, order, and grant insertions were executed
      const hasInsertSub = queryLog.some(q => q.sql.includes('INSERT INTO paid_subscriptions'));
      const hasInsertOrder = queryLog.some(q => q.sql.includes('INSERT INTO paid_orders'));
      const hasInsertGrant = queryLog.some(q => q.sql.includes('INSERT INTO user_product_grants'));

      assert.ok(hasInsertSub, 'Should insert/upsert subscription');
      assert.ok(hasInsertOrder, 'Should record payment order');
      assert.ok(hasInsertGrant, 'Should create product grant for subscription cycle');

      // Verify RBAC sync happened
      const hasInsertRole = queryLog.some(q => q.sql.includes('INSERT INTO user_roles'));
      assert.ok(hasInsertRole, 'Should assign corresponding product RBAC role');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('2. recordGenericRecurringSubscriptionEvent is idempotent and prevents duplicate grants/orders', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        if (sql.includes('INSERT INTO paid_subscriptions')) {
          return { rows: [{ id: 101, status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM paid_orders WHERE provider_payment_id = $1')) {
          return { rows: [{ id: 201 }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM user_product_grants')) {
          return { rows: [{ id: 301 }], rowCount: 1 };
        }
        if (sql.includes('SELECT r.name FROM user_roles ur')) {
          return { rows: [{ name: 'TEST_MEMBER' }], rowCount: 1 };
        }
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) {
          return { rows: [{ code: 'TEST_RECUR' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const result = await recordGenericRecurringSubscriptionEvent({
        userId: 42,
        productId: 5,
        planId: 10,
        providerSubscriptionId: 'sub_xyz123',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        paymentId: 'pay_xyz789',
        amountPaise: 49900,
        currency: 'INR'
      });

      assert.ok(result);

      const hasInsertOrder = queryLog.some(q => q.sql.includes('INSERT INTO paid_orders'));
      const hasInsertGrant = queryLog.some(q => q.sql.includes('INSERT INTO user_product_grants'));

      assert.equal(hasInsertOrder, false, 'Should not insert duplicate order for same paymentId');
      assert.equal(hasInsertGrant, false, 'Should not insert duplicate grant for same billing cycle/paymentId');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('3. recordGenericRecurringSubscriptionEvent syncs legacy tables when product is PREMIUM', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        if (sql.includes('INSERT INTO paid_subscriptions')) {
          return { rows: [{ id: 101, status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM paid_orders WHERE provider_payment_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO paid_orders')) {
          return { rows: [{ id: 201 }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM user_product_grants')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO user_product_grants')) {
          return { rows: [{ id: 301 }], rowCount: 1 };
        }
        if (sql.includes('SELECT app_role, premium_source FROM users WHERE id = $1')) {
          return { rows: [{ app_role: 'MEMBER', premium_source: 'none' }], rowCount: 1 };
        }
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) {
          return { rows: [{ code: 'PREMIUM' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      await recordGenericRecurringSubscriptionEvent({
        userId: 42,
        productId: 5,
        planId: 10,
        providerSubscriptionId: 'sub_xyz123',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        paymentId: 'pay_xyz789',
        amountPaise: 49900,
        currency: 'INR'
      });

      // Verify legacy PREMIUM specific sync occurred
      const hasLegacyUserUpdate = queryLog.some(q => q.sql.includes('UPDATE users') && q.sql.includes('premium_source = \'subscription\''));
      const hasLegacySubInsert = queryLog.some(q => q.sql.includes('INSERT INTO premium_subscriptions'));
      const hasLegacyRoleAudit = queryLog.some(q => q.sql.includes('INSERT INTO role_audit_log'));

      assert.ok(hasLegacyUserUpdate, 'Should sync users.premium_source, access_expires_at, and app_role for legacy PREMIUM');
      assert.ok(hasLegacySubInsert, 'Should populate legacy premium_subscriptions table');
      assert.ok(hasLegacyRoleAudit, 'Should log legacy role audit event');
    } finally {
      pool.query = origQuery;
    }
  });

});
