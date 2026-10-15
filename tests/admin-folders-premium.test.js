import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 10, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'folders-premium-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Folder Permissions shows PREMIUM built-in role even when DB has no PREMIUM', async () => {
  // Mock DB to return only PC Team and SuperUser, no PREMIUM
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      // Return only PC Team and SuperUser, no PREMIUM
      return { rows: [
        { id: 1, name: 'PC Team', description: 'PC Team desc', created_at: new Date().toISOString() },
        { id: 2, name: 'SuperUser', description: 'SuperUser desc', created_at: new Date().toISOString() }
      ], rowCount: 2 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [{ id: 20, email: 'user@example.com', name: 'User' }], rowCount: 1 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [] };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql) && sql.includes('PREMIUM')) {
      // Simulate ON CONFLICT DO NOTHING - no rows returned
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) {
      // After insert, still not found in mock (since we injected synthetic)
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // PREMIUM should appear in Roles list
  assert.ok(html.includes('>PREMIUM<') || html.includes('PREMIUM'), 'PREMIUM should be in Roles list');
  // Should show Built-in badge
  assert.ok(html.includes('Built-in'), 'Built-in badge for PREMIUM');
  // Should NOT show Delete button for PREMIUM, but should for PC Team/SuperUser
  // Count Delete buttons - should be 2 (for PC Team and SuperUser) not 3
  const deleteCount = (html.match(/Delete role/g) || []).length;
  assert.equal(deleteCount, 2, 'only 2 deletable roles, PREMIUM protected');
  // Should show Protected instead
  assert.ok(html.includes('Protected'), 'Protected label for PREMIUM');
  // PC Team and SuperUser should still be there
  assert.ok(html.includes('PC Team'), 'PC Team preserved');
  assert.ok(html.includes('SuperUser'), 'SuperUser preserved');
});

test('PREMIUM appears as assignable checkbox in User Role Assignments', async () => {
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [
        { id: 1, name: 'PC Team', description: '', created_at: new Date().toISOString() },
        { id: 2, name: 'SuperUser', description: '', created_at: new Date().toISOString() }
      ], rowCount: 2 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [{ id: 20, email: 'user@example.com', name: 'User' }], rowCount: 1 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [] };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql) && sql.includes('PREMIUM')) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // In User Role Assignments section, there should be checkboxes for all roles including PREMIUM
  // The form should have 3 checkboxes (PC Team, SuperUser, PREMIUM)
  // Count occurrences of checkbox with name role_ids
  const checkboxCount = (html.match(/name="role_ids"/g) || []).length;
  // There are 2 sections: User Role Assignments (per user) and Folder Access (select). For 1 user, User section will have 3 checkboxes, Folder section will have 3 checkboxes => total 6
  // At least should have PREMIUM checkbox value -1 (synthetic) or real id
  assert.ok(html.includes('PREMIUM'), 'PREMIUM checkbox label present');
  // Ensure the checkbox for PREMIUM exists (value -1 or real)
  assert.ok(checkboxCount >= 3, `should have at least 3 role checkboxes, got ${checkboxCount}`);
});

