import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const USER_SID = 'checkout-promo-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const CUSTOMER_USER = {
  id: 42, google_user_id: 'google-checkout', email: 'checkout@example.com', name: 'Checkout User',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000), app_role: 'MEMBER', premium_source: null
};

let originalQuery = null;
let server = null;
let port = 0;

// In-memory mock promotion data
const DB_PROMOS_PREMIUM = [
  { id: 501, code: 'SAVE20', product_id: 1, discount_type: 'percentage', discount_value: 20, eligibility_days: null, max_redemptions: null, is_enabled: true, valid_from: null, valid_until: null, recurring_offer_id: null, show_on_payment_screen: true, product_name: 'Premium', product_code: 'PREMIUM' },
  { id: 502, code: 'WELCOME10', product_id: 1, discount_type: 'percentage', discount_value: 10, eligibility_days: null, max_redemptions: null, is_enabled: true, valid_from: null, valid_until: null, recurring_offer_id: null, show_on_payment_screen: true, product_name: 'Premium', product_code: 'PREMIUM' }
];

const DB_PROMOS_GENERIC = [
  { id: 601, code: 'PROD20', product_id: 101, discount_type: 'percentage', discount_value: 20, eligibility_days: null, max_redemptions: null, is_enabled: true, valid_from: null, valid_until: null, recurring_offer_id: null, show_on_payment_screen: true, product_name: 'Test Product A', product_code: 'TEST_PROD_A' },
  { id: 602, code: 'PROD50', product_id: 101, discount_type: 'percentage', discount_value: 50, eligibility_days: null, max_redemptions: null, is_enabled: true, valid_from: null, valid_until: null, recurring_offer_id: 'offer_50', show_on_payment_screen: true, product_name: 'Test Product A', product_code: 'TEST_PROD_A' }
];

// User 42 has redeemed SAVE20 (501) and PROD20 (601)
const REDEEMED_PAID_IDS = new Set([501, 601]);
let REDEEMED_LEGACY_CODES = new Set(['SAVE20']);

