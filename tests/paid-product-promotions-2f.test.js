import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPromotionByCode,
  getPromotionById,
  createPaidProductPromotion,
  validateProductPromotion,
  recordPromotionRedemption
} from '../src/auth/paidProducts.js';
import { validatePromoCode } from '../src/auth/premium.js';
import { pool } from '../src/db/pool.js';

test('Phase 2F-1 - Database-Backed Promotions & Validation Checks', async (t) => {

  await t.test('1. getPromotionByCode fetches correct promotions case-insensitively', async () => {
    const mockPromo = { id: 10, code: 'FIRST50', product_id: 1, discount_type: 'percentage', discount_value: 50 };
    const mockClient = {
      query: async (sql, params = []) => {
        assert.ok(sql.includes('paid_product_promotions'), 'Must query promotions table');
        assert.equal(params[0], 'FIRST50', 'Must look up matching upper cased code');
        return { rows: [mockPromo], rowCount: 1 };
      }
    };

    const promo = await getPromotionByCode('first50', mockClient);
    assert.deepEqual(promo, mockPromo);

    // Empty handles
    const promoEmpty = await getPromotionByCode(null, mockClient);
    assert.equal(promoEmpty, null);
  });

  await t.test('2. getPromotionById fetches promotion correctly', async () => {
    const mockPromo = { id: 25, code: 'SAVE10', product_id: 2, discount_type: 'flat', discount_value: 1000 };
    const mockClient = {
      query: async (sql, params = []) => {
        assert.ok(sql.includes('paid_product_promotions'), 'Must query promotions table');
        assert.equal(params[0], 25, 'Must look up by ID');
        return { rows: [mockPromo], rowCount: 1 };
      }
    };

    const promo = await getPromotionById(25, mockClient);
    assert.deepEqual(promo, mockPromo);
  });

  await t.test('3. createPaidProductPromotion performs correct insertions', async () => {
    const mockClient = {
      query: async (sql, params = []) => {
        assert.ok(sql.includes('INSERT INTO paid_product_promotions'), 'Must perform INSERT');
        assert.equal(params[0], 'SUPERDEAL', 'Must insert correct uppercase code');
        assert.equal(params[1], 100, 'Must insert correct product ID');
        assert.equal(params[2], 'percentage', 'Must insert correct discount type');
        assert.equal(params[3], 25, 'Must insert correct discount value');
        assert.equal(params[4], 14, 'Must insert eligibility days');
        assert.equal(params[5], 200, 'Must insert max redemptions limit');
        assert.equal(params[8], true, 'Must insert enabled state');
        assert.equal(params[9], 'off_super', 'Must insert recurring offer ID');
        return { rows: [{ id: 99, code: 'SUPERDEAL' }], rowCount: 1 };
      }
    };

    const res = await createPaidProductPromotion({
      code: 'superdeal',
      productId: 100,
      discountType: 'percentage',
      discountValue: 25,
      eligibilityDays: 14,
      maxRedemptions: 200,
      isEnabled: true,
      recurringOfferId: 'off_super'
    }, mockClient);

    assert.equal(res.id, 99);
    assert.equal(res.code, 'SUPERDEAL');
  });

  await t.test('4. validateProductPromotion fails gracefully when promo does not exist and env fallback empty', async () => {
    const mockClient = {
      query: async (sql, params) => {
        // Return nothing for product lookup or promotion lookup
        return { rows: [], rowCount: 0 };
      }
    };

    const result = await validateProductPromotion(1, 'MISSINGCODE', 1, 'one_time', mockClient);
    assert.equal(result.valid, false);
    assert.match(result.error, /invalid or expired/);
  });

  await t.test('5. validateProductPromotion checks product scope and is_enabled state', async () => {
    const inactivePromo = { id: 1, code: 'PROMO1', product_id: 1, is_enabled: false };
    const wrongProductPromo = { id: 2, code: 'PROMO2', product_id: 99, is_enabled: true };

    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) {
          if (params[0] === 'PROMO1') return { rows: [inactivePromo], rowCount: 1 };
          if (params[0] === 'PROMO2') return { rows: [wrongProductPromo], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res1 = await validateProductPromotion(1, 'PROMO1', 1, 'one_time', mockClient);
    assert.equal(res1.valid, false);
    assert.match(res1.error, /invalid or expired/);

    const res2 = await validateProductPromotion(1, 'PROMO2', 1, 'one_time', mockClient);
    assert.equal(res2.valid, false);
    assert.match(res2.error, /not applicable to this product/);
  });

  await t.test('6. validateProductPromotion respects validity dates', async () => {
    const futurePromo = {
      id: 3,
      code: 'FUTURE',
      product_id: 1,
      is_enabled: true,
      valid_from: new Date(Date.now() + 86400000), // tomorrow
      valid_until: new Date(Date.now() + 172800000)
    };
    const pastPromo = {
      id: 4,
      code: 'PAST',
      product_id: 1,
      is_enabled: true,
      valid_from: new Date(Date.now() - 172800000),
      valid_until: new Date(Date.now() - 86400000) // yesterday
    };

    const mockClient = {
      query: async (sql, params) => {
        if (params[0] === 'FUTURE') return { rows: [futurePromo], rowCount: 1 };
        if (params[0] === 'PAST') return { rows: [pastPromo], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };

    const res1 = await validateProductPromotion(1, 'FUTURE', 1, 'one_time', mockClient);
    assert.equal(res1.valid, false);
    assert.match(res1.error, /not active yet/);

    const res2 = await validateProductPromotion(1, 'PAST', 1, 'one_time', mockClient);
    assert.equal(res2.valid, false);
    assert.match(res2.error, /invalid or expired/);
  });

  await t.test('7. validateProductPromotion checks user registration age eligibility', async () => {
    const eligiblePromo = { id: 5, code: 'NEWUSERS', product_id: 1, is_enabled: true, eligibility_days: 7 };
    const mockUserNew = { created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000) }; // 2 days old
    const mockUserOld = { created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000) }; // 10 days old

    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) {
          return { rows: [eligiblePromo], rowCount: 1 };
        }
        if (sql.includes('FROM users')) {
          const uId = params[0];
          if (uId === 101) return { rows: [mockUserNew], rowCount: 1 };
          if (uId === 102) return { rows: [mockUserOld], rowCount: 1 };
        }
        if (sql.includes('paid_product_promo_redemptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const res1 = await validateProductPromotion(101, 'NEWUSERS', 1, 'one_time', mockClient);
    assert.equal(res1.valid, true);

    const res2 = await validateProductPromotion(102, 'NEWUSERS', 1, 'one_time', mockClient);
    assert.equal(res2.valid, false);
    assert.match(res2.error, /no longer eligible/);
  });

  await t.test('8. validateProductPromotion blocks user double-redemptions and respects max usage limit', async () => {
    const promo = { id: 6, code: 'LIMITED', product_id: 1, is_enabled: true, max_redemptions: 5 };
    const mockUser = { created_at: new Date() };

    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) {
          return { rows: [promo], rowCount: 1 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [mockUser], rowCount: 1 };
        }
        if (sql.includes('paid_product_promo_redemptions')) {
          // Check if it's counting total redemptions or looking up user-specific
          if (sql.includes('COUNT(*)')) {
            return { rows: [{ count: 5 }], rowCount: 1 }; // Max limit reached
          }
          if (sql.includes('user_id = $1')) {
            return { rows: [{ id: 999 }], rowCount: 1 }; // Already redeemed
          }
        }
        return { rows: [], rowCount: 0 };
      }
    };

    // User already redeemed block
    const resAlready = await validateProductPromotion(10, 'LIMITED', 1, 'one_time', {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) return { rows: [promo], rowCount: 1 };
        if (sql.includes('FROM users')) return { rows: [mockUser], rowCount: 1 };
        if (sql.includes('paid_product_promo_redemptions') && sql.includes('user_id = $1')) {
          return { rows: [{ id: 999 }], rowCount: 1 }; // already redeemed
        }
        return { rows: [], rowCount: 0 };
      }
    });
    assert.equal(resAlready.valid, false);
    assert.match(resAlready.error, /already redeemed/);

    // Max limit block
    const resMax = await validateProductPromotion(10, 'LIMITED', 1, 'one_time', {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) return { rows: [promo], rowCount: 1 };
        if (sql.includes('FROM users')) return { rows: [mockUser], rowCount: 1 };
        if (sql.includes('paid_product_promo_redemptions')) {
          if (sql.includes('user_id = $1')) return { rows: [], rowCount: 0 }; // first time for user
          if (sql.includes('COUNT(*)')) return { rows: [{ count: 5 }], rowCount: 1 }; // but total is 5
        }
        return { rows: [], rowCount: 0 };
      }
    });
    assert.equal(resMax.valid, false);
    assert.match(resMax.error, /maximum usage limit/);
  });

  await t.test('9. validateProductPromotion checks recurring billing subscription offer restrictions', async () => {
    const promoNoRecurring = { id: 7, code: 'PASSONLY', product_id: 1, is_enabled: true, recurring_offer_id: null };
    const promoWithRecurring = { id: 8, code: 'RECURRINGOK', product_id: 1, is_enabled: true, recurring_offer_id: 'offer_test' };
    const mockUser = { created_at: new Date() };

    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('paid_product_promotions')) {
          if (params[0] === 'PASSONLY') return { rows: [promoNoRecurring], rowCount: 1 };
          if (params[0] === 'RECURRINGOK') return { rows: [promoWithRecurring], rowCount: 1 };
        }
        if (sql.includes('FROM users')) return { rows: [mockUser], rowCount: 1 };
        if (sql.includes('paid_product_promo_redemptions')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }
    };

    const res1 = await validateProductPromotion(1, 'PASSONLY', 1, 'recurring', mockClient);
    assert.equal(res1.valid, false);
    assert.match(res1.error, /cannot be applied to recurring subscriptions/);

    const res2 = await validateProductPromotion(1, 'RECURRINGOK', 1, 'recurring', mockClient);
    assert.equal(res2.valid, true);
    assert.equal(res2.promo.recurring_offer_id, 'offer_test');
  });

  await t.test('10. recordPromotionRedemption records securely into both ledger tables', async () => {
    let savedGeneric = null;
    let savedLegacy = null;

    const mockPromo = { id: 500, code: 'PROMO500' };

    const mockClient = {
      query: async (sql, params = []) => {
        if (sql.includes('paid_product_promotions') && sql.includes('id = $1')) {
          return { rows: [mockPromo], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO paid_product_promo_redemptions')) {
          savedGeneric = params;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO premium_promo_redemptions')) {
          savedLegacy = params;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    await recordPromotionRedemption({
      userId: 44,
      promotionIdOrCode: 500,
      providerReference: 'ref_123',
      originalAmount: 10000,
      discountAmount: 5000,
      finalAmount: 5000
    }, mockClient);

    assert.ok(savedGeneric, 'Should insert into paid_product_promo_redemptions');
    assert.equal(savedGeneric[0], 44);
    assert.equal(savedGeneric[1], 500);
    assert.equal(savedGeneric[2], 'ref_123');
    assert.equal(savedGeneric[3], 10000);
    assert.equal(savedGeneric[4], 5000);
    assert.equal(savedGeneric[5], 5000);

    assert.ok(savedLegacy, 'Should insert into legacy premium_promo_redemptions table for backwards compatibility');
    assert.equal(savedLegacy[0], 44);
    assert.equal(savedLegacy[1], 'PROMO500');
    assert.equal(savedLegacy[2], 'ref_123');
    assert.equal(savedLegacy[3], 10000);
    assert.equal(savedLegacy[4], 5000);
    assert.equal(savedLegacy[5], 5000);
  });

  await t.test('11. validatePromoCode integrates cleanly with premium product lookup and returns legacy schemas', async () => {
    const mockProduct = { id: 777, code: 'PREMIUM' };
    const mockPromo = { id: 888, code: 'DBFIRST50', product_id: 777, discount_type: 'percentage', discount_value: 50, recurring_offer_id: 'offer_first50', is_enabled: true };
    const mockUser = { created_at: new Date() };

    const mockClient = {
      query: async (sql, params = []) => {
        if (sql.includes('paid_products') && sql.includes('code = $1')) {
          return { rows: [mockProduct], rowCount: 1 };
        }
        if (sql.includes('paid_product_promotions') && sql.includes('UPPER(code) = $1')) {
          return { rows: [mockPromo], rowCount: 1 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [mockUser], rowCount: 1 };
        }
        if (sql.includes('paid_product_promo_redemptions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    // Replace global pool with our mock pool temporarily during premium validatePromoCode execution
    const originalQuery = pool.query;
    pool.query = mockClient.query;

    try {
      const result = await validatePromoCode(1, 'DBFIRST50', 'recurring');
      assert.equal(result.valid, true);
      assert.equal(result.baseAmount, 300);
      assert.equal(result.discountAmount, 150);
      assert.equal(result.finalAmount, 150);
      assert.equal(result.recurringOfferId, 'offer_first50');
      assert.equal(result.promo.code, 'DBFIRST50');
      assert.equal(result.promo.type, 'percentage');
      assert.equal(result.promo.value, 50);
    } finally {
      pool.query = originalQuery;
    }
  });

});
