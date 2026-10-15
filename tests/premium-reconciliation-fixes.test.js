import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../src/auth/admin.js';
import { reconcilePaidProduct } from '../src/auth/paidProducts.js';
import { syncUserPremiumRole } from '../src/auth/premium.js';

function createMockDb() {
  const roles = [
    { id: 2, name: 'PREMIUM' }
  ];

  const users = [
    { id: 201, email: 'payment_user@example.com', app_role: ROLES.USER, premium_source: null, access_expires_at: null },
    { id: 202, email: 'manual_user@example.com', app_role: ROLES.PREMIUM, premium_source: 'manual', access_expires_at: null }
  ];

  const paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_enabled: true }
  ];

  const user_roles = [
    { user_id: 202, role_id: 2, assignment_source: 'manual' }
  ];

  const user_product_grants = [];
  const premium_subscriptions = [];
  const paid_subscriptions = [];

  const mockClient = {
    query: async (sql, params = []) => {
      // Roles
      if (/FROM roles WHERE name =/i.test(sql)) {
        const r = roles.find(x => x.name === params[0]);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/FROM roles WHERE id =/i.test(sql)) {
        const r = roles.find(x => x.id === Number(params[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/INSERT INTO roles/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // Products
      if (/FROM paid_products/i.test(sql)) {
        if (/code = \$1/i.test(sql) || /id = \$1/i.test(sql)) {
          const val = params[0];
          const p = paid_products.find(x => x.code === val || x.id === Number(val));
          if (p) {
            return { rows: [{ ...p, role_name: 'PREMIUM' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: paid_products, rowCount: paid_products.length };
      }

      // Candidate users
      if (/SELECT DISTINCT u\.id, u\.app_role, u\.email/i.test(sql)) {
        return { rows: users.map(u => ({ id: u.id, app_role: u.app_role, email: u.email })), rowCount: users.length };
      }

      // User fetch
      if (/FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // Update users
      if (/UPDATE users/i.test(sql)) {
        const userId = Number(params[params.length - 1]);
        const u = users.find(x => x.id === userId);
        if (u) {
          if (sql.includes("app_role = 'PREMIUM'")) {
            u.app_role = ROLES.PREMIUM;
          }
          if (sql.includes("app_role = 'USER'")) {
            u.app_role = ROLES.USER;
          }
          if (sql.includes("premium_source = 'subscription'")) {
            u.premium_source = 'subscription';
          }
          if (sql.includes("premium_source = 'one_time'")) {
            u.premium_source = 'one_time';
          }
          if (sql.includes("premium_source = NULL") || sql.includes("premium_source = null")) {
            u.premium_source = null;
          }
          if (sql.includes("access_expires_at = COALESCE")) {
            const days = parseInt(params[1] || '30', 10);
            const cur = u.access_expires_at;
            const now = new Date();
            const base = cur && new Date(cur) > now ? new Date(cur) : now;
            u.access_expires_at = new Date(base.getTime() + days * 24 * 3600 * 1000).toISOString();
          }
        }
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // Subscriptions & Grants queries
      if (/FROM premium_subscriptions/i.test(sql)) {
        const uid = Number(params[0]);
        const valid = premium_subscriptions.filter(ps =>
          ps.user_id === uid &&
          ['active', 'authenticated'].includes(ps.status) &&
          (!ps.current_period_end || new Date(ps.current_period_end) > new Date())
        );
        return { rows: valid, rowCount: valid.length };
      }
      if (/FROM paid_subscriptions/i.test(sql)) {
        const uid = Number(params[0]);
        const valid = paid_subscriptions.filter(s =>
          s.user_id === uid &&
          ['active', 'authenticated'].includes(s.status) &&
          (!s.current_period_end || new Date(s.current_period_end) > new Date())
        );
        return { rows: valid, rowCount: valid.length };
      }
      if (/FROM user_product_grants/i.test(sql)) {
        const uid = Number(params[0]);
        const valid = user_product_grants.filter(g =>
          g.user_id === uid &&
          g.status === 'active' &&
          (!g.valid_until || new Date(g.valid_until) > new Date())
        );
        return { rows: valid, rowCount: valid.length };
      }

      // User Roles
      if (/SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = \$1/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }
      if (/SELECT assignment_source FROM user_roles WHERE user_id = \$1/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }
      if (/SELECT 1 FROM user_roles WHERE user_id = \$1 AND role_id = \$2/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        return { rows: ur ? [{ 1: 1 }] : [], rowCount: ur ? 1 : 0 };
      }
      if (/INSERT INTO user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const src = params[2] || 'payment_system';
        const existing = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        if (existing) {
          existing.assignment_source = src;
        } else {
          user_roles.push({ user_id: uid, role_id: rid, assignment_source: src });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const filtered = user_roles.filter(x => !(x.user_id === uid && x.role_id === rid));
        user_roles.length = 0;
        user_roles.push(...filtered);
        return { rows: [], rowCount: 1 };
      }

      // Audit logs & events
      if (/INSERT INTO role_audit_log/i.test(sql) || /INSERT INTO paid_product_events/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  };

  return { mockClient, users, user_roles, user_product_grants, premium_subscriptions, paid_subscriptions };
}

test('Premium reconciliation fixes: Payment grant receives payment_system role assignment', async () => {
  const db = createMockDb();
  // Add active premium subscription and active grant
  db.premium_subscriptions.push({
    id: 501,
    user_id: 201,
    provider: 'razorpay',
    status: 'active',
    current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  });
  db.user_product_grants.push({
    id: 601,
    user_id: 201,
    product_id: 1,
    status: 'active',
    valid_until: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  });

  const res = await syncUserPremiumRole(201, db.mockClient);
  
  // Verify user role & source are granted
  const user = db.users.find(u => u.id === 201);
  assert.equal(user.app_role, ROLES.PREMIUM, 'User app_role must become PREMIUM');
  assert.equal(user.premium_source, 'subscription', 'User premium_source must be subscription');

  // Verify RBAC assignment_source is 'payment_system'
  const role = db.user_roles.find(ur => ur.user_id === 201 && ur.role_id === 2);
  assert.notEqual(role, undefined, 'User must have a premium role entry');
  assert.equal(role.assignment_source, 'payment_system', 'Premium role must have assignment_source payment_system');
});

test('Premium reconciliation fixes: Expiry clears role and legacy fields with accurate revoke count during full reconciliation', async () => {
  const db = createMockDb();
  
  // Set up user with expired premium subscription and stale role with payment_system assignment source
  db.users.push({
    id: 203,
    email: 'expired_user@example.com',
    app_role: ROLES.PREMIUM,
    premium_source: 'subscription',
    access_expires_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() // expired yesterday
  });
  db.user_roles.push({
    user_id: 203,
    role_id: 2,
    assignment_source: 'payment_system'
  });
  db.premium_subscriptions.push({
    id: 502,
    user_id: 203,
    provider: 'razorpay',
    status: 'expired',
    current_period_end: new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  });

  // Run full reconciliation
  const result = await reconcilePaidProduct('PREMIUM', { client: db.mockClient, dryRun: false });

  // Verify legacy fields are cleared
  const user = db.users.find(u => u.id === 203);
  assert.equal(user.app_role, ROLES.USER, 'Expired user app_role must be USER');
  assert.equal(user.premium_source, null, 'Expired user premium_source must be null');

  // Verify role is removed from user_roles
  const role = db.user_roles.find(ur => ur.user_id === 203 && ur.role_id === 2);
  assert.equal(role, undefined, 'Expired user premium role must be removed');

  // Verify accurate revoke count
  assert.equal(result.rolesRevoked, 1, 'Reconciliation report must reflect exactly 1 revoked role');
});

test('Premium reconciliation fixes: Manual premium role and legacy columns are preserved', async () => {
  const db = createMockDb();
  // manual_user (202) has app_role=PREMIUM, premium_source=manual, and user_roles assignment_source=manual
  // Run full reconciliation
  const result = await reconcilePaidProduct('PREMIUM', { client: db.mockClient, dryRun: false });

  // Verify manual user remains PREMIUM
  const user = db.users.find(u => u.id === 202);
  assert.equal(user.app_role, ROLES.PREMIUM, 'Manual user app_role must remain PREMIUM');
  assert.equal(user.premium_source, 'manual', 'Manual user premium_source must remain manual');

  // Verify manual role is preserved
  const role = db.user_roles.find(ur => ur.user_id === 202 && ur.role_id === 2);
  assert.notEqual(role, undefined, 'Manual user premium role must be preserved');
  assert.equal(role.assignment_source, 'manual', 'Manual user premium role must still have source manual');

  // Verify not revoked in reporting
  assert.equal(result.rolesRevoked, 0, 'No manual roles should be revoked during reconciliation');
});

test('Premium reconciliation fixes: Individual sync correctly reconciles expired user and clears legacy columns', async () => {
  const db = createMockDb();
  
  // Set up user with expired subscription and stale payment role
  db.users.push({
    id: 204,
    email: 'individual_sync@example.com',
    app_role: ROLES.PREMIUM,
    premium_source: 'subscription',
    access_expires_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  });
  db.user_roles.push({
    user_id: 204,
    role_id: 2,
    assignment_source: 'payment_system'
  });

  // Call syncUserPremiumRole directly as done in individual user reconciliation route
  const result = await syncUserPremiumRole(204, db.mockClient);

  // Verify legacy fields are cleared
  const user = db.users.find(u => u.id === 204);
  assert.equal(user.app_role, ROLES.USER, 'Individual sync user app_role must become USER');
  assert.equal(user.premium_source, null, 'Individual sync user premium_source must be null');

  // Verify role is removed from user_roles
  const role = db.user_roles.find(ur => ur.user_id === 204 && ur.role_id === 2);
  assert.equal(role, undefined, 'Individual sync user premium role must be removed');
  
  // Verify returned action
  assert.equal(result.action, 'revoked', 'Result action must be revoked');
  assert.equal(result.rbac?.rbacAction, 'revoked', 'RBAC action must be revoked');
});

test('Full reconciliation removes payment_system PREMIUM role when user is expired with NULL access_expires_at and stale subscription rows, leaving manual roles untouched', async () => {
  const db = createMockDb();

  // User 301: expired, access_expires_at = null, stale payment_system role in user_roles, but stale active subscription record in premium_subscriptions
  db.users.push({
    id: 301,
    email: 'stale_sub_expired@example.com',
    app_role: ROLES.USER,
    status: 'expired',
    premium_source: null,
    access_expires_at: null
  });
  db.user_roles.push({
    user_id: 301,
    role_id: 2,
    assignment_source: 'payment_system'
  });
  db.premium_subscriptions.push({
    id: 999,
    user_id: 301,
    provider: 'razorpay',
    status: 'active',
    current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() // stale future date in subscription table
  });

  // Run full reconciliation for PREMIUM
  const result = await reconcilePaidProduct('PREMIUM', { client: db.mockClient, dryRun: false });

  // Verify payment_system role was removed
  const paymentRole = db.user_roles.find(ur => ur.user_id === 301 && ur.role_id === 2);
  assert.equal(paymentRole, undefined, 'Payment_system PREMIUM role must be removed during full reconciliation');

  // Verify manual role (user 202) remains untouched
  const manualRole = db.user_roles.find(ur => ur.user_id === 202 && ur.role_id === 2);
  assert.notEqual(manualRole, undefined, 'Manual PREMIUM role must remain untouched');
  assert.equal(manualRole.assignment_source, 'manual', 'Manual role assignment_source must remain manual');
});

