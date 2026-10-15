import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { isPremiumMembershipEnabled } from '../src/library/razorpay.js';
import { syncUserPremiumRole, handleSubscriptionWebhook } from '../src/auth/premium.js';

test('Premium Membership Infrastructure - Regression & Unit Tests', async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  let userDatabase = {};
  let subscriptionDatabase = {};
  let subscriptionEvents = [];
  let userAuditLog = [];

  const resetMockDatabases = () => {
    userDatabase = {
      100: { id: 100, email: 'normal@example.com', app_role: 'USER', premium_source: null, access_expires_at: null },
      101: { id: 101, email: 'manual@example.com', app_role: 'PREMIUM', premium_source: 'manual', access_expires_at: null },
      102: { id: 102, email: 'sub@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: new Date(Date.now() + 25 * 24 * 3600 * 1000) },
      103: { id: 103, email: 'owner@example.com', app_role: 'OWNER', premium_source: null, access_expires_at: null }
    };
    subscriptionDatabase = {
      'sub_102': {
        id: 50,
        user_id: 102,
        provider: 'razorpay',
        provider_subscription_id: 'sub_102',
        status: 'active',
        current_period_start: new Date(Date.now() - 5 * 24 * 3600 * 1000),
        current_period_end: new Date(Date.now() + 25 * 24 * 3600 * 1000),
        cancel_at_period_end: false,
        updated_at: new Date()
      },
      'sub_100': {
        id: 51,
        user_id: 100,
        provider: 'razorpay',
        provider_subscription_id: 'sub_100',
        status: 'active',
        current_period_start: new Date(Date.now() - 5 * 24 * 3600 * 1000),
        current_period_end: new Date(Date.now() + 25 * 24 * 3600 * 1000),
        cancel_at_period_end: false,
        updated_at: new Date()
      }
    };
    subscriptionEvents = [];
    userAuditLog = [];
  };

  const mockClient = {
    query: async (sql, params = []) => {
      return pool.query(sql, params);
    },
    release: () => {}
  };

  test.beforeEach(() => {
    resetMockDatabases();
    
    // Wire up mock queries to intercept DB operations
    pool.query = async (sql, params = []) => {
      // 1. Fetch user query
      if (sql.includes('SELECT premium_source') || sql.includes('SELECT id, email, status, access_expires_at') || sql.includes('SELECT * FROM users WHERE id =') || (sql.includes('FROM users') && sql.includes('WHERE id = $1') && !sql.includes('UPDATE'))) {
        const u = userDatabase[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      
      // 2. Fetch subscriptions query for sync logic and webhooks
      if (sql.includes('FROM premium_subscriptions') && !sql.includes('INSERT') && !sql.includes('UPDATE')) {
        if (sql.includes('WHERE user_id =')) {
          const userId = params[0];
          let subs = Object.values(subscriptionDatabase).filter(s => s.user_id === userId);
          if (sql.includes('active') && sql.includes('authenticated')) {
            subs = subs.filter(s => s.status === 'active' || s.status === 'authenticated');
          }
          return { rows: subs, rowCount: subs.length };
        }
        if (sql.includes('WHERE provider_subscription_id =')) {
          const providerSubId = params[0];
          const sub = subscriptionDatabase[providerSubId];
          return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
        }
      }

      // 2.5 Mock SELECT check for subscription events (Idempotency check)
      if (sql.includes('FROM premium_subscription_events') && !sql.includes('INSERT')) {
        let events = subscriptionEvents;
        
        if (sql.includes('subscription_id =')) {
          const subIdParam = params[0];
          events = events.filter(e => e.params[1] === subIdParam);
        } else {
          const userIdParam = params[0];
          events = events.filter(e => e.params[0] === userIdParam);
        }
        
        if (sql.includes('message LIKE') || sql.includes('provider_event_id =')) {
          const searchPattern = params[1]; // message pattern, e.g. %Period End: ...% or %Payment ID: %
          const eventIdParam = params[2];  // event id param
          
          events = events.filter(ev => {
            const evMsg = ev.params[6] || '';
            const evEventId = ev.params[3] || '';
            
            // Format match check
            const cleanPattern = searchPattern ? searchPattern.replace(/%/g, '') : '';
            const matchesMsg = cleanPattern ? evMsg.includes(cleanPattern) : false;
            const matchesEventId = eventIdParam ? evEventId === eventIdParam : false;
            
            return matchesMsg || matchesEventId;
          });
        }
        return { rows: events, rowCount: events.length };
      }

      // 3. Update user role / source query
      if (sql.includes('UPDATE users')) {
        const idParam = params[0];
        const u = userDatabase[idParam];
        if (u) {
          if (sql.includes("app_role = 'PREMIUM'")) {
            u.app_role = 'PREMIUM';
          }
          if (sql.includes("app_role = 'USER'")) {
            u.app_role = 'USER';
          }
          if (sql.includes("premium_source = 'subscription'")) {
            u.premium_source = 'subscription';
          }
          if (sql.includes("premium_source = 'manual'")) {
            u.premium_source = 'manual';
          }
          if (sql.includes("premium_source = NULL")) {
            u.premium_source = null;
          }
          if (sql.includes("access_expires_at = COALESCE")) {
            const currentExpiry = u.access_expires_at;
            const now = new Date();
            const baseDate = (currentExpiry && currentExpiry > now) ? currentExpiry : now;
            u.access_expires_at = new Date(baseDate.getTime() + parseInt(params[1] || 15, 10) * 24 * 3600 * 1000);
          }
          return { rows: [u], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 4. Role audit log query
      if (sql.includes('INSERT INTO role_audit_log')) {
        userAuditLog.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }

      // 5. Subscription event log query
      if (sql.includes('INSERT INTO premium_subscription_events')) {
        subscriptionEvents.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }

      // 6. Subscription insert/update query
      if (sql.includes('INSERT INTO premium_subscriptions') || sql.includes('UPDATE premium_subscriptions')) {
        let providerSubId;
        let status;
        let userId;
        let sub;
        
        if (sql.includes('INSERT INTO premium_subscriptions')) {
          userId = params[0];
          providerSubId = params[2];
          status = params[4];
          
          subscriptionDatabase[providerSubId] = {
            id: Math.floor(Math.random() * 1000) + 100,
            user_id: userId,
            provider: 'razorpay',
            provider_subscription_id: providerSubId,
            status: status,
            current_period_start: params[5],
            current_period_end: params[6],
            cancel_at_period_end: params[7],
            updated_at: new Date()
          };
          sub = subscriptionDatabase[providerSubId];
        } else {
          // UPDATE
          if (sql.includes('WHERE id =')) {
            const dbId = params[params.length - 1];
            sub = Object.values(subscriptionDatabase).find(s => s.id === dbId);
            if (sub) {
              sub.status = params[0];
              sub.current_period_start = params[1];
              sub.current_period_end = params[2];
              sub.cancel_at_period_end = params[3];
              sub.updated_at = new Date();
            }
          } else if (sql.includes('WHERE provider_subscription_id =')) {
            providerSubId = params[params.length - 1];
            sub = subscriptionDatabase[providerSubId];
            if (sub) {
              sub.status = params[0];
              sub.updated_at = new Date();
            }
          }
        }
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }

      // Fallback
      return { rows: [], rowCount: 0 };
    };

    pool.connect = async () => {
      return mockClient;
    };
  });

  test.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  await t.test('1. Master Feature Flag check', async () => {
    const expectedValue = process.env.PREMIUM_MEMBERSHIP_ENABLED === 'true';
    assert.equal(isPremiumMembershipEnabled(), expectedValue);
  });

  await t.test('2. syncUserPremiumRole: User with active subscription gets PREMIUM', async () => {
    subscriptionDatabase['sub_100'] = {
      id: 51,
      user_id: 100,
      provider: 'razorpay',
      provider_subscription_id: 'sub_100',
      status: 'active',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 15 * 24 * 3600 * 1000),
      cancel_at_period_end: false,
      updated_at: new Date()
    };

    await syncUserPremiumRole(100);

    assert.equal(userDatabase[100].app_role, 'PREMIUM');
    assert.equal(userDatabase[100].premium_source, 'subscription');
    
    const audit = userAuditLog.find(l => l.sql.includes('grant_premium'));
    assert.ok(audit);
  });

  await t.test('3. syncUserPremiumRole: Manual premium remains protected even if subscription is cancelled', async () => {
    subscriptionDatabase['sub_101'] = {
      id: 52,
      user_id: 101,
      provider: 'razorpay',
      provider_subscription_id: 'sub_101',
      status: 'cancelled',
      current_period_start: new Date(Date.now() - 15 * 24 * 3600 * 1000),
      current_period_end: new Date(Date.now() - 1 * 24 * 3600 * 1000),
      cancel_at_period_end: true,
      updated_at: new Date()
    };

    await syncUserPremiumRole(101);

    assert.equal(userDatabase[101].app_role, 'PREMIUM');
    assert.equal(userDatabase[101].premium_source, 'manual');
  });

  await t.test('4. syncUserPremiumRole: Subscription cancellation revokes role if not manually premium', async () => {
    subscriptionDatabase['sub_102'].status = 'cancelled';
    subscriptionDatabase['sub_102'].current_period_end = new Date(Date.now() - 1000);

    await syncUserPremiumRole(102);

    assert.equal(userDatabase[102].app_role, 'USER');
    assert.equal(userDatabase[102].premium_source, null);
  });

  await t.test('5. Webhook: subscription.activated event processes successfully and grants premium', async () => {
    const webhookPayload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          plan_id: 'plan_test_300',
          customer_id: 'cust_abc123',
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor((Date.now() + 15 * 24 * 3600 * 1000) / 1000),
          notes: {
            user_id: '100'
          }
        }
      }
    };

    await handleSubscriptionWebhook(webhookPayload, 'evt_web_123', 'subscription.activated');

    const localSub = subscriptionDatabase['sub_100'];
    assert.ok(localSub);
    assert.equal(localSub.status, 'active');
    assert.equal(userDatabase[100].app_role, 'PREMIUM');
  });

  await t.test('6. Webhook: Idempotency protects against out-of-order or stale events', async () => {
    const stalePayload = {
      subscription: {
        entity: {
          id: 'sub_102',
          status: 'authenticated',
          plan_id: 'plan_test_300',
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor((Date.now() + 15 * 24 * 3600 * 1000) / 1000),
          notes: {
            user_id: '102'
          }
        }
      }
    };

    await handleSubscriptionWebhook(stalePayload, 'evt_stale_999', 'subscription.authenticated');
    assert.equal(subscriptionDatabase['sub_102'].status, 'active');
  });

  // ── NEW EXTENSION BUSINESS RULE REGRESSION TESTS ──────────────────────────

  await t.test('7. Entitlement: Future expiry + 15 days', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 3600 * 1000); // 10 days in the future
    userDatabase[100].access_expires_at = futureDate;

    const payload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          notes: { user_id: '100' }
        }
      },
      payment: {
        entity: {
          id: 'pay_future_111',
          status: 'captured'
        }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_future_111', 'subscription.charged');

    const expected = new Date(futureDate.getTime() + 15 * 24 * 3600 * 1000);
    assert.ok(userDatabase[100].access_expires_at instanceof Date);
    assert.ok(Math.abs(userDatabase[100].access_expires_at.getTime() - expected.getTime()) < 1000);
  });

  await t.test('8. Entitlement: Today\'s expiry + 15 days', async () => {
    const todayDate = new Date();
    userDatabase[100].access_expires_at = todayDate;

    const payload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          notes: { user_id: '100' }
        }
      },
      payment: {
        entity: {
          id: 'pay_today_222',
          status: 'captured'
        }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_today_222', 'subscription.charged');

    const expected = new Date(Date.now() + 15 * 24 * 3600 * 1000);
    assert.ok(Math.abs(userDatabase[100].access_expires_at.getTime() - expected.getTime()) < 5000);
  });

  await t.test('9. Entitlement: Past expiry -> today + 15 days', async () => {
    const pastDate = new Date(Date.now() - 5 * 24 * 3600 * 1000); // 5 days ago
    userDatabase[100].access_expires_at = pastDate;

    const payload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          notes: { user_id: '100' }
        }
      },
      payment: {
        entity: {
          id: 'pay_past_333',
          status: 'captured'
        }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_past_333', 'subscription.charged');

    const expected = new Date(Date.now() + 15 * 24 * 3600 * 1000);
    assert.ok(Math.abs(userDatabase[100].access_expires_at.getTime() - expected.getTime()) < 5000);
  });

  await t.test('10. Entitlement: No existing expiry -> today + 15 days', async () => {
    userDatabase[100].access_expires_at = null;

    const payload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          notes: { user_id: '100' }
        }
      },
      payment: {
        entity: {
          id: 'pay_null_444',
          status: 'captured'
        }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_null_444', 'subscription.charged');

    const expected = new Date(Date.now() + 15 * 24 * 3600 * 1000);
    assert.ok(Math.abs(userDatabase[100].access_expires_at.getTime() - expected.getTime()) < 5000);
  });

  await t.test('11. Entitlement: Two successive successful payments extend sequentially', async () => {
    userDatabase[100].access_expires_at = null;

    const firstPayload = {
      subscription: {
        entity: { id: 'sub_100', status: 'active', notes: { user_id: '100' } }
      },
      payment: {
        entity: { id: 'pay_seq_1', status: 'captured' }
      }
    };
    await handleSubscriptionWebhook(firstPayload, 'evt_seq_1', 'subscription.charged');
    const firstExpiry = new Date(userDatabase[100].access_expires_at.getTime());

    const secondPayload = {
      subscription: {
        entity: { id: 'sub_100', status: 'active', notes: { user_id: '100' } }
      },
      payment: {
        entity: { id: 'pay_seq_2', status: 'captured' }
      }
    };
    await handleSubscriptionWebhook(secondPayload, 'evt_seq_2', 'subscription.charged');

    const expected = new Date(firstExpiry.getTime() + 15 * 24 * 3600 * 1000);
    assert.ok(Math.abs(userDatabase[100].access_expires_at.getTime() - expected.getTime()) < 1000);
  });

  await t.test('12. Entitlement: Duplicate webhook does not add another 30 days', async () => {
    userDatabase[100].access_expires_at = null;

    const payload = {
      subscription: {
        entity: { id: 'sub_100', status: 'active', notes: { user_id: '100' } }
      },
      payment: {
        entity: { id: 'pay_dup_999', status: 'captured' }
      }
    };

    // First delivery
    await handleSubscriptionWebhook(payload, 'evt_dup_first', 'subscription.charged');
    const firstExpiry = new Date(userDatabase[100].access_expires_at.getTime());

    // Mock event logs in our helper database
    subscriptionEvents.push({
      sql: 'INSERT INTO premium_subscription_events',
      params: [100, 51, 'razorpay_active', 'evt_dup_first', null, 'active', 'Payment ID: pay_dup_999']
    });

    // Second delivery (duplicate payment ID)
    await handleSubscriptionWebhook(payload, 'evt_dup_first', 'subscription.charged');

    // Assert: Expiry did not change
    assert.equal(userDatabase[100].access_expires_at.getTime(), firstExpiry.getTime());
  });

  await t.test('13. Entitlement: Failed payment does not extend membership', async () => {
    userDatabase[100].access_expires_at = null;

    const payload = {
      subscription: {
        entity: { id: 'sub_100', status: 'halted', notes: { user_id: '100' } }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_failed_payment', 'subscription.halted');

    assert.equal(userDatabase[100].access_expires_at, null);
  });

  await t.test('14. Entitlement: Pending/created/authenticated events do not extend membership', async () => {
    userDatabase[100].access_expires_at = null;

    const payload = {
      subscription: {
        entity: { id: 'sub_100', status: 'authenticated', notes: { user_id: '100' } }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_auth_only', 'subscription.authenticated');

    assert.equal(userDatabase[100].access_expires_at, null);
  });

  await t.test('15. Entitlement: Manual PREMIUM is not affected', async () => {
    userDatabase[101].access_expires_at = null; // Manual user

    const payload = {
      subscription: {
        entity: { id: 'sub_101', status: 'active', notes: { user_id: '101' } }
      },
      payment: {
        entity: { id: 'pay_manual_999', status: 'captured' }
      }
    };

    await handleSubscriptionWebhook(payload, 'evt_manual_pay', 'subscription.charged');

    // Expiry remains untouched (null)
    assert.equal(userDatabase[101].access_expires_at, null);
  });

  await t.test('16. Entitlement: activated and charged for the same period extends only once', async () => {
    userDatabase[100].access_expires_at = null;

    const currentPeriodStart = new Date();
    const currentPeriodEnd = new Date(Date.now() + 15 * 24 * 3600 * 1000);

    const activatedPayload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          current_start: Math.floor(currentPeriodStart.getTime() / 1000),
          current_end: Math.floor(currentPeriodEnd.getTime() / 1000),
          notes: { user_id: '100' }
        }
      }
    };

    const chargedPayload = {
      subscription: {
        entity: {
          id: 'sub_100',
          status: 'active',
          current_start: Math.floor(currentPeriodStart.getTime() / 1000),
          current_end: Math.floor(currentPeriodEnd.getTime() / 1000),
          notes: { user_id: '100' }
        }
      },
      payment: {
        entity: {
          id: 'pay_shared_123',
          status: 'captured'
        }
      }
    };

    // 1. Process activation first
    await handleSubscriptionWebhook(activatedPayload, 'evt_act_shared', 'subscription.activated');
    const firstExpiry = new Date(userDatabase[100].access_expires_at.getTime());

    // 2. Process charge second
    await handleSubscriptionWebhook(chargedPayload, 'evt_chg_shared', 'subscription.charged');
    const secondExpiry = new Date(userDatabase[100].access_expires_at.getTime());

    // Assert: Expiry did not change on second call (extended exactly once!)
    assert.equal(secondExpiry.getTime(), firstExpiry.getTime());
  });
});
