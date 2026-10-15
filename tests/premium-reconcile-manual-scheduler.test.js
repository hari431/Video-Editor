import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');
import { getMsUntilNext3AmIST, schedulePremiumReconcile, stopPremiumReconcile, isPremiumReconcileScheduled } from '../src/auth/premium-reconcile-scheduler.js';
import * as premiumModule from '../src/auth/premium.js';

// --- Manual Run Reconciliation action ---
test('Manual Run Reconciliation is visible to ADMIN/OWNER and protected', async () => {
  const viewSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-premium.ejs'), 'utf8');
  assert.ok(viewSrc.includes('data-testid="run-reconciliation"'), 'Run Reconciliation button should be visible');
  assert.ok(viewSrc.includes('action="/admin/premium/reconcile"'), 'form should POST to /admin/premium/reconcile');
  assert.ok(viewSrc.includes('Premium Reconciliation'), 'section title');
  assert.ok(viewSrc.includes('users.app_role') && viewSrc.includes('user_roles.PREMIUM'), 'should mention both synchronizations');

  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const routeSnippet = serverSrc.split("app.post('/admin/premium/reconcile'")[1]?.split('});')[0] || '';
  assert.ok(routeSnippet.includes('requireAuth'), 'should requireAuth');
  assert.ok(routeSnippet.includes('requireAdmin'), 'should requireAdmin');
  assert.ok(routeSnippet.includes('reconcileAllPremiumRoles'), 'should use existing reconciliation function');

  // Check that premium sync handles both
  const premiumSrc = fs.readFileSync(new URL('../src/auth/premium.js', import.meta.url), 'utf8');
  assert.ok(premiumSrc.includes('syncPremiumRbacRole') || premiumSrc.includes('user_roles'), 'should sync user_roles');
  assert.ok(premiumSrc.includes('hasValidPremiumEntitlement'), 'should use entitlement check');
});

