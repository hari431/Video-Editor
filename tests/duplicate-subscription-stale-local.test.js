import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { getRazorpayClient } from '../src/library/razorpay.js';

const { app } = await import('../src/server.js');

const USER_SID = 'sub-stale-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET || 'test-secret')}`;
const TEST_USER = {
  id: 88, google_user_id: 'google-sub-88', email: 'sub88@example.com', name: 'Sub Tester',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000), app_role: 'MEMBER'
};

let server = null;
let baseUrl = '';
let originalQuery = null;

// Mock context variables
let mockPaidSubRow = null;
let mockGrantRow = null;
let mockProviderSubResponse = null;
let mockProviderFetchErr = null;
let updatedPaidSubStatus = null;
let updatedPremiumSubStatus = null;
let razorpayCreatedSub = null;

test.before(async () => {
  originalQuery = pool.query;

  // Setup Razorpay client mocks
  const rzpClient = getRazorpayClient();
  rzpClient.subscriptions = {
    fetch: async (id) => {
      if (mockProviderFetchErr) throw mockProviderFetchErr;
      return mockProviderSubResponse || { id, status: 'active' };
    },
    create: async (opts) => {
      razorpayCreatedSub = { id: 'sub_new_999', status: 'created', ...opts };
      return razorpayCreatedSub;
    }
  };
  rzpClient.orders = {
    create: async (opts) => {
      return { id: 'order_one_time_123', amount: opts.amount, status: 'created' };
    }
  };

  const mockQuery = async (sql, params = []) => {
    // Session handling
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === USER_SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: TEST_USER.id } }) }] };
      return { rows: [] };
    }
    if (/UPDATE ["']?user_sessions["']?/i.test(sql)) return { rows: [{ sid: USER_SID }] };

    // User lookup
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === TEST_USER.id) return { rows: [TEST_USER] };
      return { rows: [] };
    }

    // Advisory lock & transaction queries
    if (/pg_advisory_xact_lock|BEGIN|COMMIT|ROLLBACK/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // Plan fetch for POST /api/payments/subscribe or create-order
    if (/paid_product_plans/i.test(sql)) {
      const isOneTime = params[0] == 20;
      return {
        rows: [{
          id: isOneTime ? 20 : 10,
          product_id: 5,
          billing_type: isOneTime ? 'one_time' : 'recurring',
          is_active: true,
          price_amount_paise: isOneTime ? 99900 : 49900,
          currency: 'INR',
          razorpay_plan_id: isOneTime ? null : 'plan_test_recur',
          product_code: isOneTime ? 'TEST_ONETIME' : 'TEST_RECURRING',
          product_enabled: true
        }],
        rowCount: 1
      };
    }

    // Duplicate subscription check
    if (/SELECT id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions/i.test(sql)) {
      if (mockPaidSubRow) return { rows: [mockPaidSubRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // Update paid_subscriptions
    if (/UPDATE paid_subscriptions SET status=\$1/i.test(sql)) {
      updatedPaidSubStatus = params[0];
      return { rows: [], rowCount: 1 };
    }

    // Update premium_subscriptions
    if (/UPDATE premium_subscriptions SET status=\$1/i.test(sql)) {
      updatedPremiumSubStatus = params[0];
      return { rows: [], rowCount: 1 };
    }

    // Insert paid_subscriptions
    if (/INSERT INTO paid_subscriptions/i.test(sql)) {
      return { rows: [{ id: 101, status: 'created' }], rowCount: 1 };
    }

    // Validate user entitlement query (grants check)
    if (/user_product_grants/i.test(sql) && /user_id = \$1 AND product_id = \$2/i.test(sql)) {
      if (mockGrantRow) return { rows: [mockGrantRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // Order existence check for one-time
    if (/SELECT id FROM paid_orders WHERE provider_order_id = \$1/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // Insert paid_orders
    if (/INSERT INTO paid_orders/i.test(sql)) {
      return { rows: [{ id: 501 }], rowCount: 1 };
    }

    // Default catch-all
    return { rows: [], rowCount: 0 };
  };

  pool.query = mockQuery;
  pool.connect = async () => ({
    query: mockQuery,
    release: () => {}
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (originalQuery) pool.query = originalQuery;
  if (server) server.close();
});

function resetMocks() {
  mockPaidSubRow = null;
  mockGrantRow = null;
  mockProviderSubResponse = null;
  mockProviderFetchErr = null;
  updatedPaidSubStatus = null;
  updatedPremiumSubStatus = null;
  razorpayCreatedSub = null;
}

test('Stale Local Recurring Subscription Duplicate Checks', async (t) => {

  await t.test('A. created + provider created -> reuse existing created subscription', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 1,
      provider_subscription_id: 'sub_created_123',
      status: 'created',
      cancel_at_period_end: false,
      current_period_end: null
    };
    mockProviderSubResponse = { id: 'sub_created_123', status: 'created' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.reused, true);
    assert.equal(data.subscriptionId, 'sub_created_123');
  });

  await t.test('B. created + provider cancelled -> expire local + create new subscription', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 1,
      provider_subscription_id: 'sub_created_cancelled_123',
      status: 'created',
      cancel_at_period_end: false,
      current_period_end: null
    };
    mockProviderSubResponse = { id: 'sub_created_cancelled_123', status: 'cancelled' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(updatedPaidSubStatus, 'cancelled');
    assert.ok(razorpayCreatedSub);
    assert.equal(data.subscriptionId, 'sub_new_999');
  });

  await t.test('C. active + provider active -> 409 duplicate subscription', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 2,
      provider_subscription_id: 'sub_active_123',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() + 86400000)
    };
    mockProviderSubResponse = { id: 'sub_active_123', status: 'active' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 409);
    assert.match(data.message, /already have a pending or active subscription/i);
    assert.equal(razorpayCreatedSub, null);
  });

  await t.test('D. authenticated + provider active -> 409 duplicate subscription', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 3,
      provider_subscription_id: 'sub_auth_123',
      status: 'authenticated',
      cancel_at_period_end: false,
      current_period_end: null
    };
    mockProviderSubResponse = { id: 'sub_auth_123', status: 'active' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 409);
    assert.match(data.message, /already have a pending or active subscription/i);
    assert.equal(razorpayCreatedSub, null);
  });

  await t.test('E. active + provider cancelled/completed/expired/halted -> new subscription allowed', async () => {
    for (const endedStatus of ['cancelled', 'completed', 'expired', 'halted']) {
      resetMocks();
      mockPaidSubRow = {
        id: 4,
        provider_subscription_id: `sub_stale_${endedStatus}`,
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: new Date(Date.now() - 86400000)
      };
      mockProviderSubResponse = { id: `sub_stale_${endedStatus}`, status: endedStatus };

      const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
        body: JSON.stringify({ planId: 10 })
      });

      const data = await res.json();
      assert.equal(res.status, 200, `Should succeed for provider status ${endedStatus}`);
      const expectedMark = endedStatus === 'cancelled' ? 'cancelled' : 'expired';
      assert.equal(updatedPaidSubStatus, expectedMark);
      assert.ok(razorpayCreatedSub);
      assert.equal(data.subscriptionId, 'sub_new_999');
    }
  });

  await t.test('F. provider fetch failure -> no new subscription allowed', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 5,
      provider_subscription_id: 'sub_fail_123',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: new Date()
    };
    mockProviderFetchErr = new Error('Provider connection error');

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 502);
    assert.equal(data.code, 'PROVIDER_FETCH_FAILED');
    assert.equal(razorpayCreatedSub, null);
  });

  await t.test('G. pending cancellation + active provider -> PENDING_CANCELLATION 409', async () => {
    resetMocks();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    mockPaidSubRow = {
      id: 6,
      provider_subscription_id: 'sub_pending_cancel_123',
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: futureDate
    };
    mockProviderSubResponse = { id: 'sub_pending_cancel_123', status: 'active' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 409);
    assert.equal(data.code, 'PENDING_CANCELLATION');
    assert.equal(data.resumeRequired, true);
    assert.equal(razorpayCreatedSub, null);
  });

  await t.test('H. expired grant + provider active -> still 409', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 7,
      provider_subscription_id: 'sub_provider_active_grant_expired',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() - 86400000)
    };
    // Grant is expired
    mockGrantRow = null; // validateUserEntitlement returns hasEntitlement = false
    mockProviderSubResponse = { id: 'sub_provider_active_grant_expired', status: 'active' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 409);
    assert.match(data.message, /already have a pending or active subscription/i);
    assert.equal(razorpayCreatedSub, null);
  });

  await t.test('I. expired grant + provider ended -> new subscription allowed', async () => {
    resetMocks();
    mockPaidSubRow = {
      id: 8,
      provider_subscription_id: 'sub_provider_ended_grant_expired',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() - 86400000)
    };
    mockGrantRow = null; // grant is expired / missing
    mockProviderSubResponse = { id: 'sub_provider_ended_grant_expired', status: 'cancelled' };

    const res = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(updatedPaidSubStatus, 'cancelled');
    assert.ok(razorpayCreatedSub);
    assert.equal(data.subscriptionId, 'sub_new_999');
  });

  await t.test('J. one-time flow unchanged', async () => {
    resetMocks();
    const res = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 20 })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'success');
    assert.equal(data.orderId, 'order_one_time_123');
  });

});
