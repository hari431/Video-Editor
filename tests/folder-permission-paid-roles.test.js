import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessLibraryPathAsync, invalidatePermissionCache, loadFolderPermissions } from '../src/library/local.js';
import { pool } from '../src/db/pool.js';

test('Paid product roles are respected for folder permissions', async () => {
  // Clear any cache
  invalidatePermissionCache();

  // Mock pool query to return specific folder permissions
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (sql.includes('FROM folder_permissions')) {
      return {
        rows: [
          { folder_path: 'Premium Content', access_level: 'role', role_id: 10, ads_available: false },
          { folder_path: 'Standard Content', access_level: 'role', role_id: 5, ads_available: true }
        ]
      };
    }
    return originalQuery.call(pool, sql, params);
  };

  try {
    // 1. Force the cache to load
    await loadFolderPermissions();

    // 2. User with neither role
    const basicUser = { id: 1, app_role: 'USER', roles: [1] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(basicUser, 'Premium Content/video.mp4'),
      false,
      'Basic user should not access Premium Content'
    );

    // 3. User with user.roles permissions (Existing behavior)
    const standardUser = { id: 2, app_role: 'USER', roles: [1, 5] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(standardUser, 'Standard Content/doc.txt'),
      true,
      'User with standard role in user.roles should access standard folder'
    );
    assert.strictEqual(
      await canAccessLibraryPathAsync(standardUser, 'Premium Content/video.mp4'),
      false,
      'User with standard role should not access Premium Content'
    );

    // 4. User with user.paidProductRoleIds (New behavior)
    const premiumRecurringUser = { id: 3, app_role: 'USER', roles: [1], paidProductRoleIds: [10] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(premiumRecurringUser, 'Premium Content/video.mp4'),
      true,
      'User with premium role in paidProductRoleIds should access Premium Content'
    );

    // 5. Expired/inactive paid grants no longer provide access (handled at passport serialization level where paidProductRoleIds is populated)
    const expiredUser = { id: 4, app_role: 'USER', roles: [1], paidProductRoleIds: [] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(expiredUser, 'Premium Content/video.mp4'),
      false,
      'User without role in either array should not access Premium Content'
    );

    // 6. User with both (e.g., overlapping one-time and recurring or admin testing)
    const superUser = { id: 5, app_role: 'USER', roles: [1, 5], paidProductRoleIds: [10] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(superUser, 'Premium Content/video.mp4'),
      true,
      'Super user should access Premium Content'
    );
    assert.strictEqual(
      await canAccessLibraryPathAsync(superUser, 'Standard Content/doc.txt'),
      true,
      'Super user should access Standard Content'
    );

    // 7. One-time Premium access continues working (has role in user.roles from hardcoded DB sync)
    const oneTimePremiumUser = { id: 6, app_role: 'PREMIUM', roles: [10], paidProductRoleIds: [] };
    assert.strictEqual(
      await canAccessLibraryPathAsync(oneTimePremiumUser, 'Premium Content/video.mp4'),
      true,
      'One-time Premium access continues working'
    );

  } finally {
    pool.query = originalQuery;
    invalidatePermissionCache();
  }
});