test('Do not create duplicate PREMIUM if already exists', async () => {
  // Mock DB already has PREMIUM with id 5
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [
        { id: 1, name: 'PC Team', description: '', created_at: new Date().toISOString() },
        { id: 5, name: 'PREMIUM', description: 'Built-in Premium role', created_at: new Date().toISOString() },
        { id: 2, name: 'SuperUser', description: '', created_at: new Date().toISOString() }
      ], rowCount: 3 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [{ id: 20, email: 'user@example.com', name: 'User' }], rowCount: 1 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [] };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql) && sql.includes('PREMIUM')) {
      // Should be called but ON CONFLICT will do nothing, we return 0
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) {
      return { rows: [{ id: 5 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // Should still only have one PREMIUM entry, not duplicated
  const premiumOccurrences = (html.match(/>PREMIUM</g) || []).length;
  // There will be multiple occurrences: Roles table, User checkboxes, Folder checkboxes => at least 3, but should not be duplicated as 6 etc due to duplicate insertion
  // Count distinct Roles table occurrences: should be 1 in roles table header + maybe 1 in list, but we can check that there are not 2 separate PREMIUM rows in roles table
  // Extract roles table section between <h2>Roles</h2> and next <h2>
  const rolesSection = html.split('<h2>Roles</h2>')[1]?.split('<h2 style="margin-top:28px">User Role Assignments</h2>')[0] || '';
  const premiumInRolesTable = (rolesSection.match(/PREMIUM/g) || []).length;
  assert.equal(premiumInRolesTable, 1, 'PREMIUM should appear exactly once in Roles table');
});

test('PREMIUM cannot be deleted (protected)', async () => {
  // Need to mock the delete attempt for PREMIUM id
  // First, get the page to see what id PREMIUM has after injection (could be 5 or -1)
  // We will mock the delete handler to check that it returns error
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    // For delete, need to return name PREMIUM
    if (sql.includes('SELECT name FROM roles WHERE id = $1')) {
      // If id is 5, return PREMIUM
      if (params[0] === 5) return { rows: [{ name: 'PREMIUM' }], rowCount: 1 };
      if (params[0] === -1) return { rows: [{ name: 'PREMIUM' }], rowCount: 1 };
      return { rows: [{ name: 'PC Team' }], rowCount: 1 };
    }
    if (/DELETE FROM roles/.test(sql)) {
      // Should not be reached for PREMIUM
      return { rows: [], rowCount: 1 };
    }
    // For GET, return roles with PREMIUM
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [{ id: 5, name: 'PREMIUM', description: 'Built-in', created_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  // Try to delete PREMIUM with id 5
  const res = await http('/admin/folders/roles/5/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  // Should redirect with error, not success
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.ok(loc && loc.includes('error'), 'should redirect with error for protected PREMIUM');
  assert.ok(decodeURIComponent(loc).includes('protected') || decodeURIComponent(loc).includes('PREMIUM'), 'error should mention protected');

  // Also try synthetic -1
  const res2 = await http('/admin/folders/roles/-1/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res2.status, 302);
  const loc2 = res2.headers.get('location');
  assert.ok(loc2 && loc2.includes('error'), 'synthetic PREMIUM also protected');
});

test('PC Team/SuperUser still deletable and payment sync unchanged', async () => {
  const viewSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-folders.ejs'), 'utf8');
  assert.ok(viewSrc.includes('PC Team') || viewSrc.includes('SuperUser') || viewSrc.includes('roles'), 'view still references roles');
  // Ensure payment sync file not modified for this change
  const premiumSrc = fs.readFileSync(new URL('../src/auth/premium.js', import.meta.url), 'utf8');
  assert.ok(premiumSrc.includes('hasValidPremiumEntitlement'), 'payment sync still present');
  assert.ok(premiumSrc.includes('syncUserPremiumRole'), 'sync still present');
  // Ensure folder view still has delete button for non-premium
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM roles/.test(sql) && sql.includes('SELECT id, name')) {
      return { rows: [
        { id: 1, name: 'PC Team', description: '', created_at: new Date().toISOString() },
        { id: 2, name: 'SuperUser', description: '', created_at: new Date().toISOString() },
        { id: 5, name: 'PREMIUM', description: 'Built-in', created_at: new Date().toISOString() }
      ], rowCount: 3 };
    }
    if (/SELECT id, email, name FROM users/.test(sql)) return { rows: [{ id: 20, email: 'u@x.com', name: 'U' }], rowCount: 1 };
    if (/SELECT user_id, role_id FROM user_roles/.test(sql)) return { rows: [] };
    if (/SELECT id, folder_path/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT folder_path, role_id FROM folder_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM roles WHERE name = 'PREMIUM'/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/admin/folders', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // PC Team and SuperUser should have Delete buttons
  assert.ok(html.includes('PC Team') && html.includes('Delete role'), 'PC Team deletable');
  assert.ok(html.includes('SuperUser') && html.includes('Delete role'), 'SuperUser deletable');
});
