import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 10, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'role-ads-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let originalQuery = null;
let originalConnect = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  originalConnect = pool.connect;
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Admin Folder Permissions: Editable Role Ads Available Suite', async (t) => {
  let rolesDb = [
    { id: 1, name: 'Team A', description: 'Group A', ads_available: false },
    { id: 2, name: 'Team B', description: 'Group B', ads_available: true },
    { id: 3, name: 'PREMIUM', description: 'Built-in Premium role', ads_available: false }
  ];

  function mockDb() {
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
      if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, app_role FROM users/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE roles SET ads_available =/.test(sql)) {
        const adsAvail = params[0];
        const roleId = params[1];
        const r = rolesDb.find(x => x.id === roleId);
        if (r && r.name !== 'PREMIUM') {
          r.ads_available = adsAvail;
        }
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    };

    pool.connect = async () => {
      const client = {
        query: async (sql, params = []) => {
          if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
            return { rows: [] };
          }
          if (/SELECT name FROM roles WHERE id = \$1/i.test(sql)) {
            const roleId = params[0];
            const r = rolesDb.find(x => x.id === roleId);
            return { rows: r ? [{ name: r.name }] : [], rowCount: r ? 1 : 0 };
          }
          if (/UPDATE roles SET ads_available =/i.test(sql)) {
            const adsAvail = params[0];
            const roleId = params[1];
            const r = rolesDb.find(x => x.id === roleId);
            if (r && r.name !== 'PREMIUM') {
              r.ads_available = adsAvail;
            }
            return { rowCount: 1, rows: [] };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {}
      };
      return client;
    };
  }

  await t.test('1. Renders checkboxes for editable roles and Save Changes button in /admin/folders UI', async () => {
    mockDb();
    const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('data-testid="save-role-ads"'), 'Save Changes button must be present');
    assert.ok(html.includes('data-testid="role-ads-checkbox-1"'), 'Role 1 checkbox present');
    assert.ok(html.includes('data-testid="role-ads-checkbox-2"'), 'Role 2 checkbox present');
    assert.ok(html.includes('data-testid="role-ads-checkbox-3"'), 'PREMIUM role checkbox present');
    assert.ok(html.includes('roles-ads-form'), 'Roles form must wrap the table');
  });

  await t.test('2. Bulk saves multiple role Ads Available settings in one transaction', async () => {
    mockDb();
    const res = await http('/admin/folders/roles/update-ads', {
      method: 'POST',
      headers: {
        Cookie: ADMIN_COOKIE,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        roles: [
          { id: 1, ads_available: true },
          { id: 2, ads_available: false }
        ]
      })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(rolesDb.find(r => r.id === 1).ads_available, true, 'Team A ads_available updated to true');
    assert.equal(rolesDb.find(r => r.id === 2).ads_available, false, 'Team B ads_available updated to false');
  });

  await t.test('3. Unchanged roles retain their existing Ads Available values', async () => {
    mockDb();
    rolesDb[0].ads_available = true;
    rolesDb[1].ads_available = false;

    const res = await http('/admin/folders/roles/update-ads', {
      method: 'POST',
      headers: {
        Cookie: ADMIN_COOKIE,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        roles: [
          { id: 1, ads_available: true } // Team B (id:2) is omitted
        ]
      })
    });
    assert.equal(res.status, 200);
    assert.equal(rolesDb.find(r => r.id === 1).ads_available, true);
    assert.equal(rolesDb.find(r => r.id === 2).ads_available, false, 'Team B value retained unchanged');
  });

  await t.test('4. PREMIUM role remains protected and cannot be changed to ads_available = true', async () => {
    mockDb();
    rolesDb.find(r => r.id === 3).ads_available = false;

    const res = await http('/admin/folders/roles/update-ads', {
      method: 'POST',
      headers: {
        Cookie: ADMIN_COOKIE,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        roles: [
          { id: 3, ads_available: true } // Attempting to modify PREMIUM
        ]
      })
    });
    assert.equal(res.status, 200);
    assert.equal(rolesDb.find(r => r.id === 3).ads_available, false, 'PREMIUM ads_available MUST remain false');
  });

  await t.test('5. Persists changes across page reload in /admin/folders UI', async () => {
    mockDb();
    rolesDb[0].ads_available = true;

    const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('data-role-id="1"'), 'Role 1 row present');
    assert.ok(html.includes('data-initial-ads="true"'), 'Role 1 initial ads reflects DB state true');
  });
});
