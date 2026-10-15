import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncUserAccessExpiry } from '../src/auth/paidProducts.js';

test('syncUserAccessExpiry regression tests', async (t) => {
  // Let's implement mock DB and client
  const mockRoles = [
    { id: 1, name: 'Active', description: 'Active role', default_role: false, ads_available: false, notes_available: false },
    { id: 2, name: 'Expired', description: 'Expired role', default_role: false, ads_available: true, notes_available: false },
    { id: 3, name: 'PREMIUM', description: 'Premium role', default_role: false, ads_available: false, notes_available: true }
  ];

  let mockUsers = [
    { id: 1001, email: 'test@example.com', status: 'active', access_expires_at: '2026-10-10T00:00:00.000Z', app_role: 'PREMIUM', premium_source: 'one_time' }
  ];

  let mockGrants = [
    { id: 501, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-10-10T00:00:00.000Z', created_at: new Date() }
  ];

  let mockUserRoles = [
    { user_id: 1001, role_id: 1, assignment_source: 'manual' }, // Active role
    { user_id: 1001, role_id: 3, assignment_source: 'payment_system' } // PREMIUM product role
  ];

  const mockProducts = [
    { id: 99, code: 'PREMIUM', name: 'Premium Tier', role_id: 3, is_enabled: true }
  ];

  const mockSubscriptions = [];

  const mockClient = {
    query: async (sql, params = []) => {
      let result = { rowCount: 0, rows: [] };
      
      // 1. FROM user_product_grants queries
      if (/user_product_grants/i.test(sql)) {
        if (/UPDATE/i.test(sql)) {
          const userId = Number(params[0]);
          let count = 0;
          const now = new Date();
          mockGrants.forEach(g => {
            if (g.user_id === userId && g.status === 'active' && g.valid_until && new Date(g.valid_until) <= now) {
              g.status = 'expired';
              count++;
            }
          });
          result = { rowCount: count, rows: [] };
        } else {
          // SELECT
          const userId = Number(params[0]);
          const now = new Date();
          
          // Determine filters
          const activeOnly = /status = 'active'/i.test(sql);
          const nonExpiredOnly = /valid_until > NOW\(\)/i.test(sql) || /valid_until IS NULL/i.test(sql) || /valid_until >/i.test(sql);
          
          let filtered = mockGrants.filter(g => g.user_id === userId);
          if (activeOnly) {
            filtered = filtered.filter(g => g.status === 'active');
          }
          if (nonExpiredOnly) {
            filtered = filtered.filter(g => g.valid_until === null || new Date(g.valid_until) > now);
          }
          
          if (/SELECT valid_until/i.test(sql)) {
            filtered.sort((a, b) => {
              if (a.valid_until === null) return -1;
              if (b.valid_until === null) return 1;
              return new Date(b.valid_until) - new Date(a.valid_until);
            });
            if (filtered.length > 0) {
              result = { rowCount: 1, rows: [{ valid_until: filtered[0].valid_until }] };
            } else {
              result = { rowCount: 0, rows: [] };
            }
          } else {
            // For SELECT g.id
            result = { rowCount: filtered.length, rows: filtered };
          }
        }
      }

      // 2. FROM paid_products queries (must be evaluated before roles because it joins roles)
      else if (/paid_products/i.test(sql)) {
        if (params.length > 0) {
          const val = params[0];
          const p = mockProducts.find(x => x.code === val || x.id === Number(val));
          if (p) {
            result = { rowCount: 1, rows: [{ ...p, role_name: 'PREMIUM' }] };
          } else {
            result = { rowCount: 0, rows: [] };
          }
        } else {
          result = { rowCount: mockProducts.length, rows: mockProducts.map(p => ({ ...p, role_name: 'PREMIUM' })) };
        }
      }

      // 3. FROM user_roles queries
      else if (/user_roles/i.test(sql)) {
        if (/INSERT INTO/i.test(sql)) {
          const userId = Number(params[0]);
          const roleId = Number(params[1]);
          const source = params[2] || 'manual';
          const exists = mockUserRoles.some(ur => ur.user_id === userId && ur.role_id === roleId);
          if (!exists) {
            mockUserRoles.push({ user_id: userId, role_id: roleId, assignment_source: source });
          }
          result = { rowCount: 1, rows: [] };
        } else if (/DELETE FROM/i.test(sql)) {
          const userId = Number(params[0]);
          const roleId = Number(params[1]);
          mockUserRoles = mockUserRoles.filter(ur => !(ur.user_id === userId && ur.role_id === roleId));
          result = { rowCount: 1, rows: [] };
        } else {
          // SELECT FROM user_roles WHERE user_id = $1 AND role_id = $2
          const userId = Number(params[0]);
          const roleId = Number(params[1]);
          const ur = mockUserRoles.find(x => x.user_id === userId && x.role_id === roleId);
          result = { rowCount: ur ? 1 : 0, rows: ur ? [ur] : [] };
        }
      }

      // 4. FROM roles queries
      else if (/roles/i.test(sql)) {
        if (/SELECT id FROM roles WHERE name =/i.test(sql) || /SELECT id FROM roles WHERE name = 'Active'/i.test(sql) || /SELECT id FROM roles WHERE name = 'Expired'/i.test(sql)) {
          let name = params[0];
          if (!name) {
            if (/name = 'Active'/i.test(sql)) name = 'Active';
            if (/name = 'Expired'/i.test(sql)) name = 'Expired';
            if (/name = 'PREMIUM'/i.test(sql)) name = 'PREMIUM';
          }
          const r = mockRoles.find(x => x.name === name);
          result = { rowCount: r ? 1 : 0, rows: r ? [r] : [] };
        } else {
          result = { rowCount: mockRoles.length, rows: mockRoles };
        }
      }

      // 5. FROM users queries
      else if (/users/i.test(sql)) {
        const userId = Number(params[0]);
        const u = mockUsers.find(x => x.id === userId);
        if (/UPDATE/i.test(sql)) {
          if (u) {
            if (/SET access_expires_at = \$2/i.test(sql)) {
              u.access_expires_at = params[1];
            }
            if (/SET status = 'active'/i.test(sql)) {
              u.status = 'active';
            }
            if (/SET status = 'expired'/i.test(sql)) {
              u.status = 'expired';
              u.access_expires_at = null;
            }
            if (/app_role = 'PREMIUM'/i.test(sql)) {
              u.app_role = 'PREMIUM';
            }
            if (/app_role = 'USER'/i.test(sql)) {
              u.app_role = 'USER';
            }
            if (/premium_source = 'subscription'/i.test(sql)) {
              u.premium_source = 'subscription';
            }
            if (/premium_source = 'one_time'/i.test(sql)) {
              u.premium_source = 'one_time';
            }
            if (/premium_source = NULL/i.test(sql) || /premium_source = null/i.test(sql)) {
              u.premium_source = null;
            }
          }
          result = { rowCount: 1, rows: u ? [u] : [] };
        } else {
          result = { rowCount: u ? 1 : 0, rows: u ? [u] : [] };
        }
      }

      // 6. SELECT FROM premium_subscriptions / paid_subscriptions
      else if (/premium_subscriptions/i.test(sql) || /paid_subscriptions/i.test(sql)) {
        result = { rowCount: mockSubscriptions.length, rows: mockSubscriptions };
      }

      // 7. INSERT INTO role_audit_log / bootstrapper
      else if (/INSERT INTO role_audit_log/i.test(sql)) {
        result = { rowCount: 1, rows: [] };
      }

      console.log('MOCK DB QUERY:', sql.replace(/\s+/g, ' ').trim(), 'params:', params, 'result rowCount:', result.rowCount);
      return result;
    }
  };

  await t.test('A. final one-time grant expires -> Active removed, Expired assigned, access_expires_at cleared', async () => {
    // Set user to active and grant is expired (e.g. valid_until is past date)
    mockUsers = [
      { id: 1001, email: 'test@example.com', status: 'active', access_expires_at: '2026-09-01T00:00:00.000Z', app_role: 'PREMIUM', premium_source: 'one_time' }
    ];
    mockGrants = [
      { id: 501, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-09-01T00:00:00.000Z', created_at: new Date() }
    ];
    mockUserRoles = [
      { user_id: 1001, role_id: 1, assignment_source: 'manual' }, // Active role
      { user_id: 1001, role_id: 3, assignment_source: 'payment_system' } // PREMIUM
    ];

    await syncUserAccessExpiry(1001, mockClient);

    const user = mockUsers.find(u => u.id === 1001);
    assert.equal(user.status, 'expired');
    assert.equal(user.access_expires_at, null);
    assert.equal(user.app_role, 'USER'); // Premium revoked

    // Active role (id 1) must be removed, Expired (id 2) must be assigned
    const hasActive = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 1);
    const hasExpired = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 2);
    const hasPremium = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 3);

    assert.equal(hasActive, false, 'Should remove Active role');
    assert.equal(hasExpired, true, 'Should assign Expired role');
    assert.equal(hasPremium, false, 'Should remove PREMIUM role');
  });

  await t.test('B. final recurring grant expires -> same result', async () => {
    mockUsers = [
      { id: 1001, email: 'test@example.com', status: 'active', access_expires_at: '2026-09-01T00:00:00.000Z', app_role: 'PREMIUM', premium_source: 'subscription' }
    ];
    mockGrants = [
      { id: 501, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-09-01T00:00:00.000Z', created_at: new Date() }
    ];
    mockUserRoles = [
      { user_id: 1001, role_id: 1, assignment_source: 'manual' },
      { user_id: 1001, role_id: 3, assignment_source: 'payment_system' }
    ];

    await syncUserAccessExpiry(1001, mockClient);

    const user = mockUsers.find(u => u.id === 1001);
    assert.equal(user.status, 'expired');
    assert.equal(user.access_expires_at, null);
    assert.equal(user.app_role, 'USER');

    const hasActive = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 1);
    const hasExpired = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 2);
    const hasPremium = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 3);

    assert.equal(hasActive, false, 'Should remove Active role');
    assert.equal(hasExpired, true, 'Should assign Expired role');
    assert.equal(hasPremium, false, 'Should remove PREMIUM role');
  });

  await t.test('C. one grant expires while another valid grant remains -> user stays Active and latest expiry remains', async () => {
    mockUsers = [
      { id: 1001, email: 'test@example.com', status: 'active', access_expires_at: '2026-09-01T00:00:00.000Z', app_role: 'PREMIUM', premium_source: 'one_time' }
    ];
    mockGrants = [
      { id: 501, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-09-01T00:00:00.000Z', created_at: new Date() },
      { id: 502, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-12-15T00:00:00.000Z', created_at: new Date() }
    ];
    mockUserRoles = [
      { user_id: 1001, role_id: 1, assignment_source: 'manual' },
      { user_id: 1001, role_id: 3, assignment_source: 'payment_system' }
    ];

    await syncUserAccessExpiry(1001, mockClient);

    const user = mockUsers.find(u => u.id === 1001);
    assert.equal(user.status, 'active');
    assert.equal(user.access_expires_at, '2026-12-15T00:00:00.000Z');
    assert.equal(user.app_role, 'PREMIUM');

    const hasActive = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 1);
    const hasExpired = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 2);

    assert.equal(hasActive, true, 'Should preserve Active role');
    assert.equal(hasExpired, false, 'Should not have Expired role');
  });

  await t.test('D. expired user purchases again -> Active restored and Expired removed', async () => {
    mockUsers = [
      { id: 1001, email: 'test@example.com', status: 'expired', access_expires_at: null, app_role: 'USER', premium_source: null }
    ];
    mockGrants = [
      { id: 501, user_id: 1001, product_id: 99, status: 'expired', valid_until: '2026-09-01T00:00:00.000Z', created_at: new Date() },
      { id: 503, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-12-15T00:00:00.000Z', created_at: new Date() }
    ];
    mockUserRoles = [
      { user_id: 1001, role_id: 2, assignment_source: 'manual' } // Expired role
    ];

    await syncUserAccessExpiry(1001, mockClient);

    const user = mockUsers.find(u => u.id === 1001);
    assert.equal(user.status, 'active');
    assert.equal(user.access_expires_at, '2026-12-15T00:00:00.000Z');

    const hasActive = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 1);
    const hasExpired = mockUserRoles.some(ur => ur.user_id === 1001 && ur.role_id === 2);

    assert.equal(hasActive, true, 'Active role should be assigned');
    assert.equal(hasExpired, false, 'Expired role should be removed');
  });

  await t.test('E. one-time + recurring grants coexist correctly', async () => {
    mockUsers = [
      { id: 1001, email: 'test@example.com', status: 'active', access_expires_at: '2026-10-10T00:00:00.000Z', app_role: 'PREMIUM', premium_source: 'one_time' }
    ];
    mockGrants = [
      { id: 501, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-10-10T00:00:00.000Z', created_at: new Date() }, // One-time
      { id: 502, user_id: 1001, product_id: 99, status: 'active', valid_until: '2026-11-10T00:00:00.000Z', created_at: new Date() }  // Recurring
    ];
    mockUserRoles = [
      { user_id: 1001, role_id: 1, assignment_source: 'manual' },
      { user_id: 1001, role_id: 3, assignment_source: 'payment_system' }
    ];

    await syncUserAccessExpiry(1001, mockClient);

    const user = mockUsers.find(u => u.id === 1001);
    assert.equal(user.status, 'active');
    // Latest expiry wins: 2026-11-10T00:00:00.000Z
    assert.equal(user.access_expires_at, '2026-11-10T00:00:00.000Z');
  });
});
