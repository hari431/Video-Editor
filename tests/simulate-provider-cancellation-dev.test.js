import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  getRazorpayClient,
  simulateProviderCancellation,
  isSubscriptionSimulatedCancelled,
  clearSimulatedProviderCancellations
} from '../src/library/razorpay.js';

const { app } = await import('../src/server.js');

const USER_SID = 'sim-dev-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET || 'test-secret')}`;
const TEST_USER = {
  id: 99,
  google_user_id: 'google-sim-99',
  email: 'sim99@example.com',
  name: 'Sim Tester',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400 * 1000),
  app_role: 'MEMBER'
};

let server = null;
let baseUrl = '';
let originalQuery = null;
let mockPaidSubRow = null;
let updatedPaidSubStatus = null;
let razorpayCreatedSub = null;

test.before(async () => {
  originalQuery = pool.query;

  // Setup Razorpay client mocks
  const rzpClient = getRazorpayClient();
  rzpClient.subscriptions._mockFetch = async (id) => ({ id, status: 'active', provider_real: true });
  rzpClient.subscriptions.create = async (opts) => {
    razorpayCreatedSub = { id: 'sub_new_sim_999', status: 'created', ...opts };
    return razorpayCreatedSub;
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
    if (/FROM ["']?users["']?/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
      return { rows: [TEST_USER], rowCount: 1 };
    }

    // Plan fetch
    if (/paid_product_plans/i.test(sql)) {
      return {
        rows: [{
          id: 10,
          product_id: 5,
          billing_type: 'recurring',
          is_active: true,
          price_amount_paise: 49900,
          currency: 'INR',
          razorpay_plan_id: 'plan_test_sim',
          product_code: 'TEST_PRODUCT',
          product_enabled: true
        }],
        rowCount: 1
      };
    }

    // Existing active paid subscription check
    if (/paid_subscriptions/i.test(sql) && /user_id\s*=\s*\$1/i.test(sql) && /product_id\s*=\s*\$2/i.test(sql)) {
      if (mockPaidSubRow) return { rows: [mockPaidSubRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    // Premium subscriptions fallback
    if (/premium_subscriptions/i.test(sql) && /WHERE user_id = \$1/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // Update paid_subscriptions status
    if (/UPDATE paid_subscriptions SET status/i.test(sql)) {
      updatedPaidSubStatus = params[0];
      return { rows: [], rowCount: 1 };
    }

    // Update premium_subscriptions status
    if (/UPDATE premium_subscriptions SET status/i.test(sql)) {
      return { rows: [], rowCount: 1 };
    }

    // Validate user entitlement query (grants check)
    if (/user_product_grants/i.test(sql) && /user_id = \$1 AND product_id = \$2/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // Insert new subscription
    if (/INSERT INTO paid_subscriptions/i.test(sql)) {
      return { rows: [{ id: 701 }], rowCount: 1 };
    }

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
  if (server) await new Promise((resolve) => server.close(resolve));
  clearSimulatedProviderCancellations();
});

test.beforeEach(() => {
  clearSimulatedProviderCancellations();
  mockPaidSubRow = null;
  updatedPaidSubStatus = null;
  razorpayCreatedSub = null;
});

test('1. Simulation is local/dev-only', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    for (const invalidEnv of ['production', 'staging', undefined]) {
      if (invalidEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = invalidEnv;
      }

      // Function call throws error in non-allowed environment
      assert.throws(
        () => simulateProviderCancellation('sub_invalid_123'),
        /Simulation controls are strictly disabled/i
      );

      // API endpoint rejects request with 403 in non-allowed environment
      const res = await fetch(`${baseUrl}/api/dev/simulate-provider-cancellation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
        body: JSON.stringify({ subscriptionId: 'sub_invalid_123' })
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.status, 'error');
    }
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('2. Provider fetch returns cancelled for the simulated subscription in dev mode', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';

    simulateProviderCancellation('sub_dev_test_100');
    assert.strictEqual(isSubscriptionSimulatedCancelled('sub_dev_test_100'), true);

    const sub = await getRazorpayClient().subscriptions.fetch('sub_dev_test_100');
    assert.strictEqual(sub.id, 'sub_dev_test_100');
    assert.strictEqual(sub.status, 'cancelled');
    assert.strictEqual(sub.simulated, true);

    // Unsimulated subscription ID returns real active status
    const unsimulated = await getRazorpayClient().subscriptions.fetch('sub_real_200');
    assert.strictEqual(unsimulated.status, 'active');
    assert.strictEqual(unsimulated.simulated, undefined);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('3. Existing subscribe flow then allows a new recurring subscription after simulation', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';

    mockPaidSubRow = {
      id: 55,
      provider_subscription_id: 'sub_stale_local_55',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() - 3600 * 1000)
    };

    // First attempt before simulation -> rejected with 409 duplicate subscription
    const res1 = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });
    assert.strictEqual(res1.status, 409);

    // Trigger simulation for the user's product/subscription
    const simRes = await fetch(`${baseUrl}/api/dev/simulate-provider-cancellation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ productId: 5 })
    });
    assert.strictEqual(simRes.status, 200);
    const simData = await simRes.json();
    assert.strictEqual(simData.status, 'success');
    assert.strictEqual(simData.subscriptionId, 'sub_stale_local_55');

    // Second subscribe attempt after simulation -> succeeds with new subscription!
    const res2 = await fetch(`${baseUrl}/api/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
      body: JSON.stringify({ planId: 10 })
    });
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.strictEqual(data2.status, 'success');
    assert.strictEqual(data2.subscriptionId, 'sub_new_sim_999');
    assert.strictEqual(updatedPaidSubStatus, 'cancelled');
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('4. Simulation cannot affect production behavior', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    // Enable simulation in dev mode
    process.env.NODE_ENV = 'development';
    simulateProviderCancellation('sub_prod_isolation_77');
    assert.strictEqual(isSubscriptionSimulatedCancelled('sub_prod_isolation_77'), true);

    // Switch to production mode
    process.env.NODE_ENV = 'production';

    // isSubscriptionSimulatedCancelled returns false in production
    assert.strictEqual(isSubscriptionSimulatedCancelled('sub_prod_isolation_77'), false);

    // Provider fetch ignores simulation and calls real fetch
    const sub = await getRazorpayClient().subscriptions.fetch('sub_prod_isolation_77');
    assert.strictEqual(sub.status, 'active');
    assert.strictEqual(sub.simulated, undefined);
    assert.strictEqual(sub.provider_real, true);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
