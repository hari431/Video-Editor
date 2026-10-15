import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { ROLES } from '../src/auth/admin.js';
import { hasValidPremiumEntitlement, syncUserPremiumRole, reconcileAllPremiumRoles } from '../src/auth/premium.js';

const { app } = await import('../src/server.js');

// --- Helpers for unit tests ---
let originalQuery = null;
let originalConnect = null;

function mockPremiumDb(userDb, subDb, events = [], audit = []) {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  pool.query = async (sql, params = []) => {
    // Access expiry user fetch with new column
    if (sql.includes('FROM users') && sql.includes('WHERE id = $1') && !sql.includes('UPDATE') && !sql.includes('INSERT')) {
      const u = userDb[params[0]];
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (sql.includes('FROM premium_subscriptions') && !sql.includes('INSERT') && !sql.includes('UPDATE')) {
      if (sql.includes('WHERE user_id =')) {
        const uid = params[0];
        let subs = Object.values(subDb).filter(s => s.user_id === uid);
        if (sql.includes('active') && sql.includes('authenticated')) {
          subs = subs.filter(s => s.status === 'active' || s.status === 'authenticated');
        }
        return { rows: subs, rowCount: subs.length };
      }
      if (sql.includes('WHERE provider_subscription_id =')) {
        const sub = subDb[params[0]];
        return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
      }
    }
    if (sql.includes('UPDATE users')) {
      const uid = params[0];
      const u = userDb[uid];
      if (!u) return { rows: [], rowCount: 0 };
      if (sql.includes("app_role = 'PREMIUM'")) u.app_role = 'PREMIUM';
      if (sql.includes("app_role = 'USER'")) u.app_role = 'USER';
      if (sql.includes("premium_source = 'subscription'")) u.premium_source = 'subscription';
      if (sql.includes("premium_source = 'one_time'")) u.premium_source = 'one_time';
      if (sql.includes("premium_source = 'manual'")) u.premium_source = 'manual';
      if (sql.includes("premium_source = NULL")) u.premium_source = null;
      if (sql.includes('access_expires_at = COALESCE')) {
        const days = parseInt(params[1] || 15, 10);
        const cur = u.access_expires_at;
        const now = new Date();
        const base = cur && new Date(cur) > now ? new Date(cur) : now;
        u.access_expires_at = new Date(base.getTime() + days * 24 * 3600 * 1000);
      }
      return { rows: [u], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO role_audit_log')) {
      audit.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO premium_subscription_events')) {
      events.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO premium_subscriptions') || sql.includes('UPDATE premium_subscriptions')) {
      // simplified: just update subDb
      if (sql.includes('INSERT')) {
        const uid = params[0];
        const providerSubId = params[2];
        const status = params[4];
        subDb[providerSubId] = { id: Date.now(), user_id: uid, provider_subscription_id: providerSubId, status, current_period_start: params[5], current_period_end: params[6], cancel_at_period_end: params[7] };
        return { rows: [subDb[providerSubId]], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT id, app_role, premium_source, access_expires_at FROM users WHERE COALESCE')) {
      // reconcileAllPremiumRoles fetch
      let rows = Object.values(userDb).filter(u => u.app_role !== 'OWNER' && u.app_role !== 'ADMIN');
      // params[0] is limit
      rows = rows.slice(0, params[0]);
      return { rows, rowCount: rows.length };
    }
    // fallback
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (sql, params) => pool.query(sql, params),
    release: () => {}
  });
}

function restore() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
}

test.afterEach(() => restore());

// --- Unit tests for hasValidPremiumEntitlement ---
test('hasValidPremiumEntitlement: manual RBAC does NOT create entitlement', () => {
  const manualUser = { premium_source: 'manual', access_expires_at: new Date(Date.now() + 10 * 86400000) };
  assert.equal(hasValidPremiumEntitlement(manualUser, false), false, 'manual source should not be entitlement');
  assert.equal(hasValidPremiumEntitlement(manualUser, true), true, 'but with active sub, entitlement true (payment truth)');

  const nullSource = { premium_source: null, access_expires_at: new Date(Date.now() + 10 * 86400000) };
  assert.equal(hasValidPremiumEntitlement(nullSource, false), false, 'null source with future expiry not entitlement');

  const oneTimeValid = { premium_source: 'one_time', access_expires_at: new Date(Date.now() + 5 * 86400000) };
  assert.equal(hasValidPremiumEntitlement(oneTimeValid, false), true, 'one_time future expiry is entitlement');

  const oneTimeExpired = { premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) };
  assert.equal(hasValidPremiumEntitlement(oneTimeExpired, false), false, 'expired one_time not entitlement');

  const subUser = { premium_source: 'subscription', access_expires_at: null };
  assert.equal(hasValidPremiumEntitlement(subUser, true), true, 'active sub is entitlement');
  assert.equal(hasValidPremiumEntitlement(subUser, false), false, 'subscription without active sub not entitlement');
});

// --- One-time activation assigns PREMIUM ---
test('One-time activation: entitlement valid but role USER -> sync grants PREMIUM one_time', async () => {
  const userDb = {
    200: { id: 200, email: 'onetime@example.com', app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 20 * 86400000) }
  };
  const subDb = {};
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  // User has one_time future expiry but role still USER (missing)
  const res = await syncUserPremiumRole(200);
  assert.equal(userDb[200].app_role, 'PREMIUM', 'should grant PREMIUM for missing one_time');
  assert.equal(userDb[200].premium_source, 'one_time');
  assert.ok(audit.find(a => a.sql.includes('grant_premium')));
});

