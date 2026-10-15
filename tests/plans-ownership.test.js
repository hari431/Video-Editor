import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

const USER_SID = 'test-ownership-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const CUSTOMER_USER = {
  id: 111, google_user_id: 'google-111', email: 'ownership@example.com', name: 'Plan Owner',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000), app_role: 'MEMBER', premium_source: null
};

// Global mock state
let mockActiveGrants = [];
let mockPrimaryGrantType = null;
let mockProducts = [];
let mockPlans = [];

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === USER_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: CUSTOMER_USER.id }})}]};
      return { rows: [] };
    }
    if (/UPDATE ["']?user_sessions["']?/i.test(sql)) return { rows: [{ sid: USER_SID }] };
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === CUSTOMER_USER.id) return { rows: [CUSTOMER_USER] };
      return { rows: [] };
    }
    if (/SELECT created_at FROM users/i.test(sql)) return { rows: [{ created_at: new Date() }], rowCount: 1 };
    if (/user_roles/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/folder_permissions/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/ad_settings/i.test(sql)) return { rows: [], rowCount: 0 };

    if (/paid_products/i.test(sql) && !/paid_product_plans/.test(sql) && !/user_product_grants/.test(sql)) {
      return { rows: mockProducts, rowCount: mockProducts.length };
    }
    if (/paid_product_plans/i.test(sql) && /WHERE product_id = \$1/.test(sql)) {
      const pid = params[0];
      const prodPlans = mockPlans.filter(p => p.product_id === pid);
      return { rows: prodPlans, rowCount: prodPlans.length };
    }
    
    // Entitlement validation queries
    if (/SELECT g\.id/i.test(sql) && /FROM user_product_grants/.test(sql)) {
      return { rows: mockActiveGrants, rowCount: mockActiveGrants.length };
    }
    if (/user_product_grants/i.test(sql) && /user_id/i.test(sql)) {
      return { rows: mockActiveGrants, rowCount: mockActiveGrants.length };
    }
    if (/premium_subscriptions/i.test(sql) || /paid_subscriptions/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    
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

test('Available Plans UI Ownership & Repurchase Logic', async (t) => {
  process.env.PAID_PLANS_ENABLED = 'true';
  
  mockProducts = [
    { id: 1, code: 'PREMIUM', name: 'Premium Membership', description: 'Premium' },
    { id: 2, code: 'WORK_SUPPORT', name: 'Work Support', description: 'Support' }
  ];
  
  mockPlans = [
    { id: 11, product_id: 1, code: 'PREMIUM_REC', name: 'Premium Recurring', billing_type: 'recurring', price_amount_paise: 30000, currency: 'INR', duration_days: 30 },
    { id: 12, product_id: 1, code: 'PREMIUM_ONE', name: 'Premium One-Time', billing_type: 'one_time', price_amount_paise: 9900, currency: 'INR', duration_days: 30 },
    { id: 21, product_id: 2, code: 'WORK_REC', name: 'Work Recurring', billing_type: 'recurring', price_amount_paise: 50000, currency: 'INR', duration_days: 30 },
    { id: 22, product_id: 2, code: 'WORK_ONE', name: 'Work One-Time', billing_type: 'one_time', price_amount_paise: 10000, currency: 'INR', duration_days: 30 }
  ];

  await t.test('1. Premium recurring plan purchased -> recurring plan correctly identified/displayed as owned', async () => {
    mockActiveGrants = [{ id: 1, product_id: 1, plan_id: 11, grant_type: 'subscription_cycle', status: 'active', valid_until: new Date(Date.now() + 86400000) }];
    const { html } = await httpGet('/plans');
    
    // Check that Premium Recurring has "ALREADY OWNED"
    // Extract the div for plan 11 and check its content
    const plan11Match = html.match(/id="plan-box-11"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan11Match);
    assert.match(plan11Match[0], /ALREADY OWNED/);
    
    // Check that Premium One-Time has "UNAVAILABLE" because they own recurring
    const plan12Match = html.match(/id="plan-box-12"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan12Match);
    assert.match(plan12Match[0], /UNAVAILABLE/);
    assert.doesNotMatch(plan12Match[0], /ALREADY OWNED/);
  });

  await t.test('2. Premium one-time plan not purchased -> not falsely marked as owned', async () => {
    mockActiveGrants = [];
    const { html } = await httpGet('/plans');
    
    const plan12Match = html.match(/id="plan-box-12"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan12Match);
    assert.doesNotMatch(plan12Match[0], /ALREADY OWNED/);
    assert.doesNotMatch(plan12Match[0], /UNAVAILABLE/);
  });

  await t.test('3. Premium one-time purchase -> one-time plan correctly identified/displayed as owned', async () => {
    mockActiveGrants = [{ id: 2, product_id: 1, plan_id: 12, grant_type: 'one_time_purchase', status: 'active', valid_until: new Date(Date.now() + 86400000) }];
    const { html } = await httpGet('/plans');
    
    const plan12Match = html.match(/id="plan-box-12"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan12Match);
    assert.match(plan12Match[0], /ALREADY OWNED/);
    
    const plan11Match = html.match(/id="plan-box-11"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan11Match);
    // Recurring is still purchasable if they only have a one-time pass (as per product rules)
    assert.doesNotMatch(plan11Match[0], /ALREADY OWNED/);
    assert.doesNotMatch(plan11Match[0], /UNAVAILABLE/);
  });

  await t.test('4. Work Support recurring purchase -> only Work Support recurring plan is identified as owned', async () => {
    mockActiveGrants = [{ id: 3, product_id: 2, plan_id: 21, grant_type: 'subscription_cycle', status: 'active', valid_until: new Date(Date.now() + 86400000) }];
    const { html } = await httpGet('/plans');
    
    const plan21Match = html.match(/id="plan-box-21"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan21Match);
    assert.match(plan21Match[0], /ALREADY OWNED/);
    
    // Premium plans should be completely unaffected
    const plan11Match = html.match(/id="plan-box-11"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan11Match);
    assert.doesNotMatch(plan11Match[0], /ALREADY OWNED/);
  });

  await t.test('5. Different plan under the same product does not get falsely identified as the purchased plan', async () => {
    mockActiveGrants = [{ id: 3, product_id: 2, plan_id: 22, grant_type: 'one_time_purchase', status: 'active', valid_until: new Date(Date.now() + 86400000) }];
    const { html } = await httpGet('/plans');
    
    const plan22Match = html.match(/id="plan-box-22"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan22Match);
    assert.match(plan22Match[0], /ALREADY OWNED/);

    const plan21Match = html.match(/id="plan-box-21"[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(plan21Match);
    assert.doesNotMatch(plan21Match[0], /ALREADY OWNED/);
  });
});
