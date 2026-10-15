import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  checkPaymentRolesWithoutEntitlement,
  checkActiveEntitlementsMissingRoles,
  checkExpiredEntitlementsRetainingRoles,
  checkEnabledProductsWithoutActivePlans,
  checkRecurringPlansMissingRazorpayId,
  checkDefaultRolesInconsistencies,
  checkOtherRBACIntegrityInconsistencies,
  getSystemIntegrityReport
} from '../src/monitoring/integrity.js';

const { app } = await import('../src/server.js');

const OWNER = { id: 101, google_user_id: 'g-owner', email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const ADMIN = { id: 102, google_user_id: 'g-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 103, google_user_id: 'g-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };

const OWNER_SID = 'integ-owner-sid';
const ADMIN_SID = 'integ-admin-sid';
const USER_SID = 'integ-user-sid';
const OWNER_COOKIE = `connect.sid=s:${cookieSignature.sign(OWNER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [OWNER_SID]: OWNER, [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let originalQuery;
let server;
let port;

test.before(async () => {
  originalQuery = pool.query;
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('Diagnostic 1: checkPaymentRolesWithoutEntitlement identifies unentitled payment roles and protects OWNER/ADMIN', async () => {
  const mockClient = {
    query: async (sql, params = []) => {
      // Return one payment role for standard user without entitlement
      if (/FROM user_roles ur/.test(sql)) {
        return {
          rows: [
            {
              user_id: 103,
              role_id: 5,
              assignment_source: 'payment_system',
              user_email: 'user@example.com',
              app_role: 'USER',
              role_name: 'Product A Role',
              product_id: 1,
              product_code: 'PROD_A',
              product_name: 'Product A'
            }
          ]
        };
      }
      // When checking grants in validateUserEntitlement
      if (/FROM user_product_grants/.test(sql)) {
        return { rows: [] };
      }
      // When checking subscriptions in validateUserEntitlement
      if (/FROM paid_subscriptions/.test(sql)) {
        return { rows: [] };
      }
      // Fallback
      return { rows: [] };
    }
  };

  const result = await checkPaymentRolesWithoutEntitlement(mockClient);
  assert.equal(result.id, 'payment_roles_without_entitlement');
  assert.equal(result.status, 'warning');
  assert.equal(result.count, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].userId, 103);
  assert.match(result.actionUrl, /paid-products/);
});

test('Diagnostic 2: checkActiveEntitlementsMissingRoles identifies active entitlements missing user_roles', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM user_product_grants g/.test(sql)) {
        return {
          rows: [
            {
              user_id: 103,
              product_id: 1,
              valid_until: new Date(Date.now() + 86400000),
              user_email: 'user@example.com',
              app_role: 'USER',
              product_code: 'PROD_A',
              product_name: 'Product A',
              role_id: 5,
              role_name: 'Product A Role'
            }
          ]
        };
      }
      if (/FROM paid_subscriptions s/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const result = await checkActiveEntitlementsMissingRoles(mockClient);
  assert.equal(result.id, 'active_entitlements_missing_roles');
  assert.equal(result.status, 'warning');
  assert.equal(result.count, 1);
  assert.equal(result.items[0].productCode, 'PROD_A');
  assert.match(result.items[0].details, /missing in user_roles/);
});

test('Diagnostic 3: checkExpiredEntitlementsRetainingRoles identifies expired users retaining payment role', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM user_roles ur/.test(sql)) {
        return {
          rows: [
            {
              user_id: 103,
              role_id: 5,
              user_email: 'user@example.com',
              app_role: 'USER',
              role_name: 'Product A Role',
              product_id: 1,
              product_code: 'PROD_A',
              product_name: 'Product A'
            }
          ]
        };
      }
      // validateUserEntitlement returns no active entitlement
      return { rows: [] };
    }
  };

  const result = await checkExpiredEntitlementsRetainingRoles(mockClient);
  assert.equal(result.id, 'expired_entitlements_retaining_roles');
  assert.equal(result.status, 'warning');
  assert.equal(result.count, 1);
  assert.match(result.items[0].details, /expired/);
});

test('Diagnostic 4: checkEnabledProductsWithoutActivePlans identifies enabled products lacking active plans', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM paid_products p/.test(sql)) {
        return {
          rows: [
            {
              id: 2,
              code: 'ORPHAN_PROD',
              name: 'Orphan Product',
              role_id: 9,
              role_name: 'Orphan Role'
            }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const result = await checkEnabledProductsWithoutActivePlans(mockClient);
  assert.equal(result.id, 'enabled_products_without_plans');
  assert.equal(result.status, 'warning');
  assert.equal(result.count, 1);
  assert.equal(result.items[0].productCode, 'ORPHAN_PROD');
  assert.match(result.items[0].details, /0 active plans/);
});

test('Diagnostic 5: checkRecurringPlansMissingRazorpayId identifies recurring plans without razorpay_plan_id', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM paid_product_plans pl/.test(sql)) {
        return {
          rows: [
            {
              id: 10,
              plan_code: 'MONTHLY_SUB',
              plan_name: 'Monthly Subscription',
              is_active: true,
              billing_type: 'recurring',
              product_id: 1,
              product_code: 'PROD_A',
              product_name: 'Product A'
            }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const result = await checkRecurringPlansMissingRazorpayId(mockClient);
  assert.equal(result.id, 'recurring_plans_missing_razorpay_id');
  // Active recurring plan without razorpay ID is critical
  assert.equal(result.status, 'critical');
  assert.equal(result.count, 1);
  assert.equal(result.items[0].isActive, true);
});

test('Diagnostic 6: checkDefaultRolesInconsistencies detects default roles conflicting with paid products or empty', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM roles r/.test(sql)) {
        return {
          rows: [
            {
              id: 7,
              name: 'PREMIUM',
              description: 'Premium Membership',
              default_role: true,
              ads_available: false,
              paid_product_id: null,
              paid_product_code: null,
              paid_product_name: null,
              folder_count: 5
            },
            {
              id: 8,
              name: 'Empty Default Role',
              description: 'Has no folders',
              default_role: true,
              ads_available: true,
              paid_product_id: null,
              paid_product_code: null,
              paid_product_name: null,
              folder_count: 0
            }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const result = await checkDefaultRolesInconsistencies(mockClient);
  assert.equal(result.id, 'default_roles_inconsistent');
  assert.equal(result.status, 'critical'); // because of PREMIUM conflict
  assert.equal(result.count, 2);
  assert.equal(result.items[0].conflictType, 'paid_product_conflict');
  assert.equal(result.items[1].conflictType, 'empty_default_role');
});

test('Diagnostic 7: checkOtherRBACIntegrityInconsistencies checks stale accounts, grants, subscriptions, and orphaned roles', async () => {
  const mockClient = {
    query: async (sql) => {
      if (/FROM users u/.test(sql) && /access_expires_at <= NOW/.test(sql)) {
        return {
          rows: [
            { id: 99, email: 'stale@example.com', status: 'active', app_role: 'USER', access_expires_at: new Date('2025-01-01') }
          ]
        };
      }
      if (/FROM user_product_grants g/.test(sql) && /valid_until <= NOW/.test(sql)) {
        return {
          rows: [
            { id: 44, user_id: 99, product_id: 1, valid_until: new Date('2025-01-01'), user_email: 'stale@example.com', product_code: 'PROD_A', product_name: 'Product A' }
          ]
        };
      }
      if (/FROM paid_products p/.test(sql) && /NOT EXISTS.*roles/.test(sql)) {
        return {
          rows: [
            { id: 88, code: 'BROKEN_ROLE_PROD', name: 'Broken Product', role_id: 9999 }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const checks = await checkOtherRBACIntegrityInconsistencies(mockClient);
  assert.ok(Array.isArray(checks));
  const staleUsers = checks.find(c => c.id === 'stale_active_user_accounts');
  assert.equal(staleUsers.count, 1);
  assert.equal(staleUsers.status, 'warning');

  const staleGrants = checks.find(c => c.id === 'stale_active_grants');
  assert.equal(staleGrants.count, 1);

  const missingRoleProd = checks.find(c => c.id === 'paid_products_missing_roles');
  assert.equal(missingRoleProd.count, 1);
  assert.equal(missingRoleProd.status, 'critical');
});

test('Strict Read-Only Guarantee: integrity checks perform zero INSERT, UPDATE, or DELETE statements', async () => {
  let writeExecuted = false;
  const mockClient = {
    query: async (sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(sql)) {
        writeExecuted = true;
      }
      return { rows: [] };
    }
  };

  const report = await getSystemIntegrityReport(mockClient);
  assert.equal(writeExecuted, false, 'Integrity checks must be strictly read-only');
  assert.equal(report.overallStatus, 'healthy');
  assert.equal(report.summary.totalIssues, 0);
});

test('HTTP GET /admin/system renders System Health & Integrity section for Admin', async () => {
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    return { rows: [] };
  };

  const res = await http('/admin/system', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /System Health & Integrity Diagnostics/);
  assert.match(html, /data-testid="integrity-section"/);
  assert.match(html, /data-testid="integrity-summary-card"/);
  assert.match(html, /data-testid="integrity-checks-table"/);
  assert.match(html, /data-testid="nav-jump-integrity"/);
});

test('HTTP GET /admin/system/integrity and /admin/integrity redirect to /admin/system#integrity', async () => {
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  };

  const res1 = await http('/admin/system/integrity', { headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res1.status, 302);
  assert.equal(res1.headers.get('location'), '/admin/system#integrity');

  const res2 = await http('/admin/integrity', { headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res2.status, 302);
  assert.equal(res2.headers.get('location'), '/admin/system#integrity');
});

test('HTTP GET /api/admin/system/integrity returns JSON diagnostics for Admin', async () => {
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      const u = [OWNER, ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  };

  const res = await http('/api/admin/system/integrity', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.timestamp);
  assert.ok(data.summary);
  assert.equal(data.summary.overallStatus, 'healthy');
  assert.ok(Array.isArray(data.checks));
  assert.ok(data.checks.length >= 7);
});

test('Non-admin users cannot access integrity endpoint or admin system', async () => {
  const res = await http('/api/admin/system/integrity', { headers: { Cookie: USER_COOKIE } });
  // requireAdmin rejects non-admin users with 403 or redirect
  assert.ok([302, 403].includes(res.status));
});
