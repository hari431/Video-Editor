import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { syncUserAccessExpiry, syncProductRbacRole } from '../src/auth/paidProducts.js';
import { canAccessLibraryPathAsync, invalidatePermissionCache, loadFolderPermissions } from '../src/library/local.js';
import { passport } from '../src/auth/passport.js';

function createMockDb() {
  const users = [
    { id: 1, email: 'user@test.com', status: 'expired', access_expires_at: null, app_role: 'USER' }
  ];
  const products = [
    { id: 101, code: 'PROD_A', name: 'Product A', role_id: 10 },
    { id: 102, code: 'PROD_B', name: 'Product B', role_id: 20 },
    { id: 103, code: 'PROD_C', name: 'Product C', role_id: 30 }
  ];
  const grants = []; // { id, user_id, product_id, valid_until, status }
  const folder_permissions = [
    { folder_path: 'Folder A', access_level: 'role', role_id: 10, ads_available: false },
    { folder_path: 'Folder B', access_level: 'role', role_id: 20, ads_available: false },
    { folder_path: 'Folder C', access_level: 'role', role_id: 30, ads_available: false },
    { folder_path: 'Public Folder', access_level: 'all', ads_available: true }
  ];

  const mockQuery = async (sql, params = []) => {
    // console.log("MOCK QUERY:", sql, params);
    
    // 1. users
    if (sql.includes('SELECT status, access_expires_at FROM users') || sql.includes('SELECT * FROM users WHERE id = $1')) {
      const u = users.find(u => u.id === Number(params[0]));
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (sql.includes('UPDATE users SET access_expires_at = $2')) {
      const u = users.find(u => u.id === Number(params[0]));
      if (u) {
        u.access_expires_at = params[1];
      }
      return { rowCount: 1 };
    }
    if (sql.includes("UPDATE users SET status = 'active'")) {
      const u = users.find(u => u.id === Number(params[0]));
      if (u) u.status = 'active';
      return { rowCount: 1 };
    }

    // 2. user_product_grants
    if (sql.includes('FROM user_product_grants') && sql.includes('ORDER BY valid_until DESC')) {
      const activeGrants = grants.filter(g => g.user_id === Number(params[0]) && g.status === 'active');
      activeGrants.sort((a, b) => {
        if (!a.valid_until) return -1;
        if (!b.valid_until) return 1;
        return new Date(b.valid_until) - new Date(a.valid_until);
      });
      return { rows: activeGrants.length ? [activeGrants[0]] : [], rowCount: activeGrants.length ? 1 : 0 };
    }
    
    // passport deserializeUser query mocks
    if (sql.includes('FROM user_roles WHERE user_id = $1')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM user_product_grants g') && sql.includes('JOIN paid_products p')) {
      const activeGrants = grants.filter(g => g.user_id === Number(params[0]) && g.status === 'active' && (!g.valid_until || new Date(g.valid_until) > new Date()));
      const roleIds = activeGrants.map(g => {
        const prod = products.find(p => p.id === g.product_id);
        return prod ? prod.role_id : null;
      }).filter(Boolean);
      const uniqueRoleIds = [...new Set(roleIds)];
      return { rows: uniqueRoleIds.map(role_id => ({ role_id })), rowCount: uniqueRoleIds.length };
    }

    // folder permissions mock
    if (sql.includes('FROM folder_permissions')) {
      return { rows: folder_permissions, rowCount: folder_permissions.length };
    }

    return { rows: [], rowCount: 0 };
  };

  return { users, products, grants, mockQuery };
}

test('Generic Paid Products Lifecycle', async (t) => {
  const { users, grants, mockQuery } = createMockDb();
  const origQuery = pool.query;
  pool.query = mockQuery;

  invalidatePermissionCache();
  await loadFolderPermissions();

  const getReqUser = async (userId) => {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (!user) return null;
    
    const rolesResult = await pool.query(
      'SELECT role_id, assignment_source FROM user_roles WHERE user_id = $1',
      [userId]
    );
    user.roles = rolesResult.rows.map(r => Number(r.role_id));
    
    const grantsResult = await pool.query(
      `SELECT DISTINCT p.role_id 
       FROM user_product_grants g 
       JOIN paid_products p ON g.product_id = p.id 
       WHERE g.user_id = $1 
         AND g.status = 'active' 
         AND (g.valid_until IS NULL OR g.valid_until > NOW())`,
      [userId]
    );
    user.paidProductRoleIds = grantsResult.rows.map(r => Number(r.role_id));
    return user;
  };

  try {
    const userId = 1;
    let reqUser;

    await t.test('1. One-time purchase → grant → configured role → folder access', async () => {
      const validUntil = new Date(Date.now() + 10 * 86400000).toISOString();
      grants.push({ id: 1, user_id: userId, product_id: 101, valid_until: validUntil, status: 'active' });
      
      await syncUserAccessExpiry(userId, pool);
      reqUser = await getReqUser(userId);

      assert.strictEqual(reqUser.status, 'active', 'User status should be active after sync');
      assert.strictEqual(reqUser.access_expires_at, validUntil, 'Expiry should be set to 10 days');
      assert.ok(reqUser.paidProductRoleIds.includes(10), 'User gets Role 10');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder A/file.txt'), true, 'Access Folder A');
    });

    await t.test('2. Recurring purchase → grant → configured role → folder access & 7. Multiple valid paid products', async () => {
      const periodEnd = new Date(Date.now() + 15 * 86400000).toISOString();
      grants.push({ id: 2, user_id: userId, product_id: 102, valid_until: periodEnd, status: 'active' });

      await syncUserAccessExpiry(userId, pool);
      reqUser = await getReqUser(userId);

      assert.strictEqual(reqUser.access_expires_at, periodEnd, 'Expiry set to latest valid entitlement (15 days)');
      assert.ok(reqUser.paidProductRoleIds.includes(10));
      assert.ok(reqUser.paidProductRoleIds.includes(20));
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder B/file.txt'), true, 'Access Folder B');
    });

    await t.test('3. Successful recurring renewal → entitlement expiry advances; access continues', async () => {
      const newPeriodEnd = new Date(Date.now() + 45 * 86400000).toISOString();
      const grantB = grants.find(g => g.id === 2);
      grantB.valid_until = newPeriodEnd;

      await syncUserAccessExpiry(userId, pool);
      reqUser = await getReqUser(userId);

      assert.strictEqual(reqUser.access_expires_at, newPeriodEnd, 'Expiry advanced to 45 days');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder B/file.txt'), true);
    });

    await t.test('4. Failed renewal/cancelled AutoPay → access remains until the already-paid entitlement expires', async () => {
      // In the system, cancellation stops future renewals but doesn't revoke active valid_until in the grant immediately
      // The grant remains active until the end of the period.
      // We simulate no change in grant status or valid_until.
      reqUser = await getReqUser(userId);
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder B/file.txt'), true, 'Access remains active');
    });

    await t.test('5. After entitlement expiry with no other valid entitlement → paid role removed and user becomes Expired', async () => {
      // Simulate time passing: all grants expire
      const past = new Date(Date.now() - 86400000).toISOString();
      grants.forEach(g => g.valid_until = past);

      // System cron (reconcileExpiredUserStatuses) updates user status to expired
      users[0].status = 'expired';
      
      reqUser = await getReqUser(userId);
      assert.ok(!reqUser.paidProductRoleIds.includes(10), 'Role 10 removed');
      assert.ok(!reqUser.paidProductRoleIds.includes(20), 'Role 20 removed');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder A/file.txt'), false, 'Folder A access revoked');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder B/file.txt'), false, 'Folder B access revoked');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Public Folder/file.txt'), true, 'Public access preserved');
    });

    await t.test('6. Expired user purchases again → Active/reactivated, new entitlement expiry applied, role restored (8. A future product with a different RBAC role)', async () => {
      const validUntilC = new Date(Date.now() + 30 * 86400000).toISOString();
      grants.push({ id: 3, user_id: userId, product_id: 103, valid_until: validUntilC, status: 'active' });

      await syncUserAccessExpiry(userId, pool);
      reqUser = await getReqUser(userId);

      assert.strictEqual(reqUser.status, 'active', 'User reactivated');
      assert.strictEqual(reqUser.access_expires_at, validUntilC);
      assert.ok(reqUser.paidProductRoleIds.includes(30), 'Role 30 assigned');
      assert.strictEqual(await canAccessLibraryPathAsync(reqUser, 'Folder C/file.txt'), true, 'Folder C access granted without custom code');
    });

  } finally {
    pool.query = origQuery;
    invalidatePermissionCache();
  }
});
