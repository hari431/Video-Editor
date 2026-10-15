import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const USER_SID = 'customer-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const CUSTOMER_USER = {
  id: 42, google_user_id: 'google-customer', email: 'customer@example.com', name: 'Jane Customer',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000), app_role: 'MEMBER', premium_source: null
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    // 1. Session check
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === USER_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: CUSTOMER_USER.id }})}]};
      return { rows: [] };
    }
    if (/UPDATE ["']?user_sessions["']?/i.test(sql)) {
      return { rows: [{ sid: 'customer-sid' }] };
    }

    // 2. User fetch
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === CUSTOMER_USER.id) return { rows: [CUSTOMER_USER] };
      return { rows: [] };
    }
    if (/SELECT created_at FROM users/i.test(sql)) {
      return { rows: [{ created_at: new Date() }], rowCount: 1 };
    }

    // 3. User roles / permissions defaults
    if (/user_roles/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/folder_permissions/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/ad_settings/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // 4. Products list
    if (/FROM paid_products/i.test(sql) && !/paid_product_plans/.test(sql) && !/user_product_grants/.test(sql)) {
      return {
        rows: [
          { id: 101, code: 'TEST_PROD_A', name: 'Test Product A', description: 'Interactive course module A', max_active_members: null }
        ],
        rowCount: 1
      };
    }


    if (/SELECT g\.id, g\.valid_until/.test(sql)) {
      return {
        rows: [
          { id: 1001, valid_until: null, status: 'active', product_name: 'Test Product A', product_code: 'TEST_PROD_A', plan_name: 'Lifetime', billing_type: 'one_time' }
        ],
        rowCount: 1
      };
    }
    if (/SELECT id, current_period_end FROM premium_subscriptions/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // 5. Product plans list & single select join
    if (/paid_product_plans/i.test(sql)) {
      if (/product_id = \$1/i.test(sql)) {
        return {
          rows: [
            { id: 201, product_id: 101, code: 'PLAN_MONTHLY', name: 'Monthly Access', billing_type: 'recurring', price_amount_paise: 30000, currency: 'INR', duration_days: 30, razorpay_plan_id: 'rzp_plan_abc' },
            { id: 202, product_id: 101, code: 'PLAN_PASS', name: '3-Day Pass', billing_type: 'one_time', price_amount_paise: 9900, currency: 'INR', duration_days: 3, razorpay_plan_id: null }
          ],
          rowCount: 2
        };
      }
      // Single plan select join
      return {
        rows: [{ id: params[0] || 201, product_id: 101, code: 'PLAN_MONTHLY', name: 'Monthly Access', billing_type: (params[0] === 201 ? 'recurring' : 'one_time'), price_amount_paise: (params[0] === 201 ? 30000 : 9900), currency: 'INR', duration_days: 30, is_active: true, product_enabled: true }],
        rowCount: 1
      };
    }


    // Account active products query
    
    

    // 6. Grants check
    if (/user_product_grants/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // 7. Promotions
    if (/paid_product_promotions/i.test(sql)) {
      if (params[0] === 'SAVE20') {
        return {
          rows: [{ id: 501, code: 'SAVE20', product_id: 101, discount_type: 'percentage', discount_value: 20, eligibility_days: null, max_redemptions: null, is_enabled: true, valid_from: null, valid_until: null, recurring_offer_id: 'offer_rec20' }],
          rowCount: 1
        };
      }
    }
    if (/paid_product_promo_redemptions/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    console.log('Unmocked query in customer plans test:', sql, params);
    return { rows: [], rowCount: 0 };
  };

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
    headers: {
      'Content-Type': 'application/json',
      'Cookie': USER_COOKIE
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('Customer-Facing Paid Products & Plans Presentation Suite', async (t) => {

  await t.test('1. GET /plans displays active products, their respective plans, prices, and entitlement status when PAID_PLANS_ENABLED=true', async () => {
    process.env.PAID_PLANS_ENABLED = 'true';
    const { status, html } = await httpGet('/plans');
    assert.equal(status, 200);
    assert.match(html, /Test Product A/);
    assert.match(html, /Monthly Access/);
    assert.match(html, /₹300\.00/);
    assert.match(html, /3-Day Pass/);
    assert.match(html, /₹99\.00/);
    assert.match(html, /AVAILABLE TO PURCHASE/);
    assert.match(html, /💎 Available Plans/);
  });

  await t.test('1b. GET /plans is blocked and link is hidden when PAID_PLANS_ENABLED=false', async () => {
    process.env.PAID_PLANS_ENABLED = 'false';
    const { status, html } = await httpGet('/plans');
    assert.equal(status, 403);
    assert.match(html, /Available plans catalog is currently disabled/);

    // Also verify that the home page does not render the link
    const { html: homeHtml } = await httpGet('/');
    assert.ok(!homeHtml.includes('💎 Available Plans'), 'Should not render Available Plans link when disabled');
  });

  await t.test('1c. Home page renders Available Plans link when PAID_PLANS_ENABLED=true', async () => {
    process.env.PAID_PLANS_ENABLED = 'true';
    const { html: homeHtml } = await httpGet('/');
    assert.ok(homeHtml.includes('💎 Available Plans'), 'Should render Available Plans link when enabled');
  });


  await t.test('4. GET /account renders the My Access page with active paid products', async () => {
    process.env.PAID_PLANS_ENABLED = 'true';
    const { status, html } = await httpGet('/account');
    assert.equal(status, 200);
    assert.match(html, /My Account/);
    assert.match(html, /Jane Customer/);
    assert.match(html, /Test Product A/);
    assert.match(html, /Lifetime/);
    assert.match(html, /One-Time/);
  });

  await t.test('2. POST /api/payments/validate-promo successfully validates active promo codes and applies dynamic discounts', async () => {
    const { status, data } = await httpPost('/api/payments/validate-promo', {
      promoCode: 'SAVE20',
      planId: 201
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'success');
    assert.equal(data.valid, true);
    assert.equal(data.baseAmount, 300); // 300.00 Rupees
    assert.equal(data.discountAmount, 60); // 20% of 300 is 60.00
    assert.equal(data.finalAmount, 240); // 240.00 final price
  });

  await t.test('3. POST /api/payments/validate-promo returns error for missing or invalid params', async () => {
    const { data: missingPromo } = await httpPost('/api/payments/validate-promo', {
      planId: 201
    });
    assert.equal(missingPromo.valid, false);

    const { data: missingPlan } = await httpPost('/api/payments/validate-promo', {
      promoCode: 'SAVE20'
    });
    assert.equal(missingPlan.valid, false);
  });

});
