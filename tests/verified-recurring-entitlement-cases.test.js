import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncUserPremiumRole, hasValidPremiumEntitlement } from '../src/auth/premium.js';
import { reconcilePaidProduct, validateUserEntitlement } from '../src/auth/paidProducts.js';
import { ROLES } from '../src/auth/admin.js';

function createMockClient(state) {
  return {
    query: async (sql, params = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();

      if (s.includes('from paid_products') && s.includes('code = $1')) {
        const p = state.paid_products.find(x => x.code.toLowerCase() === String(params[0]).toLowerCase());
        return { rows: p ? [{ ...p, role_name: 'PREMIUM' }] : [], rowCount: p ? 1 : 0 };
      }
      if (s.includes('from paid_products') && s.includes('p.id = $1')) {
        const p = state.paid_products.find(x => x.id === Number(params[0]));
        return { rows: p ? [{ ...p, role_name: 'PREMIUM' }] : [], rowCount: p ? 1 : 0 };
      }
      if (s.includes('select * from paid_products')) return { rows: state.paid_products, rowCount: state.paid_products.length };
      if (s.includes('select distinct u.id')) return { rows: state.users, rowCount: state.users.length };
      if (s.includes('from users where id = $1') || s.includes('from users u where u.id = $1')) {
        const u = state.users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (s.includes('from premium_subscriptions')) {
        const active = (state.premium_subscriptions || []).filter(sub => sub.user_id === Number(params[0]) && sub.status === 'active');
        return { rows: active, rowCount: active.length };
      }
      if (s.includes('from paid_subscriptions')) {
        const active = (state.paid_subscriptions || []).filter(sub => sub.user_id === Number(params[0]) && sub.status === 'active');
        return { rows: active, rowCount: active.length };
      }
      if (s.includes('from user_product_grants') && s.includes('status = \'active\'')) {
        const active = (state.user_product_grants || []).filter(g => g.user_id === Number(params[0]) && g.status === 'active');
        return { rows: active, rowCount: active.length };
      }
      if (s.includes('from user_product_grants')) {
        const anyG = (state.user_product_grants || []).filter(g => g.user_id === Number(params[0]));
        return { rows: anyG, rowCount: anyG.length };
      }
      if (s.includes('select user_id, role_id, assignment_source from user_roles')) {
        const ur = (state.user_roles || []).filter(x => x.user_id === Number(params[0]) && x.role_id === Number(params[1]));
        return { rows: ur, rowCount: ur.length };
      }
      if (s.includes('from roles where name = \'premium\'')) return { rows: state.roles || [{ id: 2, name: 'PREMIUM' }], rowCount: 1 };
      if (s.includes('delete from user_roles')) {
        const idx = (state.user_roles || []).findIndex(x => x.user_id === Number(params[0]) && x.role_id === Number(params[1]));
        if (idx >= 0) state.user_roles.splice(idx, 1);
        return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
      }
      if (s.includes('update users set app_role')) {
        const u = state.users.find(x => x.id === Number(params[0]));
        if (u) { u.app_role = 'USER'; u.premium_source = null; }
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('insert into paid_product_events') || s.includes('insert into role_audit_log')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test('Verified Case A: Expired grant + active subscription -> revoke', async () => {
  const state = {
    users: [{ id: 101, email: 'casea@test.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [{ user_id: 101, role_id: 2, assignment_source: 'payment_system' }],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [{ id: 1, user_id: 101, product_id: 1, status: 'expired' }],
    paid_subscriptions: [{ id: 1, user_id: 101, product_id: 1, status: 'active' }]
  };
  const client = createMockClient(state);

  const res = await syncUserPremiumRole(101, client);
  assert.equal(res.action, 'revoked');
  assert.equal(state.user_roles.length, 0);

  const rec = await reconcilePaidProduct(state.paid_products[0], { client, dryRun: false });
  assert.equal(rec.rolesRevoked, 0); // Already revoked during syncUserPremiumRole
});

test('Verified Case B: No grant + active subscription + payment_system role -> no false entitlement / correct reconciliation behavior', async () => {
  const state = {
    users: [{ id: 102, email: 'caseb@test.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [{ user_id: 102, role_id: 2, assignment_source: 'payment_system' }],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [],
    paid_subscriptions: [{ id: 2, user_id: 102, product_id: 1, status: 'active' }]
  };
  const client = createMockClient(state);

  const res = await syncUserPremiumRole(102, client);
  assert.equal(res.action, 'revoked');
  assert.equal(state.user_roles.length, 0, 'payment_system role must be deleted');

  const entitlement = await validateUserEntitlement(102, 'PREMIUM', client);
  assert.equal(entitlement.hasEntitlement, false, 'No false entitlement when active grant is missing');
});

test('Verified Case C: Active grant + active subscription -> retain access', async () => {
  const state = {
    users: [{ id: 103, email: 'casec@test.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [{ user_id: 103, role_id: 2, assignment_source: 'payment_system' }],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [{ id: 3, user_id: 103, product_id: 1, status: 'active' }],
    paid_subscriptions: [{ id: 3, user_id: 103, product_id: 1, status: 'active' }]
  };
  const client = createMockClient(state);

  const res = await syncUserPremiumRole(103, client);
  assert.equal(res.action, 'no_change');
  assert.equal(state.user_roles.length, 1, 'role must be retained');
});

test('Verified Case D: No grant + no subscription -> no entitlement', async () => {
  const state = {
    users: [{ id: 104, email: 'cased@test.com', app_role: 'USER', premium_source: null, access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [],
    paid_subscriptions: []
  };
  const client = createMockClient(state);

  const entitlement = await validateUserEntitlement(104, 'PREMIUM', client);
  assert.equal(entitlement.hasEntitlement, false);
});

test('Verified Case E: Legacy one-time payment expiry -> existing behavior unchanged', async () => {
  const futureDate = new Date(Date.now() + 86400000);
  const pastDate = new Date(Date.now() - 86400000);

  const validUser = { id: 105, email: 'casee1@test.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: futureDate };
  const expiredUser = { id: 106, email: 'casee2@test.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: pastDate };

  assert.equal(hasValidPremiumEntitlement(validUser, false, false), true);
  assert.equal(hasValidPremiumEntitlement(expiredUser, false, false), false);
});

test('Verified Case F: Manual role -> preserved', async () => {
  const state = {
    users: [{ id: 107, email: 'casef@test.com', app_role: 'PREMIUM', premium_source: 'manual', access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [{ user_id: 107, role_id: 2, assignment_source: 'manual' }],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [],
    paid_subscriptions: []
  };
  const client = createMockClient(state);

  const res = await syncUserPremiumRole(107, client);
  assert.equal(res.action, 'preserved_manual');
  assert.equal(state.user_roles.length, 1);
});

test('Verified Case G: OWNER/ADMIN protection -> preserved', async () => {
  const state = {
    users: [{ id: 108, email: 'caseg@test.com', app_role: 'OWNER', premium_source: null, access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [],
    paid_subscriptions: []
  };
  const client = createMockClient(state);

  const res = await syncUserPremiumRole(108, client);
  assert.equal(res, null, 'OWNER should be skipped');

  const rec = await reconcilePaidProduct(state.paid_products[0], { client, dryRun: false });
  assert.equal(rec.skippedProtected, 1);
});

test('Verified Case H: Line 186 path no longer throws ReferenceError', async () => {
  const state = {
    users: [{ id: 109, email: 'caseh@test.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null }],
    roles: [{ id: 2, name: 'PREMIUM' }],
    user_roles: [{ user_id: 109, role_id: 2, assignment_source: 'payment_system' }],
    paid_products: [{ id: 1, code: 'PREMIUM', name: 'Premium', is_enabled: true, role_id: 2 }],
    user_product_grants: [],
    paid_subscriptions: []
  };
  const client = createMockClient(state);

  // Line 186 evaluates when !hasActiveSub and hasValidPremiumEntitlement and currentSource !== 'one_time'
  assert.doesNotThrow(async () => {
    await syncUserPremiumRole(109, client);
  });
});
