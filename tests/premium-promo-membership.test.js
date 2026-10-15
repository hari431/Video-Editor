import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { getPromoCodes, validatePromoCode } from '../src/auth/premium.js';

test('Premium Promotions & One-Time Membership Unit Tests', async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  let userDatabase = {};
  let redemptionsDatabase = [];
  let subscriptionEvents = [];

  const resetMockDatabases = () => {
    // Normal user created 1 day ago
    userDatabase[100] = {
      id: 100,
      email: 'normal@example.com',
      app_role: 'USER',
      premium_source: null,
      access_expires_at: null,
      created_at: new Date(Date.now() - 24 * 3600 * 1000)
    };
    // Manual premium user
    userDatabase[101] = {
      id: 101,
      email: 'manual@example.com',
      app_role: 'PREMIUM',
      premium_source: 'manual',
      access_expires_at: null,
      created_at: new Date(Date.now() - 24 * 3600 * 1000)
    };
    // Stale user created 10 days ago
    userDatabase[102] = {
      id: 102,
      email: 'stale@example.com',
      app_role: 'USER',
      premium_source: null,
      access_expires_at: null,
      created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000)
    };

    redemptionsDatabase = [];
    subscriptionEvents = [];
  };

  const mockClient = {
    query: async (sql, params = []) => {
      return pool.query(sql, params);
    },
    release: () => {}
  };

  test.beforeEach(() => {
    resetMockDatabases();
    
    pool.connect = async () => {
      return mockClient;
    };

    pool.query = async (sql, params = []) => {
      // 1. Fetch user by ID
      if (sql.includes('FROM users')) {
        const userId = params[0];
        const u = userDatabase[userId];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 2. Fetch promo redemptions for a user & code
      if (sql.includes('SELECT id FROM premium_promo_redemptions WHERE user_id = $1 AND promotion_code = $2')) {
        const userId = params[0];
        const code = params[1];
        const found = redemptionsDatabase.filter(r => r.user_id === userId && r.promotion_code === code);
        return { rows: found, rowCount: found.length };
      }

      // 3. Count total redemptions for a promo code
      if (sql.includes('SELECT COUNT(*) as count FROM premium_promo_redemptions WHERE promotion_code = $1')) {
        const code = params[0];
        const found = redemptionsDatabase.filter(r => r.promotion_code === code);
        return { rows: [{ count: found.length }], rowCount: 1 };
      }

      // 4. Check for existing payment event (idempotency check)
      if (sql.includes("SELECT id FROM premium_subscription_events WHERE provider_event_id = $1 AND event_type = 'one_time_purchase'")) {
        const payId = params[0];
        const found = subscriptionEvents.filter(e => e.provider_event_id === payId);
        return { rows: found, rowCount: found.length };
      }

      if (sql.includes('SELECT id FROM premium_subscriptions WHERE provider_subscription_id =')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('INSERT INTO premium_subscriptions')) {
        return { rows: [{ id: 51 }], rowCount: 1 };
      }

      if (sql.includes('SELECT id FROM premium_subscription_events') && !sql.includes('INSERT')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('INSERT INTO premium_promo_redemptions')) {
        redemptionsDatabase.push({
          user_id: params[0],
          promotion_code: params[1],
          provider_reference: params[2],
          original_amount_paise: params[3],
          discount_amount_paise: params[4],
          final_amount_paise: params[5]
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE users')) {
        const idParam = params[0];
        const u = userDatabase[idParam];
        if (u) {
          u.app_role = 'PREMIUM';
          u.access_expires_at = new Date(Date.now() + 30 * 24 * 3600 * 1000);
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('INSERT INTO premium_subscription_events') || sql.includes('INSERT INTO role_audit_log')) {
        return { rows: [], rowCount: 1 };
      }

      // Default empty result for inserts or other selects
      return { rows: [], rowCount: 0 };
    };
  });

  test.afterEach(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  await t.test('getPromoCodes should parse environment configuration accurately', () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    
    // Test valid array config
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'SAVE10', type: 'percentage', value: 10, enabled: true }
    ]);
    const codes = getPromoCodes();
    assert.equal(codes.length, 1);
    assert.equal(codes[0].code, 'SAVE10');

    // Test malformed JSON handling
    process.env.PREMIUM_PROMO_CODES_JSON = '{broken-json';
    const broken = getPromoCodes();
    assert.deepEqual(broken, []);

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should check basic validity, case insensitivity, and enabled flag', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'OFF50', type: 'percentage', value: 50, enabled: true },
      { code: 'DISABLED_CODE', type: 'flat', value: 100, enabled: false }
    ]);

    // Test non-existent code
    const r1 = await validatePromoCode(100, 'NO_CODE', 'one_time');
    assert.equal(r1.valid, false);

    // Test case insensitive match
    const r2 = await validatePromoCode(100, 'off50', 'one_time');
    assert.equal(r2.valid, true);
    assert.equal(r2.finalAmount, 150); // ₹300 - 50% = 150

    // Test disabled code
    const r3 = await validatePromoCode(100, 'DISABLED_CODE', 'one_time');
    assert.equal(r3.valid, false);

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should restrict by user account eligibilityDays limit', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'NEWBIE', type: 'percentage', value: 30, eligibilityDays: 5, enabled: true }
    ]);

    // User created 1 day ago -> eligible
    const r1 = await validatePromoCode(100, 'NEWBIE', 'one_time');
    assert.equal(r1.valid, true);

    // User created 10 days ago -> ineligible
    const r2 = await validatePromoCode(102, 'NEWBIE', 'one_time');
    assert.equal(r2.valid, false);
    assert.equal(r2.error, 'You are no longer eligible for this promotion.');

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should enforce single redemption per user limit', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'ONCE', type: 'flat', value: 50, enabled: true }
    ]);

    // No existing redemption -> valid
    const r1 = await validatePromoCode(100, 'ONCE', 'one_time');
    assert.equal(r1.valid, true);

    // Record mock redemption
    redemptionsDatabase.push({ user_id: 100, promotion_code: 'ONCE' });

    // Try again -> invalid
    const r2 = await validatePromoCode(100, 'ONCE', 'one_time');
    assert.equal(r2.valid, false);
    assert.equal(r2.error, 'You have already redeemed this promotion.');

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should enforce max global redemption count limit', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'LIMIT2', type: 'flat', value: 10, maxRedemptions: 2, enabled: true }
    ]);

    // Redemptions count is 0 -> valid
    const r1 = await validatePromoCode(100, 'LIMIT2', 'one_time');
    assert.equal(r1.valid, true);

    // Push 2 mock redemptions by other users
    redemptionsDatabase.push({ user_id: 200, promotion_code: 'LIMIT2' });
    redemptionsDatabase.push({ user_id: 201, promotion_code: 'LIMIT2' });

    // Try -> invalid (limit exceeded)
    const r2 = await validatePromoCode(100, 'LIMIT2', 'one_time');
    assert.equal(r2.valid, false);
    assert.equal(r2.error, 'This promotion has reached its maximum usage limit.');

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should prevent flat or percentage discounts from dropping final price below 1 INR', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'FREE_FLAT', type: 'flat', value: 400, enabled: true },
      { code: 'FREE_PERCENT', type: 'percentage', value: 100, enabled: true }
    ]);

    // Flat discount of ₹400 on ₹300 base -> ₹1 minimum
    const r1 = await validatePromoCode(100, 'FREE_FLAT', 'one_time');
    assert.equal(r1.valid, true);
    assert.equal(r1.finalAmount, 1);
    assert.equal(r1.discountAmount, 299);

    // Percentage discount of 100% on ₹300 base -> ₹1 minimum
    const r2 = await validatePromoCode(100, 'FREE_PERCENT', 'one_time');
    assert.equal(r2.valid, true);
    assert.equal(r2.finalAmount, 1);
    assert.equal(r2.discountAmount, 299);

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('validatePromoCode should reject recurring types if the code lacks a recurringOfferId', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'C1', type: 'percentage', value: 50, enabled: true },
      { code: 'C2', type: 'percentage', value: 50, enabled: true, recurringOfferId: 'offer_123' }
    ]);

    // C1 lacks recurringOfferId -> invalid for recurring
    const r1 = await validatePromoCode(100, 'C1', 'recurring');
    assert.equal(r1.valid, false);
    assert.equal(r1.error, 'This promotion cannot be applied to recurring subscriptions.');

    // C2 has recurringOfferId -> valid
    const r2 = await validatePromoCode(100, 'C2', 'recurring');
    assert.equal(r2.valid, true);
    assert.equal(r2.recurringOfferId, 'offer_123');

    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

  await t.test('handleSubscriptionWebhook with promo code notes should record redemption', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'SAVE20', type: 'percentage', value: 20, enabled: true, recurringOfferId: 'offer_abc' }
    ]);

    const payload = {
      subscription: {
        entity: {
          id: 'sub_promo_100',
          status: 'active',
          notes: { user_id: '100', promoCode: 'SAVE20' }
        }
      },
      payment: {
        entity: {
          id: 'pay_promo_100',
          status: 'captured'
        }
      }
    };

    let checkRedemptionQueryRun = false;
    let originalQueryLocal = pool.query;
    pool.query = async (sql, params = []) => {
      if (sql.includes('INSERT INTO premium_promo_redemptions')) {
        checkRedemptionQueryRun = true;
        assert.equal(params[1], 'SAVE20'); // promotion_code
        assert.equal(params[3], 30000);    // original_amount_paise (300 * 100)
        assert.equal(params[4], 6000);     // discount_amount_paise (20% of 300 * 100)
        assert.equal(params[5], 24000);    // final_amount_paise (240 * 100)
      }
      return originalQueryLocal(sql, params);
    };

    const { handleSubscriptionWebhook: handleWebhookLocal } = await import('../src/auth/premium.js');
    await handleWebhookLocal(payload, 'evt_promo_100', 'subscription.charged');

    assert.ok(checkRedemptionQueryRun, 'Promotion redemption should have been inserted into the database');
    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
    pool.query = originalQuery;
  });
});
