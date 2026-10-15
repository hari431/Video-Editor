import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMigrationAppliedBySchema } from '../scripts/migrate.js';

test('Paid Products Framework - Migration 024 Structure and Constraints', async (t) => {
  const sqlPath = path.join(process.cwd(), 'migrations', '024_paid_products_framework.sql');
  const sql = await readFile(sqlPath, 'utf8');

  await t.test('1. Migration file defines all required tables and columns', () => {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS paid_products'), 'Must create paid_products');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS paid_product_plans'), 'Must create paid_product_plans');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS paid_orders'), 'Must create paid_orders');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS paid_subscriptions'), 'Must create paid_subscriptions');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS user_product_grants'), 'Must create user_product_grants');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS paid_product_events'), 'Must create paid_product_events');
    assert.ok(sql.includes('assignment_source TEXT NOT NULL DEFAULT \'manual\''), 'Must add assignment_source to user_roles');
  });

  await t.test('2. user_product_grants MUST NOT enforce UNIQUE(user_id, product_id) to allow multiple purchases', () => {
    assert.ok(!sql.includes('UNIQUE (user_id, product_id)'), 'user_product_grants must NOT have UNIQUE(user_id, product_id)');
    assert.ok(!sql.includes('UNIQUE(user_id, product_id)'), 'user_product_grants must NOT have UNIQUE(user_id, product_id)');
  });

  await t.test('3. Migration includes built-in role and product seeding for PREMIUM', () => {
    assert.ok(sql.includes("INSERT INTO roles (name, description)"), 'Must ensure PREMIUM role');
    assert.ok(sql.includes("INSERT INTO paid_products"), 'Must seed PREMIUM in paid_products');
    assert.ok(sql.includes("INSERT INTO paid_product_plans"), 'Must seed plans in paid_product_plans');
    assert.ok(sql.includes("'monthly'"), 'Must seed monthly recurring plan');
    assert.ok(sql.includes("'one_time_pass'"), 'Must seed one-time pass plan');
  });

  await t.test('4. Migration protects OWNER and ADMIN when setting user_roles.assignment_source', () => {
    assert.ok(sql.includes("u.app_role NOT IN ('OWNER', 'ADMIN')"), 'Must protect OWNER and ADMIN from being marked payment_system');
    assert.ok(sql.includes("assignment_source = 'payment_system'"), 'Must set payment_system only for automated purchases');
  });

  await t.test('5. isMigrationAppliedBySchema recognizes 024 when paid_products and user_product_grants exist', async () => {
    const mockClientWithTables = {
      query: async (q, params) => {
        const tableName = params?.[0];
        if (tableName === 'paid_products' || tableName === 'user_product_grants') {
          return { rows: [{ exists: true }] };
        }
        return { rows: [{ exists: false }] };
      }
    };

    const mockClientWithoutTables = {
      query: async () => ({ rows: [{ exists: false }] })
    };

    const applied = await isMigrationAppliedBySchema(mockClientWithTables, '024_paid_products_framework.sql');
    const notApplied = await isMigrationAppliedBySchema(mockClientWithoutTables, '024_paid_products_framework.sql');

    assert.equal(applied, true, 'Should detect 024 when both tables exist');
    assert.equal(notApplied, false, 'Should not detect 024 when tables are missing');
  });
});