test.before(async () => {
  originalQuery = pool.query;
  // Save original env for restoration
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === USER_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: CUSTOMER_USER.id }})}]};
      return { rows: [] };
    }
    if (/UPDATE ["']?user_sessions["']?/i.test(sql)) return { rows: [{ sid: USER_SID }] };

    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === CUSTOMER_USER.id) return { rows: [CUSTOMER_USER], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT created_at FROM users/i.test(sql)) {
      return { rows: [{ created_at: new Date() }], rowCount: 1 };
    }
    if (/user_roles/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/folder_permissions/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/ad_settings/i.test(sql)) return { rows: [], rowCount: 0 };

    // Products for /plans
    if (/SELECT id, code, name, description FROM paid_products/i.test(sql)) {
      return { rows: [{ id: 101, code: 'TEST_PROD_A', name: 'Test Product A', description: 'Module' }], rowCount: 1 };
    }
    if (/SELECT g\.id, g\.valid_until/.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT id, current_period_end FROM premium_subscriptions/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM premium_subscriptions/i.test(sql) && sql.includes('provider_subscription_id')) return { rows: [], rowCount: 0 };
    if (/SELECT s\.\*, u\.app_role/i.test(sql)) {
      return { rows: [{ app_role: CUSTOMER_USER.app_role }], rowCount: 1 };
    }

    // Plans for /plans
    if (/paid_product_plans/i.test(sql) && /product_id = \$1/i.test(sql) && !sql.includes('JOIN')) {
      return {
        rows: [
          { id: 201, product_id: 101, code: 'PLAN_MONTHLY', name: 'Monthly', billing_type: 'recurring', price_amount_paise: 30000, currency: 'INR', duration_days: 30, razorpay_plan_id: 'rzp_plan_abc' },
          { id: 202, product_id: 101, code: 'PLAN_PASS', name: '3-Day Pass', billing_type: 'one_time', price_amount_paise: 9900, currency: 'INR', duration_days: 3, razorpay_plan_id: null }
        ],
        rowCount: 2
      };
    }
    if (/SELECT p\.\*, prod\.is_enabled/i.test(sql) || (/paid_product_plans/i.test(sql) && /JOIN paid_products/i.test(sql) && /WHERE p\.id = \$1/i.test(sql))) {
      const pid = params[0];
      return { rows: [{ id: pid || 201, product_id: 101, code: 'PLAN_MONTHLY', name: 'Monthly', billing_type: (pid === 202 ? 'one_time' : 'recurring'), price_amount_paise: (pid === 202 ? 9900 : 30000), currency: 'INR', duration_days: 30, is_active: true, product_enabled: true }], rowCount: 1 };
    }

    if (/user_product_grants/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/paid_subscriptions/i.test(sql) && sql.includes('cancel_at_period_end')) return { rows: [], rowCount: 0 };
    if (/paid_orders/i.test(sql)) return { rows: [], rowCount: 0 };

    // Promotions: distinguish /premium vs /plans by sql content
    if (/paid_product_promotions/i.test(sql) && sql.includes("prod.code = 'PREMIUM'")) {
      // /premium candidates
      return { rows: DB_PROMOS_PREMIUM, rowCount: DB_PROMOS_PREMIUM.length };
    }
    if (/paid_product_promotions/i.test(sql) && sql.includes('p.show_on_payment_screen = TRUE') && !sql.includes("prod.code = 'PREMIUM'")) {
      // /plans candidates
      return { rows: DB_PROMOS_GENERIC, rowCount: DB_PROMOS_GENERIC.length };
    }
    // Generic promotion lookup by code
    if (/paid_product_promotions/i.test(sql) && sql.includes('UPPER(code) = $1')) {
      const code = String(params[0]).toUpperCase();
      const all = [...DB_PROMOS_PREMIUM, ...DB_PROMOS_GENERIC];
      const found = all.find(p => p.code.toUpperCase() === code);
      if (found) return { rows: [found], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    // Promotion by id
    if (/paid_product_promotions/i.test(sql) && sql.includes('WHERE id = $1')) {
      const id = Number(params[0]);
      const all = [...DB_PROMOS_PREMIUM, ...DB_PROMOS_GENERIC];
      const found = all.find(p => p.id === id);
      if (found) return { rows: [found], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // Paid promo redemptions - user redeemed check (filtering)
    if (/SELECT promotion_id FROM paid_product_promo_redemptions WHERE user_id = \$1/i.test(sql)) {
      const uid = Number(params[0]);
      if (uid === CUSTOMER_USER.id) {
        const rows = [...REDEEMED_PAID_IDS].map(id => ({ promotion_id: id }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }

    // COUNT for max_redemptions
    if (/SELECT COUNT\(\*\)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_id = \$1/i.test(sql)) {
      return { rows: [{ count: 0 }], rowCount: 1 };
    }
    // Legacy premium redemptions - user redeemed codes
    if (/SELECT promotion_code FROM premium_promo_redemptions WHERE user_id = \$1/i.test(sql)) {
      const uid = Number(params[0]);
      if (uid === CUSTOMER_USER.id) {
        const rows = [...REDEEMED_LEGACY_CODES].map(code => ({ promotion_code: code }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT COUNT\(\*\)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_code = \$1/i.test(sql)) {
      return { rows: [{ count: 0 }], rowCount: 1 };
    }
    // Validation-specific redemption checks
    if (/SELECT id FROM paid_product_promo_redemptions WHERE user_id = \$1 AND promotion_id = \$2/i.test(sql)) {
      const uid = Number(params[0]); const pid = Number(params[1]);
      if (uid === CUSTOMER_USER.id && REDEEMED_PAID_IDS.has(pid)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    if (/SELECT id FROM premium_promo_redemptions WHERE user_id = \$1 AND promotion_code = \$2/i.test(sql)) {
      const uid = Number(params[0]); const code = String(params[1]).toUpperCase();
      if (uid === CUSTOMER_USER.id && REDEEMED_LEGACY_CODES.has(code)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // paid_products lookup
    if (/SELECT p\.\*, r\.name AS role_name/i.test(sql) && sql.includes('paid_products')) {
      if (params[0] === 'PREMIUM') return { rows: [{ id: 1, code: 'PREMIUM', role_id: 10 }], rowCount: 1 };
      if (Number(params[0]) === 101) return { rows: [{ id: 101, code: 'TEST_PROD_A', role_id: 11 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT id FROM paid_products WHERE code/i.test(sql)) {
      if (params[0] === 'PREMIUM') return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // Fallback empty
    // console.log('Unmocked query:', sql, params);
    return { rows: [], rowCount: 0 };
  };

  // Ensure premium and plans are enabled
  process.env.PAID_PLANS_ENABLED = 'true';
  process.env.PREMIUM_PROMO_CODES_JSON = '[]';

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(() => {
  pool.query = originalQuery;
  if (server) server.close();
});

async function httpGet(path) {
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await fetch(url, { headers: { Cookie: USER_COOKIE } });
  const html = await res.text();
  return { status: res.status, html };
}

async function httpPost(path, body) {
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('Checkout promo UI only - hides already-redeemed promotions', async (t) => {

  await t.test('GET /plans does not display promotions already redeemed by current user, only eligible ones', async () => {
    const { status, html } = await httpGet('/plans');
    assert.equal(status, 200);
    // DB_PROMOS_GENERIC: 601 is redeemed (PROD20), 602 is eligible (PROD50)
    // The HTML renders promo badges via activePromotions.forEach - check that only eligible code appears
    assert.ok(!html.includes('PROD20'), 'Redeemed promo PROD20 should NOT be in Available One-Time Offers');
    assert.ok(html.includes('PROD50'), 'Eligible promo PROD50 should be in Available One-Time Offers');
    // Ensure we do NOT show the redeemed error text in the rendered HTML
    // The error text "already redeemed" should not appear on page load
    assert.ok(!html.toLowerCase().includes('already redeemed'), 'Page should not show already redeemed error');
  });

  await t.test('GET /premium does not display promotions already redeemed by current user', async () => {
    const { status, html } = await httpGet('/premium');
    assert.equal(status, 200);
    // DB_PROMOS_PREMIUM: 501 SAVE20 is redeemed, 502 WELCOME10 is eligible
    assert.ok(!html.includes('SAVE20'), 'Redeemed promo SAVE20 should NOT be in premium Available One-Time Offers');
    assert.ok(html.includes('WELCOME10'), 'Eligible promo WELCOME10 should be in premium Available One-Time Offers');
    assert.ok(!html.toLowerCase().includes('already redeemed'), 'Premium page should not show already redeemed error');
  });

  await t.test('Validation still returns already-redeemed error when code is manually submitted (no behavior change)', async () => {
    // Even though UI hides it, backend validation must still enforce redemption history
    const { data } = await httpPost('/api/payments/validate-promo', { promoCode: 'PROD20', planId: 201 });
    assert.equal(data.valid, false);
    assert.match(data.message, /already redeemed/i);
  });

  await t.test('Validation succeeds for eligible promo', async () => {
    const { data } = await httpPost('/api/payments/validate-promo', { promoCode: 'PROD50', planId: 201 });
    assert.equal(data.valid, true);
  });

  await t.test('GET /premium hides env fallback promos already redeemed by current user', async () => {
    const originalEnv = process.env.PREMIUM_PROMO_CODES_JSON;
    const originalLegacy = new Set(REDEEMED_LEGACY_CODES);
    REDEEMED_LEGACY_CODES.add('ENVREDEEM');
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'ENVREDEEM', type: 'percentage', value: 10, enabled: true },
      { code: 'ENVOK', type: 'percentage', value: 15, enabled: true }
    ]);
    const { status, html } = await httpGet('/premium');
    assert.equal(status, 200);
    assert.ok(!html.includes('ENVREDEEM'), 'Redeemed env promo ENVREDEEM should NOT be in premium Available One-Time Offers');
    assert.ok(html.includes('ENVOK'), 'Eligible env promo ENVOK should be in premium Available One-Time Offers');
    // restore
    REDEEMED_LEGACY_CODES = originalLegacy;
    process.env.PREMIUM_PROMO_CODES_JSON = originalEnv;
  });

});