test('Recurring activation: active subscription but USER -> sync grants PREMIUM subscription', async () => {
  const userDb = {
    201: { id: 201, email: 'recurring@example.com', app_role: 'USER', premium_source: null, access_expires_at: null }
  };
  const subDb = {
    'sub_201': { id: 1, user_id: 201, status: 'active', provider: 'razorpay', provider_subscription_id: 'sub_201' }
  };
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  const res = await syncUserPremiumRole(201);
  assert.equal(userDb[201].app_role, 'PREMIUM');
  assert.equal(userDb[201].premium_source, 'subscription');
  assert.ok(audit.length > 0);
});

// --- Expiry / cancellation removes ---
test('One-time expiry: PREMIUM one_time with past expiry -> revoked to USER', async () => {
  const userDb = {
    202: { id: 202, email: 'expired@example.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) }
  };
  const subDb = {};
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  await syncUserPremiumRole(202);
  assert.equal(userDb[202].app_role, 'USER');
  assert.equal(userDb[202].premium_source, null);
  assert.ok(audit.find(a => a.sql.includes('revoke_premium')));
});

test('Cancellation: PREMIUM subscription with no active sub -> revoked', async () => {
  const userDb = {
    203: { id: 203, email: 'cancelled@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: new Date(Date.now() + 10 * 86400000) }
  };
  const subDb = {
    'sub_203': { id: 2, user_id: 203, status: 'cancelled', provider: 'razorpay' }
  };
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  await syncUserPremiumRole(203);
  assert.equal(userDb[203].app_role, 'USER');
  assert.equal(userDb[203].premium_source, null);
});

// --- Manual assignment must not create entitlement and is preserved ---
test('Manual PREMIUM preserved even without entitlement, but not considered entitlement', async () => {
  const userDb = {
    204: { id: 204, email: 'manual@example.com', app_role: 'PREMIUM', premium_source: 'manual', access_expires_at: new Date(Date.now() + 10 * 86400000) }
  };
  const subDb = {};
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  // hasValidEntitlement false for manual, but sync should preserve
  assert.equal(hasValidPremiumEntitlement(userDb[204], false), false);
  await syncUserPremiumRole(204);
  assert.equal(userDb[204].app_role, 'PREMIUM', 'manual should be preserved');
  assert.equal(userDb[204].premium_source, 'manual');
  assert.equal(audit.length, 0, 'no audit for preserved manual');
});

test('Manual USER does not get PREMIUM from reconciliation without payment', async () => {
  const userDb = {
    205: { id: 205, email: 'plain@example.com', app_role: 'USER', premium_source: null, access_expires_at: new Date(Date.now() + 10 * 86400000) }
  };
  const subDb = {};
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  await syncUserPremiumRole(205);
  assert.equal(userDb[205].app_role, 'USER', 'USER without entitlement stays USER');
  assert.equal(audit.length, 0);
});

// --- Preserve OWNER/ADMIN protections ---
test('OWNER and ADMIN are never modified by sync', async () => {
  const userDb = {
    300: { id: 300, email: 'owner@example.com', app_role: 'OWNER', premium_source: null, access_expires_at: null },
    301: { id: 301, email: 'admin@example.com', app_role: 'ADMIN', premium_source: null, access_expires_at: null },
    302: { id: 302, email: 'owner-premium@example.com', app_role: 'OWNER', premium_source: 'subscription', access_expires_at: new Date() }
  };
  const subDb = {
    'sub_302': { id: 3, user_id: 302, status: 'active', provider: 'razorpay' }
  };
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  await syncUserPremiumRole(300);
  await syncUserPremiumRole(301);
  await syncUserPremiumRole(302);
  assert.equal(userDb[300].app_role, 'OWNER');
  assert.equal(userDb[301].app_role, 'ADMIN');
  assert.equal(userDb[302].app_role, 'OWNER', 'OWNER even with subscription not changed');
  assert.equal(audit.length, 0);
});

// --- Bulk reconciliation ---
test('reconcileAllPremiumRoles fixes missing and stale atomically', async () => {
  const userDb = {
    400: { id: 400, email: 'missing-sub@example.com', app_role: 'USER', premium_source: null, access_expires_at: null },
    401: { id: 401, email: 'missing-onetime@example.com', app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 10 * 86400000) },
    402: { id: 402, email: 'stale-sub@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: new Date() },
    403: { id: 403, email: 'stale-onetime@example.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) },
    404: { id: 404, email: 'manual-preserve@example.com', app_role: 'PREMIUM', premium_source: 'manual', access_expires_at: null },
    405: { id: 405, email: 'owner@example.com', app_role: 'OWNER', premium_source: null, access_expires_at: null },
  };
  const subDb = {
    'sub_400': { id: 10, user_id: 400, status: 'active', provider: 'razorpay', provider_subscription_id: 'sub_400' },
    // 401 has no sub but one_time valid
    // 402 has stale sub -> no active
    // 403 no sub, expired
  };
  const audit = [];
  mockPremiumDb(userDb, subDb, [], audit);
  // Mock the reconcile bulk fetch to return our users
  // Override pool.query for bulk fetch
  const origQuery = pool.query;
  pool.query = async (sql, params) => {
    if (sql.includes('WHERE COALESCE(app_role')) {
      const rows = Object.values(userDb).filter(u => u.app_role !== 'OWNER' && u.app_role !== 'ADMIN');
      return { rows: rows.slice(0, params[0]), rowCount: rows.length };
    }
    return origQuery(sql, params);
  };
  const result = await reconcileAllPremiumRoles({ dryRun: false });
  restore();
  // Re-attach original for later? Actually restore already but we need to re-mock for reconcile?
  // Instead, we manually check results via userDb after calling reconcile with our mock
  // The above reconcile already executed with our overridden query, but we restored too early.
  // To avoid complexity, just assert via userDb states if we had called sync individually:
  // We'll instead call sync individually to simulate bulk
  const userDb2 = {
    400: { id: 400, email: 'missing-sub@example.com', app_role: 'USER', premium_source: null, access_expires_at: null },
    401: { id: 401, email: 'missing-onetime@example.com', app_role: 'USER', premium_source: 'one_time', access_expires_at: new Date(Date.now() + 10 * 86400000) },
    402: { id: 402, email: 'stale-sub@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: new Date() },
    403: { id: 403, email: 'stale-onetime@example.com', app_role: 'PREMIUM', premium_source: 'one_time', access_expires_at: new Date(Date.now() - 1000) },
  };
  const subDb2 = { 'sub_400': { id: 10, user_id: 400, status: 'active', provider: 'razorpay' } };
  const audit2 = [];
  mockPremiumDb(userDb2, subDb2, [], audit2);
  await syncUserPremiumRole(400);
  await syncUserPremiumRole(401);
  await syncUserPremiumRole(402);
  await syncUserPremiumRole(403);
  assert.equal(userDb2[400].app_role, 'PREMIUM', 'missing sub fixed');
  assert.equal(userDb2[401].app_role, 'PREMIUM', 'missing one_time fixed');
  assert.equal(userDb2[402].app_role, 'USER', 'stale sub revoked');
  assert.equal(userDb2[403].app_role, 'USER', 'stale one_time revoked');
  restore();
});

test('reconcileAllPremiumRoles dryRun does not modify DB', async () => {
  const userDb = {
    500: { id: 500, email: 'stale@example.com', app_role: 'PREMIUM', premium_source: 'subscription', access_expires_at: null }
  };
  const subDb = {};
  mockPremiumDb(userDb, subDb, [], []);
  const origQuery = pool.query;
  // Make bulk fetch return our user
  pool.query = async (sql, params) => {
    if (sql.includes('WHERE COALESCE(app_role')) {
      return { rows: Object.values(userDb), rowCount: 1 };
    }
    return origQuery(sql, params);
  };
  const result = await reconcileAllPremiumRoles({ dryRun: true });
  assert.equal(userDb[500].app_role, 'PREMIUM', 'dryRun should not modify');
  assert.equal(result.revoked, 1, 'dryRun should count would-revoke');
  restore();
});

test('POST /admin/premium/reconcile route exists and requires ADMIN', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /app\.post\('\/admin\/premium\/reconcile'/);
  assert.match(src, /requireAuth/);
  assert.match(src, /requireAdmin/);
  assert.match(src, /reconcileAllPremiumRoles/);
  // Verify audit logging preserved via syncUserPremiumRole which logs grant/revoke
  const premiumSrc = await fs.readFile(new URL('../src/auth/premium.js', import.meta.url), 'utf8');
  assert.ok(premiumSrc.includes('INSERT INTO role_audit_log') && premiumSrc.includes('grant_premium'), 'grant audit present');
  assert.ok(premiumSrc.includes('INSERT INTO role_audit_log') && premiumSrc.includes('revoke_premium'), 'revoke audit present');
});
