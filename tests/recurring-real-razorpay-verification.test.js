import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSubscriptionWebhook } from '../src/auth/premium.js';
import { pool } from '../src/db/pool.js';

test('Real Razorpay Synchronous Payload Fallback', async (t) => {
  await t.test('Falls back to charge_at and created_at when current_start and current_end are null', async () => {
    const origQuery = pool.query;
    let queryLog = [];
    
    const mockPool = {
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
              price_amount_paise: 90000 
            }], 
            rowCount: 1 
          };
        }
        
        if (sql.includes('SELECT id FROM paid_product_events WHERE provider_event_id')) {
          return { rows: [], rowCount: 0 };
        }
        
        if (sql.includes('SELECT id FROM paid_subscriptions')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO paid_subscriptions')) return { rows: [{ id: 101, status: 'active' }], rowCount: 1 };
        
        if (sql.includes('SELECT id FROM paid_orders WHERE provider_payment_id = $1')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO paid_orders')) return { rows: [{ id: 201 }], rowCount: 1 };
        
        if (sql.includes('SELECT id FROM user_product_grants')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO user_product_grants')) return { rows: [{ id: 301 }], rowCount: 1 };
        
        if (sql.includes('SELECT code FROM paid_products WHERE id = $1')) return { rows: [{ code: 'TEST_RECURRING' }], rowCount: 1 };

        return { rows: [], rowCount: 0 };
      },
      connect: async () => mockPool,
      release: () => {}
    };
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;

    try {
      // Realistic initial payload during checkout
      const payload = {
        subscription: {
          entity: {
            id: 'sub_real123',
            status: 'authenticated',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: null,
            current_end: null,
            created_at: 1700000000,
            charge_at: 1702592000, // Important: future timestamp
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: {
          entity: {
            id: 'pay_real123',
            status: 'captured',
            amount: 90000,
            currency: 'INR'
          }
        }
      };

      const result = await handleSubscriptionWebhook(payload, 'sync_pay_real123', 'subscription.charged');
      assert.equal(result.success, true);
      
      const hasInsertGrant = queryLog.some(q => 
        q.sql.includes('INSERT INTO user_product_grants') &&
        q.params.some(p => p instanceof Date && p.getTime() === 1702592000000)
      );
      
      assert.ok(hasInsertGrant, 'Should insert grant using charge_at as valid_until when current_end is null');

    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });

  await t.test('Idempotency prevents duplicate grants for delayed webhooks', async () => {
    const origQuery = pool.query;
    let queryLog = [];
    
    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return {};
        
        // Mock existing generic plan
        if (sql.includes('SELECT p.*, prod.id AS product_id, prod.code AS product_code')) {
          return { 
            rows: [{ id: 99, product_id: 88, product_code: 'TEST_RECURRING', product_enabled: true, price_amount_paise: 90000 }], 
            rowCount: 1 
          };
        }
        
        // The key test point: Event ID exists from earlier synchronous verified transaction!
        if (sql.includes('SELECT id FROM paid_product_events WHERE provider_event_id = $1')) {
          return { rows: [{ id: 9001 }], rowCount: 1 };
        }
        
        return { rows: [], rowCount: 0 };
      },
      connect: async () => mockPool,
      release: () => {}
    };
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;

    try {
      const payload = {
        subscription: {
          entity: {
            id: 'sub_real123',
            status: 'active',
            plan_id: 'plan_test123',
            customer_id: 'cust_test123',
            current_start: 1700000000,
            current_end: 1702592000,
            notes: { userId: '42', planId: '99' }
          }
        },
        payment: { entity: { id: 'pay_real123', status: 'captured', amount: 90000, currency: 'INR' } }
      };

      // Simulating a delayed webhook with an event_id that we already processed (e.g. sync_pay_real123)
      const result = await handleSubscriptionWebhook(payload, 'sync_pay_real123', 'subscription.charged');
      
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'Duplicate event');
      
      const hasInsertGrant = queryLog.some(q => q.sql.includes('INSERT INTO user_product_grants'));
      assert.equal(hasInsertGrant, false, 'Should skip duplicate webhook and not insert grant');

    } finally {
      pool.query = origQuery;
      pool.connect = origQuery.connect;
    }
  });
});
