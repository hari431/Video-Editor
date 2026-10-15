import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES } from '../src/auth/admin.js';
import {
  reconcilePaidProduct,
  reconcileAllPaidProducts
} from '../src/auth/paidProducts.js';

export function createMockDb() {
  let roles = [
    { id: 1, name: 'USER' },
    { id: 2, name: 'PREMIUM' },
    { id: 3, name: 'ADMIN' },
    { id: 4, name: 'OWNER' },
    { id: 10, name: 'COURSE_JAVA' }
  ];

  let users = [
    { id: 1, email: 'owner@example.com', app_role: ROLES.OWNER },
    { id: 2, email: 'admin@example.com', app_role: ROLES.ADMIN },
    { id: 10, email: 'user10@example.com', app_role: ROLES.USER },
    { id: 11, email: 'user11@example.com', app_role: ROLES.USER },
    { id: 12, email: 'user12@example.com', app_role: ROLES.USER },
    { id: 13, email: 'user13@example.com', app_role: ROLES.USER },
    { id: 14, email: 'user14@example.com', app_role: ROLES.USER }
  ];

  let paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_enabled: true },
    { id: 200, code: 'JAVA_PRO', name: 'Java Masterclass', role_id: 10, is_enabled: true },
    { id: 300, code: 'ARCHIVED', name: 'Archived Course', role_id: 10, is_enabled: false }
  ];

  let user_roles = [];
  let user_product_grants = [];
  let paid_subscriptions = [];
  let paid_orders = [];
  let paid_product_events = [];
  let nextGrantId = 1;
  let nextEventId = 1;

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

      // 2. Products
      if (/SELECT \* FROM paid_products WHERE is_enabled = true/i.test(sql)) {
        const prods = paid_products.filter(p => p.is_enabled);
        return { rows: prods, rowCount: prods.length };
      }
      if (/FROM paid_products/i.test(sql) && /code = \$1/i.test(sql)) {
        const p = paid_products.find(x => x.code === params[0]);
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || '' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM paid_products/i.test(sql) && /id = \$1/i.test(sql)) {
        const p = paid_products.find(x => x.id === Number(params[0]));
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || '' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 3. Grants count (dry run)
      if (/SELECT COUNT\(\*\)::int AS cnt FROM user_product_grants/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const matches = user_product_grants.filter(g =>
          g.product_id === prodId &&
          g.status === 'active' &&
          g.valid_until &&
          new Date(g.valid_until).getTime() <= now
        );
        return { rows: [{ cnt: matches.length }], rowCount: 1 };
      }

      // 4. Update expired grants (live)
      if (/UPDATE user_product_grants\s+SET status = 'expired'/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const updated = [];
        for (const g of user_product_grants) {
          if (g.product_id === prodId && g.status === 'active' && g.valid_until && new Date(g.valid_until).getTime() <= now) {
            g.status = 'expired';
            g.updated_at = new Date();
            updated.push(g);
          }
        }
        return { rows: updated, rowCount: updated.length };
      }

      // 5. Active grants lookup
      if (/SELECT \* FROM user_product_grants/i.test(sql) && /status = 'active'/i.test(sql)) {
        const uid = Number(params[0]);
        const pid = Number(params[1]);
        const now = Date.now();
        const active = user_product_grants.filter(g =>
          g.user_id === uid &&
          g.product_id === pid &&
          g.status === 'active' &&
          (!g.valid_until || new Date(g.valid_until).getTime() > now)
        );
        return { rows: active, rowCount: active.length };
      }

      // 6. Subscriptions count (dry run)
      if (/SELECT COUNT\(\*\)::int AS cnt FROM paid_subscriptions/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const matches = paid_subscriptions.filter(s =>
          s.product_id === prodId &&
          s.status === 'active' &&
          s.cancel_at_period_end &&
          s.current_period_end &&
          new Date(s.current_period_end).getTime() <= now
        );
        return { rows: [{ cnt: matches.length }], rowCount: 1 };
      }

      // 7. Update expired subscriptions (live)
      if (/UPDATE paid_subscriptions\s+SET status = 'expired'/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const updated = [];
        for (const s of paid_subscriptions) {
          if (s.product_id === prodId && s.status === 'active' && s.cancel_at_period_end && s.current_period_end && new Date(s.current_period_end).getTime() <= now) {
            s.status = 'expired';
            s.updated_at = new Date();
            updated.push(s);
          }
        }
        return { rows: updated, rowCount: updated.length };
      }

      // 8. Active subscriptions check for user
      if (/FROM paid_subscriptions/i.test(sql) && /user_id = \$1/i.test(sql) && /status IN \('active'/i.test(sql)) {
        const uid = Number(params[0]);
        const pid = Number(params[1]);
        const now = Date.now();
        const subs = paid_subscriptions.filter(s =>
          s.user_id === uid &&
          s.product_id === pid &&
          ['active', 'authenticated'].includes(s.status) &&
          (!s.current_period_end || new Date(s.current_period_end).getTime() > now)
        );
        return { rows: subs, rowCount: subs.length };
      }

      // 9. Candidate users query
      if (/FROM users u/i.test(sql) && /SELECT DISTINCT/i.test(sql)) {
        const prodId = Number(params[0]);
        const roleId = Number(params[1]);
        const code = params[2];
        const allUsers = Boolean(params[3]);
        const limit = Number(params[4]) || 5000;

        let candidates = [];
        if (allUsers) {
          candidates = [...users];
        } else {
          candidates = users.filter(u => {
            const hasGrant = user_product_grants.some(g => g.user_id === u.id && g.product_id === prodId);
            const hasSub = paid_subscriptions.some(s => s.user_id === u.id && s.product_id === prodId);
            const hasOrder = paid_orders.some(o => o.user_id === u.id && o.product_id === prodId);
            const hasRole = user_roles.some(ur => ur.user_id === u.id && ur.role_id === roleId);
            return hasGrant || hasSub || hasOrder || hasRole;
          });
        }
        candidates.sort((a, b) => a.id - b.id);
        const sliced = candidates.slice(0, limit);
        return { rows: sliced, rowCount: sliced.length };
      }

      // 10. Single user query for syncProductRbacRole
      if (/FROM users/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 11. User roles lookup
      if (/SELECT/i.test(sql) && /FROM user_roles/i.test(sql) && /WHERE user_id = \$1/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }

      // 12. Insert or update user_roles
      if (/INSERT INTO user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        let src = params[2];
        if (!src && /'payment_system'/i.test(sql)) {
          src = 'payment_system';
        }
        if (!src) src = 'manual';
        const existing = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        if (existing) {
          existing.assignment_source = src;
        } else {
          user_roles.push({ user_id: uid, role_id: rid, assignment_source: src });
        }
        return { rowCount: 1 };
      }

      // 13. Delete from user_roles
      if (/DELETE FROM user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const src = params[2];
        const idx = user_roles.findIndex(x => x.user_id === uid && x.role_id === rid && (src ? x.assignment_source === src : true));
        if (idx !== -1) {
          user_roles.splice(idx, 1);
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }

      // 14. Audit log in paid_product_events
      if (/INSERT INTO paid_product_events/i.test(sql)) {
        const evt = {
          id: nextEventId++,
          product_id: params[0],
          user_id: params[1],
          entitlement_id: params[2],
          event_type: params[3],
          provider_event_id: params[4],
          previous_status: params[5],
          new_status: params[6],
          message: params[7],
          payload: JSON.parse(params[8] || '{}'),
          created_at: new Date()
        };
        paid_product_events.push(evt);
        return { rows: [evt], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },

    // Test Helpers
    addGrant: (g) => {
      const grant = {
        id: nextGrantId++,
        user_id: g.user_id,
        product_id: g.product_id,
        plan_id: g.plan_id || null,
        grant_type: g.grant_type || 'one_time_purchase',
        status: g.status || 'active',
        valid_from: g.valid_from || new Date(),
        valid_until: g.valid_until || null,
        created_at: new Date(),
        updated_at: new Date()
      };
      user_product_grants.push(grant);
      return grant;
    },

    addRole: (ur) => {
      user_roles.push({
        user_id: ur.user_id,
        role_id: ur.role_id,
        assignment_source: ur.assignment_source || 'manual'
      });
    },

    hasRole: (userId, roleId) => {
      return user_roles.some(ur => ur.user_id === userId && ur.role_id === roleId);
    },

    getRoleAssignmentSource: (userId, roleId) => {
      const ur = user_roles.find(x => x.user_id === userId && x.role_id === roleId);
      return ur ? ur.assignment_source : null;
    },

    getGrants: () => user_product_grants,
    getUserRoles: () => user_roles,
    getEvents: () => paid_product_events
  };

  return mockClient;
}

test('Phase 2C - Generic Paid Product Reconciliation Suite', async (t) => {

  await t.test('1. Expire/revoke stale payment grants and payment_system roles', async () => {
    const db = createMockDb();

    // User 10 has a grant for JAVA_PRO that expired 2 days ago, but status is still 'active'
    db.addGrant({
      user_id: 10,
      product_id: 200, // JAVA_PRO
      status: 'active',
      valid_until: new Date(Date.now() - 2 * 86400000)
    });

    // User 10 currently holds JAVA_PRO role from payment_system
    db.addRole({
      user_id: 10,
      role_id: 10, // COURSE_JAVA
      assignment_source: 'payment_system'
    });

    // Verify initial state
    assert.equal(db.hasRole(10, 10), true);
    assert.equal(db.getRoleAssignmentSource(10, 10), 'payment_system');

    // Run reconciliation for JAVA_PRO
    const result = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.productCode, 'JAVA_PRO');
    assert.equal(result.grantsExpired, 1);
    assert.equal(result.rolesRevoked, 1);

    // Verify role was revoked
    assert.equal(db.hasRole(10, 10), false);
    // Verify grant is now expired
    const g = db.getGrants()[0];
    assert.equal(g.status, 'expired');
  });

  await t.test('2. Restore missing payment_system roles when valid entitlement exists', async () => {
    const db = createMockDb();

    // User 10 has a valid active grant for JAVA_PRO (expires in 10 days)
    db.addGrant({
      user_id: 10,
      product_id: 200, // JAVA_PRO
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    // But user_roles is missing the COURSE_JAVA role
    assert.equal(db.hasRole(10, 10), false);

    // Run reconciliation
    const result = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.rolesGranted, 1);

    // Verify role was granted with assignment_source = 'payment_system'
    assert.equal(db.hasRole(10, 10), true);
    assert.equal(db.getRoleAssignmentSource(10, 10), 'payment_system');
  });

  await t.test('3. Strictly preserve manual RBAC assignments even without active entitlement', async () => {
    const db = createMockDb();

    // User 11 was manually granted the COURSE_JAVA role by an admin
    db.addRole({
      user_id: 11,
      role_id: 10,
      assignment_source: 'manual'
    });

    // User 11 has NO grants for JAVA_PRO
    assert.equal(db.hasRole(11, 10), true);

    // Run reconciliation
    const result = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.rolesRevoked, 0);
    assert.equal(result.rolesPreservedManual, 1);

    // Verify manual role is STILL present and STILL manual
    assert.equal(db.hasRole(11, 10), true);
    assert.equal(db.getRoleAssignmentSource(11, 10), 'manual');
  });

  await t.test('4. Manual role is preserved and NOT overwritten when valid entitlement exists', async () => {
    const db = createMockDb();

    // User 11 has manual assignment
    db.addRole({
      user_id: 11,
      role_id: 10,
      assignment_source: 'manual'
    });

    // User 11 ALSO has an active grant
    db.addGrant({
      user_id: 11,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    const result = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.rolesPreservedManual, 1);
    assert.equal(result.rolesGranted, 0);

    // Assignment source remains 'manual'
    assert.equal(db.getRoleAssignmentSource(11, 10), 'manual');
  });

  await t.test('5. Strictly protect OWNER and ADMIN users from modification', async () => {
    const db = createMockDb();

    // Owner (user 1) and Admin (user 2) have expired payment grants
    db.addGrant({
      user_id: 1, // OWNER
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() - 5 * 86400000)
    });
    db.addRole({
      user_id: 1,
      role_id: 10,
      assignment_source: 'payment_system'
    });

    db.addGrant({
      user_id: 2, // ADMIN
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() - 5 * 86400000)
    });
    db.addRole({
      user_id: 2,
      role_id: 10,
      assignment_source: 'payment_system'
    });

    const result = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.skippedProtected, 2);
    assert.equal(result.rolesRevoked, 0);

    // Roles for Owner and Admin are NOT revoked
    assert.equal(db.hasRole(1, 10), true);
    assert.equal(db.hasRole(2, 10), true);
  });

  await t.test('6. Strictly product-scoped: reconciling Product A never touches Product B roles', async () => {
    const db = createMockDb();

    // User 12 has an active grant for Product 100 (PREMIUM)
    db.addGrant({
      user_id: 12,
      product_id: 100, // PREMIUM
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    // User 12 has an expired grant for Product 200 (JAVA_PRO)
    db.addGrant({
      user_id: 12,
      product_id: 200, // JAVA_PRO
      status: 'active',
      valid_until: new Date(Date.now() - 2 * 86400000)
    });
    db.addRole({
      user_id: 12,
      role_id: 10, // JAVA role from payment_system
      assignment_source: 'payment_system'
    });

    // Reconcile JAVA_PRO only
    const resultJava = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });
    assert.equal(resultJava.rolesRevoked, 1);
    assert.equal(db.hasRole(12, 10), false); // JAVA role revoked

    // Reconcile JAVA_PRO did NOT touch PREMIUM grant or give PREMIUM role
    assert.equal(db.hasRole(12, 2), false); // PREMIUM role not granted by JAVA reconciliation
    const premiumGrant = db.getGrants().find(g => g.product_id === 100);
    assert.equal(premiumGrant.status, 'active'); // PREMIUM grant untouched
  });

  await t.test('7. Dry-Run Mode: computes accurate changes without modifying DB state', async () => {
    const db = createMockDb();

    // User 13 has an expired grant and payment_system role
    db.addGrant({
      user_id: 13,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() - 1 * 86400000)
    });
    db.addRole({
      user_id: 13,
      role_id: 10,
      assignment_source: 'payment_system'
    });

    // User 14 has a valid grant but missing role
    db.addGrant({
      user_id: 14,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    // Run with dryRun = true
    const dryResult = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: true });

    assert.equal(dryResult.dryRun, true);
    assert.equal(dryResult.grantsExpired, 1);
    assert.equal(dryResult.rolesRevoked, 1);
    assert.equal(dryResult.rolesGranted, 1);

    // CRITICAL: Database MUST NOT be modified in dry run
    assert.equal(db.hasRole(13, 10), true); // NOT revoked
    assert.equal(db.hasRole(14, 10), false); // NOT granted
    const grant13 = db.getGrants().find(g => g.user_id === 13);
    assert.equal(grant13.status, 'active'); // NOT marked expired

    // Also verify NO audit events logged in dry run
    assert.equal(db.getEvents().length, 0);
  });

  await t.test('8. Live Run records audit event in paid_product_events', async () => {
    const db = createMockDb();

    db.addGrant({
      user_id: 10,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    const liveResult = await reconcilePaidProduct('JAVA_PRO', { client: db, dryRun: false });
    assert.equal(liveResult.dryRun, false);

    const events = db.getEvents();
    assert.equal(events.length, 1);
    const evt = events[0];
    assert.equal(evt.event_type, 'product_reconciliation_run');
    assert.equal(evt.product_id, 200);
    assert.equal(evt.payload.productCode, 'JAVA_PRO');
    assert.equal(evt.payload.rolesGranted, 1);
  });

  await t.test('9. Reconcile all enabled paid products: iterates enabled and skips disabled', async () => {
    const db = createMockDb();

    // User 10 has valid grant for JAVA_PRO
    db.addGrant({
      user_id: 10,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() + 10 * 86400000)
    });

    // User 11 has manual role for JAVA_PRO
    db.addRole({
      user_id: 11,
      role_id: 10,
      assignment_source: 'manual'
    });

    const allResult = await reconcileAllPaidProducts({ client: db, dryRun: false });

    assert.equal(allResult.success, true);
    // Should have reconciled 2 enabled products: PREMIUM (100) and JAVA_PRO (200), ignoring ARCHIVED (300)
    assert.equal(allResult.totalProducts, 2);
    assert.equal(allResult.products.length, 2);
    assert.equal(allResult.rolesGranted, 1);
    assert.equal(allResult.rolesPreservedManual, 1);

    const productCodes = allResult.products.map(p => p.productCode);
    assert.ok(productCodes.includes('PREMIUM'));
    assert.ok(productCodes.includes('JAVA_PRO'));
    assert.ok(!productCodes.includes('ARCHIVED'));
  });

  await t.test('10. Invalid product code returns clean error response', async () => {
    const db = createMockDb();
    const result = await reconcilePaidProduct('NON_EXISTENT_XYZ', { client: db });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Product not found');
  });

  await t.test('11. Manual Admin/API routes are protected and correctly mapped', async () => {
    const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/server.js'), 'utf8');

    // Verify all-products reconciliation endpoint
    assert.ok(serverSrc.includes("app.post('/admin/paid-products/reconcile'"), 'Should expose /admin/paid-products/reconcile');
    assert.ok(serverSrc.includes("app.post('/api/admin/paid-products/reconcile'"), 'Should expose /api/admin/paid-products/reconcile');

    // Verify single-product reconciliation endpoint
    assert.ok(serverSrc.includes("app.post('/admin/paid-products/:productCodeOrId/reconcile'"), 'Should expose /admin/paid-products/:productCodeOrId/reconcile');
    assert.ok(serverSrc.includes("app.post('/api/admin/paid-products/:productCodeOrId/reconcile'"), 'Should expose /api/admin/paid-products/:productCodeOrId/reconcile');

    // Verify security middlewares on these routes
    const allReconcileMatch = serverSrc.match(/app\.post\('\/admin\/paid-products\/reconcile',\s*([^;]+)\);/);
    assert.ok(allReconcileMatch, 'All reconcile route registration found');
    assert.ok(allReconcileMatch[1].includes('requireAuth'), 'Must requireAuth');
    assert.ok(allReconcileMatch[1].includes('requireAdmin'), 'Must requireAdmin');
    assert.ok(allReconcileMatch[1].includes('requireSameOrigin'), 'Must requireSameOrigin');

    const oneReconcileMatch = serverSrc.match(/app\.post\('\/admin\/paid-products\/:productCodeOrId\/reconcile',\s*([^;]+)\);/);
    assert.ok(oneReconcileMatch, 'One reconcile route registration found');
    assert.ok(oneReconcileMatch[1].includes('requireAuth'), 'Must requireAuth');
    assert.ok(oneReconcileMatch[1].includes('requireAdmin'), 'Must requireAdmin');
    assert.ok(oneReconcileMatch[1].includes('requireSameOrigin'), 'Must requireSameOrigin');
  });

});
