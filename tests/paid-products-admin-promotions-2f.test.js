import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

import {
  getAllPromotions,
  getPromotionDetails,
  isPromoCodeDuplicate,
  updatePaidProductPromotion,
  setPromotionEnabled,
  createPaidProductPromotion,
  logPaidProductEvent
} from '../src/auth/paidProducts.js';

test('Phase 2F-2 - Admin Promotion Management UI & DB Integrations', async (t) => {

  await t.test('1. Admin promotions view displays promo configurations, capacity metrics, and edit/toggle actions (with NO delete actions)', () => {
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-promotions.ejs');
    const viewSrc = fs.readFileSync(viewPath, 'utf8');

    // Section and field assertions
    assert.ok(viewSrc.includes('Active Campaigns'), 'Should display Active Campaigns title');
    assert.ok(viewSrc.includes('promo.code'), 'Should display promo code variable');
    assert.ok(viewSrc.includes('promo.discount_type'), 'Should display promo discount type');
    assert.ok(viewSrc.includes('promo.discount_value'), 'Should display promo discount value');
    assert.ok(viewSrc.includes('promo.eligibility_days'), 'Should check promo eligibility limit');
    assert.ok(viewSrc.includes('promo.redemption_count'), 'Should show promo current redemption count');
    assert.ok(viewSrc.includes('promo.max_redemptions'), 'Should display max allowed redemptions');
    
    // UI action links
    assert.ok(viewSrc.includes('/admin/promotions/create'), 'Should link to promotions creation form');
    assert.ok(viewSrc.includes('edit-promo-'), 'Should contain edit promotion links');
    assert.ok(viewSrc.includes('toggle-promo-'), 'Should contain toggle/disable status forms');

    // Safety directive: No delete action forms, routes, or button states
    assert.ok(!viewSrc.includes('delete-promo') && !viewSrc.includes('destroy-promo'), 'Should NOT define or permit promotion delete actions');
  });

  await t.test('2. Admin promotion creation view features correct form inputs and metadata fields', () => {
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-promo-create.ejs');
    const viewSrc = fs.readFileSync(viewPath, 'utf8');

    assert.ok(viewSrc.includes('id="code"'), 'Should contain promo code input field');
    assert.ok(viewSrc.includes('name="product_id"'), 'Should map select tag to product scope');
    assert.ok(viewSrc.includes('id="discount_type"'), 'Should map discount type selector');
    assert.ok(viewSrc.includes('id="discount_value"'), 'Should specify discount value input');
    assert.ok(viewSrc.includes('id="eligibility_days"'), 'Should contain eligibility days constraint input');
    assert.ok(viewSrc.includes('id="max_redemptions"'), 'Should contain max redemptions limit input');
    assert.ok(viewSrc.includes('id="recurring_offer_id"'), 'Should offer optional recurring Razorpay Offer ID field');
  });

  await t.test('3. Admin promotion edit view features warning reminders for live campaigns', () => {
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-promo-edit.ejs');
    const viewSrc = fs.readFileSync(viewPath, 'utf8');

    assert.ok(viewSrc.includes('⚠️ Impactful Change Warnings:'), 'Should display explicit change impact warning guidelines');
    assert.ok(viewSrc.includes('uncheck "Enable promotion" instead of changing settings'), 'Should advise disabling over editing active history');
  });

  await t.test('4. Promotion database access helpers fetch, check duplicate, toggle, and update successfully', async () => {
    const origQuery = pool.query;
    let queriesRun = [];

    const mockPromotions = [
      { id: 21, code: 'SAVE20', product_id: 1, product_name: 'Premium', product_code: 'PREMIUM', discount_type: 'percentage', discount_value: 20, eligibility_days: 7, max_redemptions: 100, is_enabled: true, redemption_count: 5 }
    ];

    const mockPool = {
      query: async (sql, params = []) => {
        queriesRun.push({ sql, params });

        if (sql.includes('SELECT p.*, prod.name as product_name')) {
          return { rows: mockPromotions, rowCount: mockPromotions.length };
        }
        if (sql.includes('SELECT id FROM paid_product_promotions WHERE UPPER(code) = $1')) {
          const code = params[0];
          const prodId = params[1];
          const duplicate = mockPromotions.some(p => p.code === code && Number(p.product_id) === Number(prodId));
          return { rows: duplicate ? [{ id: 21 }] : [], rowCount: duplicate ? 1 : 0 };
        }
        if (sql.includes('UPDATE paid_product_promotions') && sql.includes('is_enabled = $1')) {
          mockPromotions[0].is_enabled = params[0];
          return { rows: [mockPromotions[0]], rowCount: 1 };
        }
        if (sql.includes('UPDATE paid_product_promotions') && sql.includes('discount_type = $3')) {
          assert.equal(params[10], true, 'show_on_payment_screen parameter must be true');
          return { rows: [{ id: params[11], code: params[0], show_on_payment_screen: params[10] }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO paid_product_events')) {
          return { rows: [{ id: 555 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // List
      const list = await getAllPromotions();
      assert.equal(list.length, 1);
      assert.equal(list[0].code, 'SAVE20');
      assert.equal(list[0].redemption_count, 5);

      // Single fetch
      const single = await getPromotionDetails(21);
      assert.equal(single.code, 'SAVE20');

      // Duplicate detection
      const isDup = await isPromoCodeDuplicate('SAVE20', 1);
      assert.equal(isDup, true);
      const isNotDup = await isPromoCodeDuplicate('FRESH_CODE', 1);
      assert.equal(isNotDup, false);

      // Toggle status
      const toggled = await setPromotionEnabled(21, false);
      assert.equal(toggled.is_enabled, false);

      // Update promotion
      const updated = await updatePaidProductPromotion(21, {
        code: 'SAVE30',
        productId: 1,
        discountType: 'percentage',
        discountValue: 30,
        eligibilityDays: 5,
        maxRedemptions: 50,
        validFrom: null,
        validUntil: null,
        isEnabled: true,
        recurringOfferId: 'offer_123',
        showOnPaymentScreen: true
      });
      assert.equal(updated.id, 21);
      assert.equal(updated.show_on_payment_screen, true);

      // Audit tracking
      const event = await logPaidProductEvent({
        productId: 1,
        userId: 1,
        eventType: 'promotion_toggled',
        previousStatus: 'enabled',
        newStatus: 'disabled',
        message: 'Promo toggled'
      });
      assert.equal(event.id, 555);

      const auditWritten = queriesRun.some(q => q.sql.includes('INSERT INTO paid_product_events'));
      assert.ok(auditWritten, 'Audit logs must write to paid_product_events');
    } finally {
      pool.query = origQuery;
    }
  });

});
