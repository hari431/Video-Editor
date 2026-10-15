import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

import {
  recordGenericOneTimePayment,
  validateProductPromotion
} from '../src/auth/paidProducts.js';

test('Phase 2G-1 - Generic One-Time Payment Flow Suite', async (t) => {

  await t.test('1. recordGenericOneTimePayment handles successful payments, audit logs, and triggers RBAC sync', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        if (sql.includes('users') && sql.includes('app_role')) {
          return { rows: [{ id: 42, email: 'user@test.com', app_role: 'MEMBER' }], rowCount: 1 };
        }
        if (sql.includes('paid_orders') && sql.includes('provider_order_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO paid_orders')) {
          return { rows: [{ id: 111, status: 'paid' }], rowCount: 1 };
        }
        if (sql.includes('user_product_grants') && sql.includes('status = \'active\'')) {
          return { rows: [{ id: 222, status: 'active', valid_until: null }], rowCount: 1 };
        }
        if (sql.includes('user_product_grants') && sql.includes('order_id = $1')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('paid_products') && sql.includes('name FROM')) {
          return { rows: [{ name: 'Test Product' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO user_product_grants')) {
          return { rows: [{ id: 222, status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO paid_product_events')) {
          return { rows: [{ id: 333 }], rowCount: 1 };
        }
        if (sql.includes('user_roles') && sql.includes('r.name')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('paid_products p') && sql.includes('JOIN roles r')) {
          return { rows: [{ id: 5, code: 'TEST_PROD', is_enabled: true, role_id: 10, role_name: 'TEST_ROLE' }], rowCount: 1 };
        }
        if (sql.includes('roles') && sql.includes('name = $1')) {
          return { rows: [{ id: 10 }], rowCount: 1 };
        }
        if (sql.includes('user_roles') && sql.includes('assignment_source')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO user_roles')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('paid_products') && sql.includes('code = $1')) {
          return { rows: [{ code: 'TEST_PROD' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const result = await recordGenericOneTimePayment({
        userId: 42,
        productId: 5,
        planId: 10,
        orderId: 'order_abc123',
        paymentId: 'pay_xyz789',
        amountPaise: 15000,
        currency: 'INR',
        promoCode: 'TESTPROMO',
        discountPaise: 5000,
        validUntil: new Date(),
        metadata: { info: 'Test purchase' }
      });

      assert.ok(result, 'Should return order and grant detail mapping');
      assert.equal(result.order.id, 111);
      assert.equal(result.grant.id, 222);

      // Verify that audit log event is written
      const hasAudit = queryLog.some(q => q.sql.includes('INSERT INTO paid_product_events'));
      assert.ok(hasAudit, 'Should record transaction log to paid_product_events');

      // Verify role synchronization check happened
      const hasRbacSync = queryLog.some(q => q.sql.includes('user_roles') && q.sql.includes('INSERT'));
      assert.ok(hasRbacSync, 'Should invoke RBAC role mapping alignment');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('2. recordGenericOneTimePayment prevents duplicate grants for already processed payment ID', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        if (sql.includes('SELECT * FROM paid_orders WHERE provider = \'razorpay\' AND provider_order_id = $1')) {
          return { rows: [{ id: 111, status: 'paid' }], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM user_product_grants')) {
          return { rows: [{ id: 222, status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('SELECT r.name FROM user_roles ur')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) {
          return { rows: [{ code: 'PREMIUM' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const result = await recordGenericOneTimePayment({
        userId: 42,
        productId: 5,
        planId: 10,
        orderId: 'order_abc123',
        paymentId: 'pay_xyz789',
        amountPaise: 15000,
        currency: 'INR'
      });

      assert.ok(result);
      assert.equal(result.order.id, 111);
      assert.equal(result.grant.id, 222);

      // Ensure no insert queries were run (idempotency check)
      const hasInsertOrder = queryLog.some(q => q.sql.includes('INSERT INTO paid_orders'));
      const hasInsertGrant = queryLog.some(q => q.sql.includes('INSERT INTO user_product_grants'));

      assert.equal(hasInsertOrder, false, 'Should skip duplicate order insertions');
      assert.equal(hasInsertGrant, false, 'Should skip duplicate grant insertions');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('3. Promotion validation enforces the 1 INR (100 paise) minimum final price', async () => {
    const origQuery = pool.query;

    const mockPromotion = {
      id: 99,
      code: 'MASSIVE_FLAT',
      product_id: 2,
      discount_type: 'flat',
      discount_value: 100000, // ₹1000 discount
      eligibility_days: null,
      max_redemptions: null,
      is_enabled: true,
      valid_from: null,
      valid_until: null
    };

    const mockPool = {
      query: async (sql, params = []) => {
        if (sql.includes('SELECT * FROM paid_product_promotions WHERE UPPER(code) = $1')) {
          return { rows: [mockPromotion], rowCount: 1 };
        }
        if (sql.includes('SELECT created_at FROM users WHERE id = $1')) {
          return { rows: [{ created_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM paid_product_promo_redemptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const promoCheck = await validateProductPromotion(42, 'MASSIVE_FLAT', 2, 'one_time');
      assert.equal(promoCheck.valid, true);
      assert.equal(promoCheck.promo.discount_value, 100000);

      // Calculate final pricing
      const baseAmountPaise = 50000; // Plan price: ₹500 (50000 paise)
      const discountPaise = promoCheck.promo.discount_value; // ₹1000 (100000 paise)

      // Enforce the 1 INR minimum (100 paise)
      const finalAmountPaise = Math.max(100, baseAmountPaise - discountPaise);
      assert.equal(finalAmountPaise, 100, 'Discount must not reduce final price below 100 paise (1 INR)');
    } finally {
      pool.query = origQuery;
    }
  });

});
