import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../src/auth/admin.js';
import { reconcilePaidProduct } from '../src/auth/paidProducts.js';

function createRegressionMockDb() {
  let roles = [
    { id: 1, name: 'USER' },
    { id: 2, name: 'PREMIUM' },
    { id: 3, name: 'ADMIN' },
    { id: 4, name: 'OWNER' }
  ];

  // Users setup for Hari Chandana & Hari B scenarios
  let users = [
    { id: 101, email: 'harichandana@example.com', app_role: ROLES.USER, premium_source: null, access_expires_at: null },
    { id: 102, email: 'harib@example.com', app_role: ROLES.USER, premium_source: null, access_expires_at: '2026-09-06T00:00:00.000Z' }, // expired yesterday
    { id: 103, email: 'active_sub@example.com', app_role: ROLES.USER, premium_source: null, access_expires_at: null },
    { id: 104, email: 'expired_stale_role@example.com', app_role: ROLES.PREMIUM, premium_source: 'subscription', access_expires_at: '2026-09-06T00:00:00.000Z' }
  ];

  let paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_enabled: true }
  ];

  let user_roles = [
    { user_id: 104, role_id: 2, assignment_source: 'payment_system' }
  ];

  // Active user 103 has active user_product_grant and paid_subscription
  let user_product_grants = [
    {
      id: 1,
      user_id: 102,
      product_id: 100,
      grant_type: 'subscription_cycle',
      status: 'active', // will be expired by step 2 of reconcilePaidProduct
      valid_until: new Date(Date.now() - 86400000).toISOString() // 1 day ago
    },
    {
      id: 2,
      user_id: 103,
      product_id: 100,
      grant_type: 'subscription_cycle',
      status: 'active',
      valid_until: new Date(Date.now() + 30 * 86400000).toISOString() // 30 days in future
    }
  ];

  let premium_subscriptions = [
    {
      id: 1,
      user_id: 102,
      provider: 'razorpay',
      status: 'active',
      current_period_end: new Date(Date.now() - 86400000).toISOString() // 1 day ago
    }
  ];

  let paid_subscriptions = [
    {
      id: 1,
      user_id: 103,
      product_id: 100,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() // 30 days in future
    }
  ];

  let paid_orders = [];
  let paid_product_events = [];

  const mockClient = {
    query: async (sql, params = []) => {
      // 1. Roles
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

      // 2. Products
      if (/FROM paid_products/i.test(sql) && (/code = \$1/i.test(sql) || /id = \$1/i.test(sql))) {
        const val = params[0];
        const p = paid_products.find(x => x.code === val || x.id === Number(val));
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || '' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 3. Expire grants in Step 2
      if (/UPDATE user_product_grants/i.test(sql) && /SET status = 'expired'/i.test(sql)) {
        let expired = [];
        for (const g of user_product_grants) {
          if (g.status === 'active' && g.valid_until && new Date(g.valid_until) <= new Date()) {
            g.status = 'expired';
            expired.push(g);
          }
        }
        return { rows: expired, rowCount: expired.length };
      }

      // 4. Expire subscriptions in Step 3
      if (/UPDATE paid_subscriptions/i.test(sql) && /SET status = 'expired'/i.test(sql)) {
        let expired = [];
        for (const s of paid_subscriptions) {
          if (s.status === 'active' && s.current_period_end && new Date(s.current_period_end) <= new Date()) {
            s.status = 'expired';
            expired.push(s);
          }
        }
        return { rows: expired, rowCount: expired.length };
      }
      if (/UPDATE premium_subscriptions/i.test(sql) && /SET status = 'expired'/i.test(sql)) {
        for (const ps of premium_subscriptions) {
          if (['active', 'authenticated'].includes(ps.status) && ps.current_period_end && new Date(ps.current_period_end) <= new Date()) {
            ps.status = 'expired';
          }
        }
        return { rows: [], rowCount: 1 };
      }

      // 5. Candidate users
      if (/SELECT DISTINCT u\.id, u\.app_role, u\.email/i.test(sql)) {
        return { rows: users.map(u => ({ id: u.id, app_role: u.app_role, email: u.email })), rowCount: users.length };
      }

      // 6. User queries
      if (/FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 7. User role updates
      if (/UPDATE users SET app_role = 'PREMIUM'/i.test(sql)) {
        const userId = Number(params[params.length - 1]);
        const u = users.find(x => x.id === userId);
        if (u) u.app_role = ROLES.PREMIUM;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE users SET app_role = 'USER'/i.test(sql)) {
        const userId = Number(params[params.length - 1]);
        const u = users.find(x => x.id === userId);
        if (u) {
          u.app_role = ROLES.USER;
          u.premium_source = null;
        }
        return { rows: [], rowCount: 1 };
      }

      // 8. Subscriptions & Grants queries inside sync logic
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

      // 9. User Roles queries & inserts
      if (/SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = \$1/i.test(sql)) {
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

      // 10. Audit logs & events
      if (/INSERT INTO role_audit_log/i.test(sql) || /INSERT INTO paid_product_events/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  };

  return { mockClient, users, user_roles, user_product_grants, premium_subscriptions, paid_subscriptions };
}

test('Reconciliation Regression: Hari Chandana (no entitlement) & Hari B (expired history) MUST NOT get PREMIUM role', async () => {
  const { mockClient, users, user_roles } = createRegressionMockDb();

  // Run reconciliation for PREMIUM product
  const result = await reconcilePaidProduct('PREMIUM', { client: mockClient, dryRun: false });

  // 1. Hari Chandana (user 101) - had NO history at all
  const hariChandana = users.find(u => u.id === 101);
  assert.equal(hariChandana.app_role, ROLES.USER, 'Hari Chandana app_role must remain USER');
  const hariChandanaRole = user_roles.find(ur => ur.user_id === 101 && ur.role_id === 2);
  assert.equal(hariChandanaRole, undefined, 'Hari Chandana must NOT have PREMIUM role in user_roles');

  // 2. Hari B (user 102) - had expired recurring grants/sub (period ended yesterday)
  const hariB = users.find(u => u.id === 102);
  assert.equal(hariB.app_role, ROLES.USER, 'Hari B app_role must remain USER');
  const hariBRole = user_roles.find(ur => ur.user_id === 102 && ur.role_id === 2);
  assert.equal(hariBRole, undefined, 'Hari B must NOT have PREMIUM role in user_roles');

  // 3. Active subscription user (user 103) - had valid entitlement, missing role -> should be GRANTED
  const activeUser = users.find(u => u.id === 103);
  assert.equal(activeUser.app_role, ROLES.PREMIUM, 'Active user app_role must become PREMIUM');
  const activeUserRole = user_roles.find(ur => ur.user_id === 103 && ur.role_id === 2);
  assert.notEqual(activeUserRole, undefined, 'Active user must receive PREMIUM role in user_roles');

  // 4. Stale role user (user 104) - had stale PREMIUM role with expired entitlement -> should be REVOKED
  const staleUser = users.find(u => u.id === 104);
  assert.equal(staleUser.app_role, ROLES.USER, 'Stale user app_role must be revoked to USER');
  const staleUserRole = user_roles.find(ur => ur.user_id === 104 && ur.role_id === 2);
  assert.equal(staleUserRole, undefined, 'Stale user PREMIUM role must be deleted from user_roles');
});
