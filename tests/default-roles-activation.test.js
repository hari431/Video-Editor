import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import * as users from '../src/auth/users.js';
import { setTransport } from '../src/email/mailer.js';

const { app } = await import('../src/server.js');

const ADMIN = {
  id: 99,
  google_user_id: 'google-admin',
  email: 'admin@example.com',
  name: 'Admin',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: null,
  app_role: 'ADMIN'
};
const ADMIN_SID = 'default-role-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let originalQuery = null;
let originalConnect = null;
let server = null;
let port = 0;

test.before(async () => {
  setTransport({
    sendMail: async () => ({ messageId: 'test-msg' })
  });
  originalQuery = pool.query;
  originalConnect = pool.connect;
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  setTransport(null);
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Default Roles Suite: Migration, UI, Individual/Bulk Activation, Transactions, Paid-Role Protection', async (t) => {

  await t.test('1. Migration 030_default_roles.sql adds default_role boolean column defaulting to FALSE', async () => {
    const sql = await readFile(new URL('../migrations/030_default_roles.sql', import.meta.url), 'utf8');
    assert.match(sql, /ALTER TABLE roles ADD COLUMN IF NOT EXISTS default_role BOOLEAN NOT NULL DEFAULT FALSE/i);
    assert.match(sql, /COMMENT ON COLUMN roles\.default_role/i);
  });

  await t.test('2. Admin UI renders Default Role checkbox in Add Role form and table; protects PREMIUM', async () => {
    const rolesDb = [
      { id: 1, name: 'Team Alpha', description: 'Alpha group', ads_available: false, default_role: false },
      { id: 2, name: 'Team Beta', description: 'Beta group', ads_available: true, default_role: true },
      { id: 3, name: 'PREMIUM', description: 'Built-in Premium role', ads_available: false, default_role: false }
    ];

    pool.query = async (sql, params = []) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        const u = sessionToUser[params[0]];
        if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
        return { rows: [] };
      }
      if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
      if (/FROM roles/.test(sql) && /SELECT/.test(sql)) {
        return { rows: rolesDb.map(r => ({ ...r })), rowCount: rolesDb.length };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Check Add Role form has Default Role checkbox
    assert.match(html, /data-testid="new-role-default-check"/);
    assert.match(html, /name="default_role"/);

    // Check table headers have Default Role
    assert.match(html, /<th>Default Role<\/th>/);

    // Check checkboxes for editable roles
    assert.match(html, /data-testid="role-default-checkbox-1"/);
    assert.match(html, /data-testid="role-default-checkbox-2"/);

    // Check that Team Beta is checked
    assert.match(html, /name="role_default_2"[^>]*checked/);

    // Check that PREMIUM has protected disabled checkbox
    assert.match(html, /<input[^>]*disabled[^>]*data-testid="role-default-checkbox-3"/);
    assert.match(html, /Built-in Premium role cannot be a default role/);
  });

  await t.test('3. Admin can mark multiple roles as Default simultaneously', async () => {
    const rolesDb = [
      { id: 1, name: 'Team Alpha', description: 'Alpha', ads_available: false, default_role: false },
      { id: 2, name: 'Team Beta', description: 'Beta', ads_available: false, default_role: false },
      { id: 3, name: 'PREMIUM', description: 'Premium', ads_available: false, default_role: false }
    ];

    const executedUpdates = [];

    pool.query = async (sql, params = []) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: ADMIN.id } }) }] };
      }
      if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
      if (/FROM roles/.test(sql) && /SELECT/.test(sql)) {
        return { rows: rolesDb.map(r => ({ ...r })), rowCount: rolesDb.length };
      }
      return { rows: [], rowCount: 0 };
    };

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
        if (/SELECT name FROM roles WHERE id = \$1/i.test(sql)) {
          const r = rolesDb.find(x => x.id === params[0]);
          return { rows: r ? [{ name: r.name }] : [], rowCount: r ? 1 : 0 };
        }
        if (/UPDATE roles SET/i.test(sql)) {
          executedUpdates.push({ sql, params });
          const roleId = params[params.length - 1];
          const r = rolesDb.find(x => x.id === roleId);
          if (r && r.name !== 'PREMIUM') {
            if (sql.includes('default_role = $2')) {
              r.ads_available = params[0];
              r.default_role = params[1];
            } else if (sql.includes('default_role = $1')) {
              r.default_role = params[0];
            }
          }
          return { rowCount: 1, rows: [] };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    });

    const payload = {
      roles: [
        { id: 1, ads_available: false, default_role: true },
        { id: 2, ads_available: true, default_role: true },
        { id: 3, ads_available: false, default_role: true } // PREMIUM attempt
      ]
    };

    const res = await http('/admin/folders/roles/update-ads', {
      method: 'POST',
      headers: {
        Cookie: ADMIN_COOKIE,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Roles 1 and 2 are marked as default
    assert.equal(rolesDb.find(r => r.id === 1).default_role, true);
    assert.equal(rolesDb.find(r => r.id === 2).default_role, true);
    // Role 3 (PREMIUM) remained protected and NOT default
    assert.equal(rolesDb.find(r => r.id === 3).default_role, false);
  });

  await t.test('4. Individual activation (approveUser) automatically assigns configured Default Roles', async () => {
    const chosen = new Date(Date.now() + 30 * 86400000);
    const pendingUser = { id: 101, status: 'pending', access_expires_at: null, app_role: 'USER', email: 'user101@example.com' };
    const defaultRoles = [
      { id: 10, name: 'Standard Member' },
      { id: 20, name: 'Docs Viewer' }
    ];

    const insertedUserRoles = [];
    const calls = [];

    pool.query = async (sql, params = []) => {
      if (/SELECT.*FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [pendingUser] };
      }
      return { rowCount: 0, rows: [] };
    };

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
        if (/SELECT.*FROM users WHERE id/i.test(sql)) {
          return { rowCount: 1, rows: [pendingUser] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          return { rowCount: 1, rows: [{ ...pendingUser, status: 'active', access_expires_at: chosen }] };
        }
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          return { rowCount: defaultRoles.length, rows: defaultRoles };
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          insertedUserRoles.push({ userId: params[0], roleId: params[1], source: params[2] });
          return { rowCount: 1, rows: [] };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    const nextUser = await users.approveUser(ADMIN.id, 101, chosen);
    assert.equal(nextUser.status, 'active');

    // Verify default roles were assigned
    assert.equal(insertedUserRoles.length, 2);
    assert.deepEqual(insertedUserRoles, [
      { userId: 101, roleId: 10, source: 'manual' },
      { userId: 101, roleId: 20, source: 'manual' }
    ]);

    // Verify transactional BEGIN and COMMIT occurred
    assert.ok(calls.some(c => /^BEGIN/i.test(c.sql)));
    assert.ok(calls.some(c => /^COMMIT/i.test(c.sql)));
  });

  await t.test('5. Bulk activation (bulkActivateUsers) automatically assigns configured Default Roles to all pending users', async () => {
    const chosen = new Date(Date.now() + 30 * 86400000);
    const usersMap = {
      201: { id: 201, email: 'p1@example.com', status: 'pending', access_expires_at: null, app_role: 'USER' },
      202: { id: 202, email: 'p2@example.com', status: 'pending', access_expires_at: null, app_role: 'USER' }
    };
    const defaultRoles = [
      { id: 5, name: 'Default Role A' },
      { id: 6, name: 'Default Role B' }
    ];

    const insertedUserRoles = [];

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK|^SAVEPOINT|^RELEASE/i.test(sql)) return { rows: [] };
        if (/SELECT.*FROM users WHERE id/i.test(sql)) {
          const u = usersMap[params[0]];
          return u ? { rowCount: 1, rows: [u] } : { rowCount: 0, rows: [] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          const u = usersMap[params[0]];
          return { rowCount: 1, rows: [{ ...u, status: 'active', access_expires_at: chosen }] };
        }
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          return { rowCount: defaultRoles.length, rows: defaultRoles };
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          insertedUserRoles.push({ userId: params[0], roleId: params[1], source: params[2] });
          return { rowCount: 1, rows: [] };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    const result = await users.bulkActivateUsers(ADMIN.id, [201, 202], chosen);
    assert.equal(result.applied, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);

    // Both users got both default roles
    assert.equal(insertedUserRoles.length, 4);
    assert.deepEqual(insertedUserRoles, [
      { userId: 201, roleId: 5, source: 'manual' },
      { userId: 201, roleId: 6, source: 'manual' },
      { userId: 202, roleId: 5, source: 'manual' },
      { userId: 202, roleId: 6, source: 'manual' }
    ]);
  });

  await t.test('6. When NO Default Roles are configured, activation behaves exactly as before', async () => {
    const chosen = new Date(Date.now() + 15 * 86400000);
    const pendingUser = { id: 301, status: 'pending', access_expires_at: null, app_role: 'USER', email: 'p301@example.com' };

    let rolesQueried = false;
    let userRolesInserted = 0;

    pool.query = async (sql, params = []) => {
      if (/SELECT.*FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [pendingUser] };
      }
      return { rowCount: 0, rows: [] };
    };

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
        if (/SELECT.*FROM users WHERE id/i.test(sql)) {
          return { rowCount: 1, rows: [pendingUser] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          return { rowCount: 1, rows: [{ ...pendingUser, status: 'active', access_expires_at: chosen }] };
        }
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          rolesQueried = true;
          return { rowCount: 0, rows: [] }; // NO default roles
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          userRolesInserted++;
          return { rowCount: 1, rows: [] };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    const nextUser = await users.approveUser(ADMIN.id, 301, chosen);
    assert.equal(nextUser.status, 'active');
    assert.equal(rolesQueried, true);
    assert.equal(userRolesInserted, 0, 'No user_roles should be inserted when no default roles configured');
  });

  await t.test('7. Activating existing (expired or revoked) users does NOT assign default roles', async () => {
    const chosen = new Date(Date.now() + 15 * 86400000);
    const usersMap = {
      401: { id: 401, email: 'exp@example.com', status: 'active', access_expires_at: new Date(Date.now() - 1000), app_role: 'USER' }, // expired
      402: { id: 402, email: 'rev@example.com', status: 'revoked', access_expires_at: new Date(Date.now() - 1000), app_role: 'USER' } // revoked
    };
    const defaultRoles = [{ id: 1, name: 'Default Role' }];
    let userRolesInserted = 0;

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK|^SAVEPOINT|^RELEASE/i.test(sql)) return { rows: [] };
        if (/SELECT.*FROM users WHERE id/i.test(sql)) {
          const u = usersMap[params[0]];
          return u ? { rowCount: 1, rows: [u] } : { rowCount: 0, rows: [] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          const u = usersMap[params[0]];
          return { rowCount: 1, rows: [{ ...u, status: 'active', access_expires_at: chosen }] };
        }
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          return { rowCount: defaultRoles.length, rows: defaultRoles };
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          userRolesInserted++;
          return { rowCount: 1, rows: [] };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    // Bulk activate the expired and revoked users
    const result = await users.bulkActivateUsers(ADMIN.id, [401, 402], chosen);
    assert.equal(result.applied, 2);
    // Ensure default roles were NOT assigned to these non-pending existing accounts
    assert.equal(userRolesInserted, 0, 'Existing expired/revoked users must NOT have default roles assigned');
  });

  await t.test('8. Transactional safety: if default-role assignment fails, user activation is rolled back', async () => {
    const chosen = new Date(Date.now() + 30 * 86400000);
    const pendingUser = { id: 501, status: 'pending', access_expires_at: null, app_role: 'USER', email: 'p501@example.com' };
    const defaultRoles = [{ id: 999, name: 'Failing Role' }];

    const rolledBackCalls = [];

    pool.query = async (sql, params = []) => {
      if (/SELECT.*FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [pendingUser] };
      }
      return { rowCount: 0, rows: [] };
    };

    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/^ROLLBACK/i.test(sql)) {
          rolledBackCalls.push(sql);
          return { rows: [] };
        }
        if (/^BEGIN|^COMMIT/i.test(sql)) return { rows: [] };
        if (/SELECT.*FROM users WHERE id/i.test(sql)) {
          return { rowCount: 1, rows: [pendingUser] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          return { rowCount: 1, rows: [{ ...pendingUser, status: 'active', access_expires_at: chosen }] };
        }
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          return { rowCount: 1, rows: defaultRoles };
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          // Simulate database constraint / disk error during role assignment
          throw new Error('Simulated database error during user_roles insert');
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    await assert.rejects(
      async () => users.approveUser(ADMIN.id, 501, chosen),
      /Simulated database error during user_roles insert/
    );

    // Rollback MUST have been executed to prevent partial activation
    assert.ok(rolledBackCalls.length > 0, 'Transaction must be rolled back');
  });

  await t.test('9. Paid-Role and PREMIUM Protection: PREMIUM cannot be default role and manual assignment source is preserved', async () => {
    // 9a. getDefaultRoles excludes any role named 'PREMIUM'
    const rolesWithPremium = [
      { id: 1, name: 'Normal Default', default_role: true },
      { id: 2, name: 'PREMIUM', default_role: true } // even if somehow true in DB
    ];

    const fakeClient = {
      query: async (sql) => {
        if (/FROM roles WHERE default_role = TRUE AND UPPER\(name\) != 'PREMIUM'/i.test(sql)) {
          return {
            rowCount: 1,
            rows: rolesWithPremium.filter(r => r.default_role && r.name.toUpperCase() !== 'PREMIUM')
          };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const fetchedDefaults = await users.getDefaultRoles(fakeClient);
    assert.equal(fetchedDefaults.length, 1);
    assert.equal(fetchedDefaults[0].name, 'Normal Default');
    assert.ok(!fetchedDefaults.some(r => r.name === 'PREMIUM'), 'PREMIUM must never be returned as a default role');

    // 9b. Default role assignment writes assignment_source = 'manual'
    const insertedSources = [];
    const recordClient = {
      query: async (sql, params = []) => {
        if (/SELECT id, name FROM roles WHERE default_role = TRUE/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: 1, name: 'Normal Default' }] };
        }
        if (/INSERT INTO user_roles/i.test(sql)) {
          insertedSources.push(params[2]);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    await users.assignDefaultRolesToUser(recordClient, 601);
    assert.equal(insertedSources.length, 1);
    assert.equal(insertedSources[0], 'manual', 'Default roles must be tagged as assignment_source manual to protect payment reconciliation');
  });

  await t.test('10. OWNER/ADMIN Protection: Administrator accounts cannot be activated or modified', async () => {
    const adminTarget = { id: 701, email: 'boss@example.com', status: 'pending', app_role: 'ADMIN' };
    pool.query = async (sql, params = []) => {
      if (/SELECT.*FROM users WHERE id/i.test(sql)) return { rowCount: 1, rows: [adminTarget] };
      return { rowCount: 0, rows: [] };
    };
    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/SELECT.*FROM users WHERE id/i.test(sql)) return { rowCount: 1, rows: [adminTarget] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    });

    await assert.rejects(
      async () => users.approveUser(ADMIN.id, 701, new Date(Date.now() + 86400000)),
      /Administrator accounts cannot be modified/
    );

    // Bulk activate skips admin accounts
    const result = await users.bulkActivateUsers(ADMIN.id, [701], new Date(Date.now() + 86400000));
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1);
  });
});
