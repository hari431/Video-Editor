import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

const USER_SID = 'test-capacity-ui-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const CUSTOMER_USER = {
  id: 222, google_user_id: 'google-222', email: 'capacity-user@example.com', name: 'Capacity Tester',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000), app_role: 'MEMBER'
};

// Mock product and plan configuration
let mockProducts = [];
let mockPlans = [];
let mockGrants = [];

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

    // Fetch enabled products
    if (/paid_products/i.test(sql) && !/paid_product_plans/.test(sql) && !/user_product_grants/.test(sql)) {
      return { rows: mockProducts, rowCount: mockProducts.length };
    }
    // Fetch active plans
    if (/paid_product_plans/i.test(sql) && /WHERE product_id = \$1/.test(sql)) {
      const pid = params[0];
      const prodPlans = mockPlans.filter(p => p.product_id === pid);
      return { rows: prodPlans, rowCount: prodPlans.length };
    }
    // Fetch active unique members for a product
    if (/SELECT DISTINCT user_id FROM user_product_grants/i.test(sql)) {
      const prodId = params[0];
      const now = new Date();
      const activeGrants = mockGrants.filter(g => 
        g.product_id === prodId && 
        g.status === 'active' && 
        (g.valid_until === null || new Date(g.valid_until) > now)
      );
      const uniqueUserIds = Array.from(new Set(activeGrants.map(g => g.user_id)));
      return { rows: uniqueUserIds.map(uid => ({ user_id: uid })), rowCount: uniqueUserIds.length };
    }
    // Check current user entitlement
    if (/FROM user_product_grants/i.test(sql) && /user_id = \$1 AND product_id = \$2/i.test(sql)) {
      const uid = params[0];
      const pid = params[1];
      const now = new Date();
      const activeUserGrants = mockGrants.filter(g =>
        g.user_id === uid &&
        g.product_id === pid &&
        g.status === 'active' &&
        (g.valid_until === null || new Date(g.valid_until) > now)
      );
      return { rows: activeUserGrants, rowCount: activeUserGrants.length };
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

test('Plans Page Capacity UX Restriction Suite', async (t) => {
  process.env.PAID_PLANS_ENABLED = 'true';

  await t.test('1. Product with unlimited capacity should display AVAILABLE TO PURCHASE', async () => {
    mockProducts = [
      { id: 1, code: 'UNLIMITED_PROD', name: 'Unlimited Product', description: 'Unlimited', max_active_members: null }
    ];
    mockPlans = [
      { id: 11, product_id: 1, code: 'UNLIMITED_PLAN', name: 'Unlimited Plan', billing_type: 'one_time', price_amount_paise: 5000, currency: 'INR', duration_days: 30 }
    ];
    mockGrants = [];

    const { html, status } = await httpGet('/plans');
    assert.equal(status, 200);

    // Should render 'AVAILABLE TO PURCHASE'
    assert.match(html, /AVAILABLE TO PURCHASE/);
    assert.doesNotMatch(html, /Currently at Capacity/);

    // Plan selector card should be clickable and have pointer cursor
    assert.match(html, /onclick="selectPlan\(11,/);
    assert.match(html, /cursor: pointer/);
    assert.doesNotMatch(html, /cursor: not-allowed/);

    // Button should be active
    assert.match(html, /Choose Monthly|Get 30 Days|Get Access/);
    assert.doesNotMatch(html, /Currently at Capacity/);
  });

  await t.test('2. Product at capacity should display Currently at Capacity, AT CAPACITY, and disabled buttons', async () => {
    mockProducts = [
      { id: 2, code: 'LIMITED_PROD', name: 'Limited Product', description: 'Limited', max_active_members: 1 }
    ];
    mockPlans = [
      { id: 22, product_id: 2, code: 'LIMITED_PLAN', name: 'Limited Plan', billing_type: 'one_time', price_amount_paise: 10000, currency: 'INR', duration_days: 30 }
    ];
    // 1 active grant exists for a different user, taking up all capacity
    mockGrants = [
      { id: 999, user_id: 99, product_id: 2, plan_id: 22, grant_type: 'one_time_purchase', status: 'active', valid_until: null }
    ];

    const { html, status } = await httpGet('/plans');
    assert.equal(status, 200);

    // Should render 'Currently at Capacity' badge in product header
    assert.match(html, /Currently at Capacity/);
    assert.doesNotMatch(html, /AVAILABLE TO PURCHASE/);

    // Plan card selector box should be disabled with cursor: not-allowed and background: #f8fafc
    assert.match(html, /cursor: not-allowed/);
    assert.doesNotMatch(html, /onclick="selectPlan\(22,/);

    // Should display AT CAPACITY badge
    assert.match(html, /AT CAPACITY/);

    // Should render disabled button with 'Currently at Capacity'
    assert.match(html, /disabled style="[^"]*background: #fef2f2; color: #991b1b;"[^>]*>[^<]*Currently at Capacity/);
  });
});