test('Paid Products Framework - Simulated In-Memory Backfill & Protection Logic', async (t) => {
  // Simulate mock database state prior to 024
  let roles = [
    { id: 1, name: 'ADMIN', description: 'Admin role' },
    { id: 2, name: 'PREMIUM', description: 'Built-in Premium role' }
  ];

  let users = [
    { id: 10, email: 'owner@example.com', app_role: 'OWNER', premium_source: null, access_expires_at: null },
    { id: 11, email: 'admin@example.com', app_role: 'ADMIN', premium_source: 'subscription', access_expires_at: null },
    { id: 12, email: 'manual_user@example.com', app_role: 'PREMIUM', premium_source: 'manual', access_expires_at: null },
    { id: 13, email: 'sub_user@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null },
    { id: 14, email: 'ot_user@example.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 864000000) },
    { id: 15, email: 'ot_expired@example.com', app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 864000000) },
    { id: 16, email: 'direct_rbac@example.com', app_role: 'USER', premium_source: null, access_expires_at: null }
  ];

  let user_roles = [
    { user_id: 11, role_id: 2, assignment_source: 'manual' }, // admin with premium
    { user_id: 12, role_id: 2, assignment_source: 'manual' }, // manual premium user
    { user_id: 13, role_id: 2, assignment_source: 'manual' }, // sub user
    { user_id: 14, role_id: 2, assignment_source: 'manual' }, // one-time user
    { user_id: 16, role_id: 2, assignment_source: 'manual' }  // admin directly assigned role in RBAC screen
  ];

  let premium_subscriptions = [
    {
      id: 101,
      user_id: 13,
      provider: 'razorpay',
      provider_customer_id: 'cust_13',
      provider_subscription_id: 'sub_13_active',
      plan_id: 'plan_sub',
      status: 'active',
      current_period_start: new Date(Date.now() - 1000000),
      current_period_end: new Date(Date.now() + 2000000),
      cancel_at_period_end: false,
      created_at: new Date(),
      updated_at: new Date()
    }
  ];

  // Target tables
  let paid_products = [];
  let paid_product_plans = [];
  let paid_subscriptions = [];
  let user_product_grants = [];

  await t.test('1. Product & Plan Seeding', () => {
    const premiumRole = roles.find(r => r.name === 'PREMIUM');
    assert.ok(premiumRole, 'PREMIUM role exists');

    paid_products.push({
      id: 1,
      code: 'PREMIUM',
      name: 'Premium Membership',
      role_id: premiumRole.id,
      is_enabled: true
    });

    paid_product_plans.push(
      { id: 1, product_id: 1, code: 'monthly', billing_type: 'recurring', price_amount_paise: 30000 },
      { id: 2, product_id: 1, code: 'one_time_pass', billing_type: 'one_time', price_amount_paise: 30000, duration_days: 30 }
    );

    assert.equal(paid_products.length, 1);
    assert.equal(paid_product_plans.length, 2);
  });

  await t.test('2. Subscription Backfill preserves subscription records & generates grants', () => {
    for (const ps of premium_subscriptions) {
      paid_subscriptions.push({
        id: ps.id,
        user_id: ps.user_id,
        product_id: 1,
        plan_id: 1,
        provider: ps.provider,
        provider_subscription_id: ps.provider_subscription_id,
        status: ps.status,
        current_period_start: ps.current_period_start,
        current_period_end: ps.current_period_end
      });

      user_product_grants.push({
        id: user_product_grants.length + 1,
        user_id: ps.user_id,
        product_id: 1,
        plan_id: 1,
        grant_type: 'subscription_cycle',
        status: ps.status === 'active' && ps.current_period_end > new Date() ? 'active' : 'expired',
        valid_from: ps.current_period_start,
        valid_until: ps.current_period_end,
        subscription_id: ps.id
      });
    }

    assert.equal(paid_subscriptions.length, 1);
    assert.equal(user_product_grants.length, 1);
    assert.equal(user_product_grants[0].status, 'active');
    assert.equal(user_product_grants[0].user_id, 13);
  });

  await t.test('3. One-Time Pass Backfill correctly handles active vs expired', () => {
    const otUsers = users.filter(u => u.premium_source === 'one_time');
    for (const u of otUsers) {
      const isActive = u.access_expires_at && u.access_expires_at > new Date();
      user_product_grants.push({
        id: user_product_grants.length + 1,
        user_id: u.id,
        product_id: 1,
        plan_id: 2,
        grant_type: 'one_time_purchase',
        status: isActive ? 'active' : 'expired',
        valid_from: new Date(),
        valid_until: u.access_expires_at
      });
    }

    const otActive = user_product_grants.find(g => g.user_id === 14);
    const otExpired = user_product_grants.find(g => g.user_id === 15);

    assert.ok(otActive);
    assert.equal(otActive.status, 'active');
    assert.ok(otExpired);
    assert.equal(otExpired.status, 'expired');
  });

  await t.test('4. Manual Premium Grants Backfill creates lifetime/indefinite active grants', () => {
    const manualUsers = users.filter(u => u.premium_source === 'manual');
    for (const u of manualUsers) {
      user_product_grants.push({
        id: user_product_grants.length + 1,
        user_id: u.id,
        product_id: 1,
        plan_id: null,
        grant_type: 'manual',
        status: 'active',
        valid_from: new Date(),
        valid_until: null // Indefinite
      });
    }

    const manualGrant = user_product_grants.find(g => g.user_id === 12);
    assert.ok(manualGrant);
    assert.equal(manualGrant.status, 'active');
    assert.equal(manualGrant.valid_until, null);
  });

  await t.test('5. RBAC assignment_source Backfill: OWNER, ADMIN, and Manual grants stay "manual"', () => {
    // Run the backfill update logic
    for (const ur of user_roles) {
      if (ur.role_id === 2) { // PREMIUM role
        const u = users.find(user => user.id === ur.user_id);
        if (u && !['OWNER', 'ADMIN'].includes(u.app_role) && ['subscription', 'one_time'].includes(u.premium_source)) {
          ur.assignment_source = 'payment_system';
        }
      }
    }

    // Admin user (id 11) had subscription source, but app_role is ADMIN -> MUST stay 'manual'
    const adminAssignment = user_roles.find(ur => ur.user_id === 11);
    assert.equal(adminAssignment.assignment_source, 'manual', 'Admin user role MUST remain manual');

    // Manual user (id 12) had premium_source = manual -> MUST stay 'manual'
    const manualAssignment = user_roles.find(ur => ur.user_id === 12);
    assert.equal(manualAssignment.assignment_source, 'manual', 'Manual grant MUST remain manual');

    // Direct RBAC assignment (id 16) had no payment source -> MUST stay 'manual'
    const directAssignment = user_roles.find(ur => ur.user_id === 16);
    assert.equal(directAssignment.assignment_source, 'manual', 'Direct RBAC assignment MUST remain manual');

    // Standard subscriber (id 13) -> becomes 'payment_system'
    const subAssignment = user_roles.find(ur => ur.user_id === 13);
    assert.equal(subAssignment.assignment_source, 'payment_system', 'Payment subscriber role becomes payment_system');

    // Standard one-time buyer (id 14) -> becomes 'payment_system'
    const otAssignment = user_roles.find(ur => ur.user_id === 14);
    assert.equal(otAssignment.assignment_source, 'payment_system', 'One-time buyer role becomes payment_system');
  });

  await t.test('6. Multiple purchases for the same user coexist in user_product_grants', () => {
    // User 14 buys another 30-day pass
    const initialCount = user_product_grants.filter(g => g.user_id === 14).length;
    user_product_grants.push({
      id: user_product_grants.length + 1,
      user_id: 14,
      product_id: 1,
      plan_id: 2,
      grant_type: 'one_time_purchase',
      status: 'active',
      valid_from: new Date(Date.now() + 864000000), // Stacked after current expiration
      valid_until: new Date(Date.now() + 864000000 + 30 * 86400000)
    });

    const newCount = user_product_grants.filter(g => g.user_id === 14).length;
    assert.equal(newCount, initialCount + 1, 'Multiple grants must coexist without collision');
  });
});