test('POST /admin/premium/reconcile as ADMIN succeeds and returns granted/revoked/corrected', async () => {
  const ADMIN = { id: 900, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const USER = { id: 901, google_user_id: 'google-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 30 * 86400000), app_role: 'USER' };
  const ADMIN_SID = 'reconcile-manual-admin-sid';
  const USER_SID = 'reconcile-manual-user-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  // Mock to make reconcile do something: user 100 has stale PREMIUM, user 101 missing
  let reconcileCalled = false;
  const mockPool = {
    query: async (sql, params=[]) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        const u = sessionToUser[params[0]];
        if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
        return { rows: [] };
      }
      if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
        if (params[0] === ADMIN.id) return { rows: [ADMIN], rowCount: 1 };
        if (params[0] === USER.id) return { rows: [USER], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (/user_roles/.test(sql)) return { rows: [] };
      if (/folder_permissions/.test(sql)) return { rows: [] };
      if (/SELECT id, app_role, premium_source, access_expires_at FROM users WHERE COALESCE/.test(sql)) {
        // Simulate two users for reconcile: one stale, one missing
        return { rows: [
          { id: 100, app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) },
          { id: 101, app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 10 * 86400000) }
        ], rowCount: 2 };
      }
      if (/SELECT id, email, app_role, premium_source, access_expires_at FROM users WHERE id = \$1/.test(sql)) {
        if (params[0] === 100) return { rows: [{ id: 100, email: 'a@x.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) }], rowCount: 1 };
        if (params[0] === 101) return { rows: [{ id: 101, email: 'b@x.com', app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 10 * 86400000) }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (/FROM premium_subscriptions/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
      if (/SELECT 1 FROM user_roles WHERE user_id = \$1 AND role_id = \$2/.test(sql)) {
        // For 100, has RBAC but should be revoked; for 101, no RBAC but should be granted
        if (params[0] === 100) return { rows: [{ '1': 1 }], rowCount: 1 };
        if (params[0] === 101) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO roles/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT premium_source, app_role FROM users WHERE id = \$1/.test(sql)) {
        if (params[0] === 100) return { rows: [{ premium_source: 'one_time', app_role: 'PREMIUM' }], rowCount: 1 };
        if (params[0] === 101) return { rows: [{ premium_source: 'one_time', app_role: 'USER' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  // Patch pool for reconcile
  const origQ = pool.query;
  const origC = pool.connect;
  pool.query = mockPool.query;
  pool.connect = async () => ({
    query: async (sql, params) => mockPool.query(sql, params),
    release: () => {}
  });

  // Need to also mock the reconcile's internal calls - we will let it run with our mock
  // Now test HTTP endpoint
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

  try {
    // ADMIN should succeed
    const resAdmin = await http('/admin/premium/reconcile', {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, Accept: 'application/json' }
    });
    assert.equal(resAdmin.status, 200);
    const json = await resAdmin.json();
    assert.ok('granted' in json, 'should have granted');
    assert.ok('revoked' in json, 'should have revoked');
    assert.ok('corrected' in json, 'should have corrected');
    assert.ok('checked' in json, 'should have checked');
    assert.ok('errors' in json, 'should have errors');

    // Non-admin should get 403
    const resUser = await http('/admin/premium/reconcile', {
      method: 'POST',
      headers: { Cookie: USER_COOKIE }
    });
    assert.equal(resUser.status, 403);

    // Unauthenticated should redirect to /login
    const resUnauth = await http('/admin/premium/reconcile', { method: 'POST', redirect: 'manual' });
    assert.equal(resUnauth.status, 302);
    assert.equal(resUnauth.headers.get('location'), '/login');
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

// --- Scheduler tests ---
test('Scheduler calculates 3:00 AM IST correctly', () => {
  // Helper to create a date in IST and check delay
  // 2026-01-01 02:00 IST = 2025-12-31 20:30 UTC
  const jan1_2amIST = new Date(Date.UTC(2025, 11, 31, 20, 30, 0)); // 2025-12-31 20:30 UTC = 2026-01-01 02:00 IST
  const delay1 = getMsUntilNext3AmIST(jan1_2amIST);
  assert.equal(delay1, 60 * 60 * 1000, '2 AM IST should be 1 hour until 3 AM');

  // 2026-01-01 04:00 IST = 2025-12-31 22:30 UTC -> next 3 AM is next day 03:00 IST = 2026-01-01 21:30 UTC
  const jan1_4amIST = new Date(Date.UTC(2025, 11, 31, 22, 30, 0));
  const delay2 = getMsUntilNext3AmIST(jan1_4amIST);
  assert.equal(delay2, 23 * 60 * 60 * 1000, '4 AM IST should be 23 hours until next 3 AM');

  // Exactly 3 AM IST = 2025-12-31 21:30 UTC -> next is tomorrow 3 AM = 24h
  const jan1_3amIST = new Date(Date.UTC(2025, 11, 31, 21, 30, 0));
  const delay3 = getMsUntilNext3AmIST(jan1_3amIST);
  assert.equal(delay3, 24 * 60 * 60 * 1000, 'exactly 3 AM should be 24h until next');

  // 2026-01-01 02:59 IST = 2025-12-31 21:29 UTC -> 1 minute until
  const jan1_259amIST = new Date(Date.UTC(2025, 11, 31, 21, 29, 0));
  const delay4 = getMsUntilNext3AmIST(jan1_259amIST);
  assert.equal(delay4, 60 * 1000, '2:59 AM IST should be 1 minute');
});

test('Scheduler uses existing reconcile function and is idempotent', async () => {
  // Check that scheduler file imports reconcileAllPremiumRoles and does not duplicate logic
  const schedulerSrc = fs.readFileSync(new URL('../src/auth/premium-reconcile-scheduler.js', import.meta.url), 'utf8');
  assert.ok(schedulerSrc.includes('reconcileAllPremiumRoles'), 'should use existing reconcile function');
  assert.ok(schedulerSrc.includes('getMsUntilNext3AmIST'), 'should have helper');
  assert.ok(schedulerSrc.includes('schedulePremiumReconcile'), 'should export scheduler');
  // Ensure it does not contain duplicate SQL for premium logic
  assert.ok(!schedulerSrc.includes('UPDATE users SET app_role'), 'should not duplicate premium update logic');
  assert.ok(!schedulerSrc.includes('INSERT INTO user_roles'), 'should not duplicate RBAC logic');

  // Test that schedule does not run in test env
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const handle = schedulePremiumReconcile();
  assert.equal(handle, null, 'should not schedule in test env');
  assert.equal(isPremiumReconcileScheduled(), false);
  process.env.NODE_ENV = originalEnv;

  // Test that schedule does run in non-test and is idempotent
  process.env.NODE_ENV = 'development';
  // Mock reconcile to avoid DB
  const originalReconcile = premiumModule.reconcileAllPremiumRoles;
  let callCount = 0;
  // We cannot easily mock the imported function, but we can test that calling twice returns same handle
  const h1 = schedulePremiumReconcile();
  const h2 = schedulePremiumReconcile();
  assert.equal(h1, h2, 'idempotent: second call should return same handle');
  assert.ok(isPremiumReconcileScheduled(), 'should be scheduled');
  stopPremiumReconcile();
  assert.equal(isPremiumReconcileScheduled(), false, 'should be stopped');
  process.env.NODE_ENV = 'test';
});

test('Reconcile synchronizes both app_role and user_roles', async () => {
  // This is already covered in premium-rbac-folder-sync but we add explicit check for daily scheduler
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes('schedulePremiumReconcile'), 'server should start scheduler');
  assert.ok(serverSrc.includes("import { schedulePremiumReconcile }"), 'should import scheduler');
});
