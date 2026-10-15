import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProductByCode,
  getActiveProductByCode,
  getProductById,
  getPlanByCode,
  getActivePlansForProduct,
  createPaidOrder,
  updatePaidOrderStatus,
  upsertPaidSubscription,
  createUserProductGrant,
  updateGrantStatus,
  getActiveGrants,
  validateUserEntitlement,
  syncProductRbacRole,
  logPaidProductEvent
} from '../src/auth/paidProducts.js';

test('Core Paid Products Framework - Comprehensive Unit & Regression Suite', async (t) => {

  // In-Memory Test State
  let roles = [
    { id: 1, name: 'ADMIN', description: 'Admin' },
    { id: 2, name: 'PREMIUM', description: 'Built-in Premium' },
    { id: 3, name: 'PRO_ANALYTICS', description: 'Future Pro Analytics product role' }
  ];

  let users = [
    { id: 10, email: 'owner@example.com', app_role: 'OWNER' },
    { id: 11, email: 'admin@example.com', app_role: 'ADMIN' },
    { id: 12, email: 'regular@example.com', app_role: 'USER' },
    { id: 13, email: 'future_customer@example.com', app_role: 'USER' }
  ];

  let paid_products = [
    { id: 1, code: 'PREMIUM', name: 'Premium Membership', description: 'Desc', role_id: 2, is_enabled: true, metadata: {} },
    { id: 2, code: 'ANALYTICS', name: 'Pro Analytics Suite', description: 'Future product', role_id: 3, is_enabled: true, metadata: {} },
    { id: 3, code: 'DISABLED_PROD', name: 'Disabled Product', description: 'Desc', role_id: 2, is_enabled: false, metadata: {} }
  ];

  let paid_product_plans = [
    { id: 1, product_id: 1, code: 'monthly', name: 'Monthly', billing_type: 'recurring', price_amount_paise: 30000, currency: 'INR', duration_days: null, is_active: true, metadata: {} },
    { id: 2, product_id: 1, code: 'one_time_pass', name: 'One Time Pass', billing_type: 'one_time', price_amount_paise: 30000, currency: 'INR', duration_days: 30, is_active: true, metadata: {} },
    { id: 3, product_id: 2, code: 'annual', name: 'Analytics Annual', billing_type: 'recurring', price_amount_paise: 99900, currency: 'INR', duration_days: 365, is_active: true, metadata: {} },
    { id: 4, product_id: 2, code: 'hidden_legacy', name: 'Legacy Plan', billing_type: 'recurring', price_amount_paise: 50000, currency: 'INR', duration_days: null, is_active: false, metadata: {} }
  ];

  let paid_orders = [];
  let paid_subscriptions = [];
  let user_product_grants = [];
  let user_roles = [];
  let paid_product_events = [];

  // Mock Postgres Client implementing queries needed by paidProducts.js
  const mockClient = {
    query: async (sql, params = []) => {
      // 1. getProductByCode / getActiveProductByCode / getProductById
      if (/FROM paid_products p/i.test(sql)) {
        if (/p\.code = \$1 AND p\.is_enabled = TRUE/i.test(sql)) {
          const p = paid_products.find(prod => prod.code === params[0] && prod.is_enabled);
          if (!p) return { rows: [], rowCount: 0 };
          const r = roles.find(role => role.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name }], rowCount: 1 };
        }
        if (/p\.code = \$1/i.test(sql)) {
          const p = paid_products.find(prod => prod.code === params[0]);
          if (!p) return { rows: [], rowCount: 0 };
          const r = roles.find(role => role.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name }], rowCount: 1 };
        }
        if (/p\.id = \$1/i.test(sql)) {
          const p = paid_products.find(prod => prod.id === Number(params[0]));
          if (!p) return { rows: [], rowCount: 0 };
          const r = roles.find(role => role.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name }], rowCount: 1 };
        }
      }

      // 2. Plans queries
      if (/FROM paid_product_plans/i.test(sql)) {
        if (/product_id = \$1 AND code = \$2/i.test(sql)) {
          const pl = paid_product_plans.find(plan => plan.product_id === Number(params[0]) && plan.code === params[1]);
          return { rows: pl ? [pl] : [], rowCount: pl ? 1 : 0 };
        }
        if (/product_id = \$1 AND is_active = TRUE/i.test(sql)) {
          const plans = paid_product_plans.filter(plan => plan.product_id === Number(params[0]) && plan.is_active);
          plans.sort((a, b) => a.price_amount_paise - b.price_amount_paise);
          return { rows: plans, rowCount: plans.length };
        }
      }

      // 3. paid_orders INSERT & UPDATE
      if (/INSERT INTO paid_orders/i.test(sql)) {
        const [user_id, product_id, plan_id, amount_paise, currency, provider, provider_order_id, promo_code, discount_paise, metadata] = params;
        const row = {
          id: paid_orders.length + 1,
          user_id: Number(user_id),
          product_id: Number(product_id),
          plan_id: plan_id ? Number(plan_id) : null,
          amount_paise: Number(amount_paise),
          currency,
          status: 'created',
          provider,
          provider_order_id,
          provider_payment_id: null,
          promo_code,
          discount_paise: Number(discount_paise),
          metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
          created_at: new Date(),
          updated_at: new Date()
        };
        paid_orders.push(row);
        return { rows: [row], rowCount: 1 };
      }

      if (/UPDATE paid_orders/i.test(sql)) {
        const orderId = Number(params[0]);
        const status = params[1];
        const ord = paid_orders.find(o => o.id === orderId);
        if (!ord) return { rows: [], rowCount: 0 };
        ord.status = status;
        ord.updated_at = new Date();
        if (params.length > 2 && params[2] && typeof params[2] === 'string' && !params[2].startsWith('{')) {
          ord.provider_payment_id = params[2];
        }
        return { rows: [ord], rowCount: 1 };
      }

      // 4. paid_subscriptions UPSERT
      if (/INSERT INTO paid_subscriptions/i.test(sql)) {
        const [user_id, product_id, plan_id, provider, provider_customer_id, provider_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end, cancelled_at, metadata] = params;
        let sub = paid_subscriptions.find(s => s.provider_subscription_id === provider_subscription_id);
        if (sub) {
          sub.user_id = Number(user_id);
          sub.product_id = Number(product_id);
          if (plan_id) sub.plan_id = Number(plan_id);
          sub.status = status;
          sub.current_period_start = current_period_start;
          sub.current_period_end = current_period_end;
          sub.cancel_at_period_end = cancel_at_period_end;
          sub.cancelled_at = cancelled_at;
          sub.updated_at = new Date();
        } else {
          sub = {
            id: paid_subscriptions.length + 1,
            user_id: Number(user_id),
            product_id: Number(product_id),
            plan_id: plan_id ? Number(plan_id) : null,
            provider,
            provider_customer_id,
            provider_subscription_id,
            status,
            current_period_start,
            current_period_end,
            cancel_at_period_end,
            cancelled_at,
            metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
            created_at: new Date(),
            updated_at: new Date()
          };
          paid_subscriptions.push(sub);
        }
        return { rows: [sub], rowCount: 1 };
      }

      // 5. user_product_grants INSERT, UPDATE, SELECT
      if (/INSERT INTO user_product_grants/i.test(sql)) {
        const [user_id, product_id, plan_id, grant_type, status, valid_from, valid_until, order_id, subscription_id, granted_by_user_id, grant_reason, metadata] = params;
        const grant = {
          id: user_product_grants.length + 1,
          user_id: Number(user_id),
          product_id: Number(product_id),
          plan_id: plan_id ? Number(plan_id) : null,
          grant_type,
          status,
          valid_from: new Date(valid_from),
          valid_until: valid_until ? new Date(valid_until) : null,
          order_id: order_id ? Number(order_id) : null,
          subscription_id: subscription_id ? Number(subscription_id) : null,
          granted_by_user_id: granted_by_user_id ? Number(granted_by_user_id) : null,
          grant_reason,
          metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
          created_at: new Date(),
          updated_at: new Date()
        };
        user_product_grants.push(grant);
        return { rows: [grant], rowCount: 1 };
      }

      if (/UPDATE user_product_grants/i.test(sql)) {
        const [grantId, status] = params;
        const g = user_product_grants.find(item => item.id === Number(grantId));
        if (!g) return { rows: [], rowCount: 0 };
        g.status = status;
        g.updated_at = new Date();
        return { rows: [g], rowCount: 1 };
      }

      if (/FROM user_product_grants/i.test(sql)) {
        const [userId, productId] = params;
        const rows = user_product_grants.filter(g => 
          g.user_id === Number(userId) &&
          g.product_id === Number(productId) &&
          g.status === 'active' &&
          (g.valid_until === null || g.valid_until > new Date())
        );
        return { rows, rowCount: rows.length };
      }

      // 6. users queries
      if (/FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(user => user.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 7. user_roles queries
      if (/SELECT user_id, role_id, assignment_source FROM user_roles/i.test(sql)) {
        const [userId, roleId] = params;
        const ur = user_roles.find(r => r.user_id === Number(userId) && r.role_id === Number(roleId));
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }

      if (/INSERT INTO user_roles/i.test(sql)) {
        const [userId, roleId] = params;
        let ur = user_roles.find(r => r.user_id === Number(userId) && r.role_id === Number(roleId));
        if (ur) {
          ur.assignment_source = 'payment_system';
        } else {
          ur = { user_id: Number(userId), role_id: Number(roleId), assignment_source: 'payment_system' };
          user_roles.push(ur);
        }
        return { rows: [ur], rowCount: 1 };
      }

      if (/DELETE FROM user_roles WHERE user_id = \$1 AND role_id = \$2 AND assignment_source = \$3/i.test(sql)) {
        const [userId, roleId, source] = params;
        const idx = user_roles.findIndex(r => r.user_id === Number(userId) && r.role_id === Number(roleId) && r.assignment_source === source);
        if (idx >= 0) {
          user_roles.splice(idx, 1);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 8. paid_product_events INSERT
      if (/INSERT INTO paid_product_events/i.test(sql)) {
        const [product_id, user_id, entitlement_id, event_type, provider_event_id, previous_status, new_status, message, payload] = params;
        const ev = {
          id: paid_product_events.length + 1,
          product_id: product_id ? Number(product_id) : null,
          user_id: user_id ? Number(user_id) : null,
          entitlement_id: entitlement_id ? Number(entitlement_id) : null,
          event_type,
          provider_event_id,
          previous_status,
          new_status,
          message,
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          created_at: new Date()
        };
        paid_product_events.push(ev);
        return { rows: [ev], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  };

  await t.test('1. Product & Plan Lookup Helpers work for any product code', async () => {
    // Lookup PREMIUM
    const premiumProd = await getProductByCode('PREMIUM', mockClient);
    assert.ok(premiumProd, 'Must find PREMIUM product');
    assert.equal(premiumProd.code, 'PREMIUM');
    assert.equal(premiumProd.role_name, 'PREMIUM');

    // Lookup future product ANALYTICS
    const analyticsProd = await getProductByCode('ANALYTICS', mockClient);
    assert.ok(analyticsProd, 'Must find future ANALYTICS product');
    assert.equal(analyticsProd.role_name, 'PRO_ANALYTICS');

    // getActiveProductByCode respects is_enabled
    const activePrem = await getActiveProductByCode('PREMIUM', mockClient);
    assert.ok(activePrem, 'Active product found');
    const disabledProd = await getActiveProductByCode('DISABLED_PROD', mockClient);
    assert.equal(disabledProd, null, 'Disabled product must return null');

    // Plan lookups
    const monthlyPlan = await getPlanByCode(premiumProd.id, 'monthly', mockClient);
    assert.ok(monthlyPlan);
    assert.equal(monthlyPlan.billing_type, 'recurring');
    assert.equal(monthlyPlan.price_amount_paise, 30000);

    const activePlans = await getActivePlansForProduct(analyticsProd.id, mockClient);
    assert.equal(activePlans.length, 1);
    assert.equal(activePlans[0].code, 'annual');
  });

  await t.test('2. Paid Orders Lifecycle: Create, status transitions, metadata', async () => {
    const order = await createPaidOrder({
      userId: 12,
      productId: 1,
      planId: 2,
      amountPaise: 30000,
      currency: 'INR',
      providerOrderId: 'order_rzp_123',
      promoCode: 'EARLYBIRD',
      discountPaise: 5000,
      metadata: { source: 'web' }
    }, mockClient);

    assert.ok(order.id);
    assert.equal(order.status, 'created');
    assert.equal(order.amount_paise, 30000);
    assert.equal(order.promo_code, 'EARLYBIRD');

    // Transition to paid
    const updated = await updatePaidOrderStatus(order.id, {
      status: 'paid',
      providerPaymentId: 'pay_rzp_999'
    }, mockClient);

    assert.equal(updated.status, 'paid');
    assert.equal(updated.provider_payment_id, 'pay_rzp_999');
  });

  await t.test('3. Paid Subscriptions Lifecycle: Upsert, idempotency, updates', async () => {
    const sub = await upsertPaidSubscription({
      userId: 12,
      productId: 1,
      planId: 1,
      providerSubscriptionId: 'sub_test_456',
      status: 'authenticated',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
    }, mockClient);

    assert.ok(sub.id);
    assert.equal(sub.status, 'authenticated');

    // Active cycle update
    const activeSub = await upsertPaidSubscription({
      userId: 12,
      productId: 1,
      providerSubscriptionId: 'sub_test_456',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
    }, mockClient);

    assert.equal(activeSub.id, sub.id, 'Must update existing subscription row on conflict');
    assert.equal(activeSub.status, 'active');
  });

  await t.test('4. Append-Only Grants: Stacking multiple purchases without collision', async () => {
    // First 30-day pass
    const expiry1 = new Date(Date.now() + 30 * 86400000);
    const grant1 = await createUserProductGrant({
      userId: 12,
      productId: 1,
      planId: 2,
      grantType: 'one_time_purchase',
      status: 'active',
      validFrom: new Date(),
      validUntil: expiry1,
      orderId: 1
    }, mockClient);

    // Second stacked 30-day pass
    const expiry2 = new Date(Date.now() + 60 * 86400000);
    const grant2 = await createUserProductGrant({
      userId: 12,
      productId: 1,
      planId: 2,
      grantType: 'one_time_purchase',
      status: 'active',
      validFrom: expiry1,
      validUntil: expiry2,
      orderId: 2
    }, mockClient);

    assert.ok(grant1.id !== grant2.id, 'Grants must have distinct IDs');

    // Get active grants
    const grants = await getActiveGrants(12, 1, mockClient);
    assert.equal(grants.length, 2, 'Both grants coexist without collision');
  });

  await t.test('5. Generic Entitlement Validation: Furthest expiry and primary grant type', async () => {
    // User 12 has two stacked grants, furthest expiry should be expiry2 (~60 days)
    const ent = await validateUserEntitlement(12, 'PREMIUM', mockClient);
    assert.equal(ent.hasEntitlement, true);
    assert.ok(ent.furthestExpiry > new Date(Date.now() + 50 * 86400000));
    assert.equal(ent.primaryGrantType, 'one_time_purchase');

    // User without grants
    const noEnt = await validateUserEntitlement(13, 'PREMIUM', mockClient);
    assert.equal(noEnt.hasEntitlement, false);
    assert.equal(noEnt.furthestExpiry, null);
  });

  await t.test('6. Product-Scoped RBAC Sync: Grants role with payment_system assignment source', async () => {
    // User 12 has active entitlement for PREMIUM -> should grant role
    const syncRes = await syncProductRbacRole(12, 'PREMIUM', mockClient);
    assert.equal(syncRes.action, 'granted');
    assert.equal(syncRes.assignmentSource, 'payment_system');

    // Verify role in user_roles
    const role = user_roles.find(r => r.user_id === 12 && r.role_id === 2);
    assert.ok(role);
    assert.equal(role.assignment_source, 'payment_system');

    // Re-running sync when already granted is idempotent
    const idempotentRes = await syncProductRbacRole(12, 'PREMIUM', mockClient);
    assert.equal(idempotentRes.action, 'no_change');
  });

  await t.test('7. Product-Scoped RBAC Sync: Revokes role when entitlement expires if payment_system', async () => {
    // Expire all grants for user 12
    for (const g of user_product_grants.filter(item => item.user_id === 12)) {
      await updateGrantStatus(g.id, 'expired', mockClient);
    }

    // Validation now reports false
    const ent = await validateUserEntitlement(12, 'PREMIUM', mockClient);
    assert.equal(ent.hasEntitlement, false);

    // Sync role should now revoke payment_system role
    const syncRes = await syncProductRbacRole(12, 'PREMIUM', mockClient);
    assert.equal(syncRes.action, 'revoked');

    const role = user_roles.find(r => r.user_id === 12 && r.role_id === 2);
    assert.equal(role, undefined, 'Role must be deleted when payment entitlement expires');
  });

  await t.test('8. Protection: Manual RBAC assignments are NEVER revoked by payment sync', async () => {
    // Manually assign PREMIUM role with assignment_source = 'manual' to user 13
    user_roles.push({ user_id: 13, role_id: 2, assignment_source: 'manual' });

    // User 13 has NO grants / entitlement
    const ent = await validateUserEntitlement(13, 'PREMIUM', mockClient);
    assert.equal(ent.hasEntitlement, false);

    // Sync product role for user 13
    const syncRes = await syncProductRbacRole(13, 'PREMIUM', mockClient);
    assert.equal(syncRes.action, 'preserved_manual');
    assert.equal(syncRes.assignmentSource, 'manual');

    // Role MUST still exist in user_roles
    const role = user_roles.find(r => r.user_id === 13 && r.role_id === 2);
    assert.ok(role, 'Manual role assignment must be preserved');
    assert.equal(role.assignment_source, 'manual');
  });

  await t.test('9. Protection: OWNER and ADMIN roles are strictly skipped', async () => {
    // Give admin user (id 11) a manual role assignment
    user_roles.push({ user_id: 11, role_id: 2, assignment_source: 'manual' });

    // Try sync for Admin
    const adminSync = await syncProductRbacRole(11, 'PREMIUM', mockClient);
    assert.equal(adminSync.action, 'skipped_protected');

    // Try sync for Owner
    const ownerSync = await syncProductRbacRole(10, 'PREMIUM', mockClient);
    assert.equal(ownerSync.action, 'skipped_protected');

    // Admin role in user_roles is untouched
    const adminRole = user_roles.find(r => r.user_id === 11 && r.role_id === 2);
    assert.ok(adminRole);
    assert.equal(adminRole.assignment_source, 'manual');
  });

  await t.test('10. Works generically with ANY future paid product (e.g. ANALYTICS)', async () => {
    // Grant future product ANALYTICS to user 13
    const grant = await createUserProductGrant({
      userId: 13,
      productId: 2, // ANALYTICS product
      planId: 3,
      grantType: 'one_time_purchase',
      status: 'active',
      validUntil: new Date(Date.now() + 365 * 86400000)
    }, mockClient);

    assert.ok(grant.id);

    // Validate entitlement for ANALYTICS
    const ent = await validateUserEntitlement(13, 'ANALYTICS', mockClient);
    assert.equal(ent.hasEntitlement, true);

    // Sync RBAC role for ANALYTICS
    const syncRes = await syncProductRbacRole(13, 'ANALYTICS', mockClient);
    assert.equal(syncRes.action, 'granted');
    assert.equal(syncRes.productCode, 'ANALYTICS');
    assert.equal(syncRes.roleId, 3); // PRO_ANALYTICS role

    // Check user_roles contains role_id 3 with payment_system
    const analyticsRole = user_roles.find(r => r.user_id === 13 && r.role_id === 3);
    assert.ok(analyticsRole);
    assert.equal(analyticsRole.assignment_source, 'payment_system');
  });

  await t.test('11. Event Logging appends audit history', async () => {
    const ev = await logPaidProductEvent({
      productId: 1,
      userId: 12,
      eventType: 'payment_success',
      providerEventId: 'evt_9999',
      previousStatus: 'created',
      newStatus: 'paid',
      message: 'Payment received for monthly plan',
      payload: { amount: 30000 }
    }, mockClient);

    assert.ok(ev.id);
    assert.equal(ev.event_type, 'payment_success');
    assert.equal(paid_product_events.length, 1);
  });
});
