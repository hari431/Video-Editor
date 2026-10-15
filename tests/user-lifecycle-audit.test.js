import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  createPendingUser,
  createAdminUser,
  approveUser,
  extendUserByDays,
  extendUserToDate,
  revokeUser,
  reactivateUser,
  reconcileExpiredUserStatuses,
  bulkActivateUsers,
  bulkExtendUsers,
  bulkRevokeUsers,
  getAuditLog
} from '../src/auth/users.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 11, email: 'admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN' };
const ADMIN_SID = 'lifecycle-admin-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;

let server = null;
let port = 0;

test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
});

test('createPendingUser records User Registered lifecycle audit event', async () => {
  const auditEntries = [];
  const origQuery = pool.query;
  try {
    pool.query = async (sql, params = []) => {
      if (/INSERT INTO users/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: 201,
            google_user_id: params[0],
            email: params[1],
            name: params[2],
            status: 'pending',
            created_at: new Date()
          }]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    const user = await createPendingUser({
      id: 'g-201',
      emails: [{ value: 'newuser@example.com' }],
      displayName: 'New User'
    });

    assert.equal(user.email, 'newuser@example.com');
    assert.equal(auditEntries.length, 1);
    const audit = auditEntries[0];
    assert.match(audit.sql, /target_email/);
    assert.match(audit.sql, /details/);
    assert.equal(audit.params[0], 201); // userId
    assert.equal(audit.params[1], null); // adminUserId
    assert.equal(audit.params[2], 'register'); // action
    assert.equal(audit.params[3], null); // previous_status
    assert.equal(audit.params[4], 'pending'); // new_status
    assert.equal(audit.params[7], 'newuser@example.com'); // target_email
    assert.ok(audit.params[8].includes('User registered'));
  } finally {
    pool.query = origQuery;
  }
});

test('createAdminUser records User Registered lifecycle audit event', async () => {
  const auditEntries = [];
  const origQuery = pool.query;
  try {
    pool.query = async (sql, params = []) => {
      if (/SELECT id FROM users WHERE app_role = 'OWNER'/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: 10 }] };
      }
      if (/INSERT INTO users/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: 202,
            google_user_id: params[0],
            email: params[1],
            name: params[2],
            status: 'active',
            app_role: 'ADMIN',
            created_at: new Date()
          }]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    const user = await createAdminUser({
      id: 'g-admin',
      emails: [{ value: 'admin2@example.com' }],
      displayName: 'Admin Two'
    });

    assert.equal(user.email, 'admin2@example.com');
    assert.equal(auditEntries.length, 1);
    const audit = auditEntries[0];
    assert.equal(audit.params[0], 202);
    assert.equal(audit.params[1], null);
    assert.equal(audit.params[2], 'register');
    assert.equal(audit.params[4], 'active');
    assert.equal(audit.params[7], 'admin2@example.com');
    assert.ok(audit.params[8].includes('admin account registered'));
  } finally {
    pool.query = origQuery;
  }
});

test('approveUser records User Activated and Default Roles Assigned audit events', async () => {
  const auditEntries = [];
  const origQuery = pool.query;
  const pendingUser = {
    id: 301,
    email: 'pending@example.com',
    name: 'Pending User',
    status: 'pending',
    access_expires_at: null,
    app_role: 'USER'
  };

  try {
    pool.query = async (sql, params = []) => {
      if (/SELECT .* FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [pendingUser] };
      }
      if (/UPDATE users SET status = 'active'/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            ...pendingUser,
            status: 'active',
            access_expires_at: params[1]
          }]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (/FROM roles/i.test(sql)) {
        return { rowCount: 2, rows: [{ id: 1, name: 'Reader' }, { id: 2, name: 'Contributor' }] };
      }
      if (/INSERT INTO user_roles/i.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    const expiryDate = new Date(Date.now() + 30 * 86400000);
    const updated = await approveUser(ADMIN.id, 301, expiryDate);

    assert.equal(updated.status, 'active');
    // Expect 2 audit entries: 'approve' (User activated) and 'default_roles_assigned' (Default roles assigned during activation)
    assert.equal(auditEntries.length, 2);

    const approveEntry = auditEntries.find(e => e.params[2] === 'approve');
    assert.ok(approveEntry, 'approve entry found');
    assert.equal(approveEntry.params[0], 301); // target user id
    assert.equal(approveEntry.params[1], ADMIN.id); // admin user id
    assert.equal(approveEntry.params[3], 'pending'); // previous status
    assert.equal(approveEntry.params[4], 'active'); // new status
    assert.equal(approveEntry.params[7], 'pending@example.com'); // target_email

    const defaultRolesEntry = auditEntries.find(e => e.params[2] === 'default_roles_assigned');
    assert.ok(defaultRolesEntry, 'default_roles_assigned entry found');
    assert.equal(defaultRolesEntry.params[0], 301);
    assert.equal(defaultRolesEntry.params[1], ADMIN.id);
    assert.equal(defaultRolesEntry.params[7], 'pending@example.com');
    assert.ok(defaultRolesEntry.params[8].includes('Reader, Contributor'), 'details include assigned roles');
  } finally {
    pool.query = origQuery;
  }
});

test('extendUserByDays and extendUserToDate record User Access Extended audit events', async () => {
  const auditEntries = [];
  const origQuery = pool.query;
  const activeUser = {
    id: 401,
    email: 'bob@example.com',
    name: 'Bob',
    status: 'active',
    access_expires_at: new Date('2025-01-01T00:00:00Z'),
    app_role: 'USER'
  };

  try {
    pool.query = async (sql, params = []) => {
      if (/SELECT .* FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [activeUser] };
      }
      if (/UPDATE users/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            ...activeUser,
            access_expires_at: new Date('2025-02-01T00:00:00Z')
          }]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    await extendUserByDays(ADMIN.id, 401, 30);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].params[2], 'extend');
    assert.equal(auditEntries[0].params[7], 'bob@example.com');
    assert.ok(auditEntries[0].params[8].includes('extended by 30 days'));

    const futureDate = new Date(Date.now() + 60 * 86400000);
    await extendUserToDate(ADMIN.id, 401, futureDate);
    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries[1].params[2], 'extend');
    assert.equal(auditEntries[1].params[7], 'bob@example.com');
    assert.ok(auditEntries[1].params[8].includes('Access extended to'));
  } finally {
    pool.query = origQuery;
  }
});

test('revokeUser and reactivateUser record Revoke and Reactivate audit events', async () => {
  const auditEntries = [];
  const origQuery = pool.query;
  const user = {
    id: 501,
    email: 'charlie@example.com',
    name: 'Charlie',
    status: 'active',
    access_expires_at: new Date('2025-06-01T00:00:00Z'),
    app_role: 'USER'
  };

  try {
    pool.query = async (sql, params = []) => {
      if (/SELECT .* FROM users WHERE id/i.test(sql)) {
        return { rowCount: 1, rows: [user] };
      }
      if (/UPDATE users/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            ...user,
            status: /status = 'revoked'/i.test(sql) ? 'revoked' : 'active'
          }]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    await revokeUser(ADMIN.id, 501);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].params[2], 'revoke');
    assert.equal(auditEntries[0].params[3], 'active');
    assert.equal(auditEntries[0].params[4], 'revoked');
    assert.equal(auditEntries[0].params[7], 'charlie@example.com');
    assert.ok(auditEntries[0].params[8].includes('revoked'));

    user.status = 'revoked';
    const futureDate = new Date(Date.now() + 30 * 86400000);
    await reactivateUser(ADMIN.id, 501, futureDate);
    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries[1].params[2], 'reactivate');
    assert.equal(auditEntries[1].params[3], 'revoked');
    assert.equal(auditEntries[1].params[4], 'active');
    assert.equal(auditEntries[1].params[7], 'charlie@example.com');
    assert.ok(auditEntries[1].params[8].includes('reactivated'));
  } finally {
    pool.query = origQuery;
  }
});

test('reconcileExpiredUserStatuses records User Expired audit events', async () => {
  const auditEntries = [];
  const fakeClient = {
    query: async (sql, params = []) => {
      if (/UPDATE users/i.test(sql)) {
        return {
          rowCount: 2,
          rows: [
            { id: 601, email: 'exp1@example.com', status: 'expired', access_expires_at: new Date('2024-01-01') },
            { id: 602, email: 'exp2@example.com', status: 'expired', access_expires_at: new Date('2024-01-02') }
          ]
        };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  const result = await reconcileExpiredUserStatuses({ client: fakeClient, dryRun: false });
  assert.equal(result.usersExpired, 2);
  assert.equal(auditEntries.length, 2);

  assert.equal(auditEntries[0].params[0], 601);
  assert.match(auditEntries[0].sql, /'expire'/);
  assert.equal(auditEntries[0].params[2], 'exp1@example.com');
  assert.ok(auditEntries[0].params[3].includes('expired'));

  assert.equal(auditEntries[1].params[0], 602);
  assert.equal(auditEntries[1].params[2], 'exp2@example.com');
});

test('User deletion records User Deleted lifecycle audit event with local-only context', async () => {
  const targetUser = {
    id: 701,
    email: 'deleted@example.com',
    name: 'To Delete',
    status: 'active',
    access_expires_at: new Date('2025-01-01T00:00:00Z'),
    app_role: 'USER'
  };

  const auditEntries = [];
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const prevEnv = process.env.LOCAL_USER_DELETE_ENABLED;
  const prevNodeEnv = process.env.NODE_ENV;

  try {
    process.env.LOCAL_USER_DELETE_ENABLED = 'true';
    process.env.NODE_ENV = 'development';

    const mockQuery = async (sql, params = []) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        if (params[0] === ADMIN_SID) {
          return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: ADMIN.id } }) }] };
        }
        return { rows: [] };
      }
      if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
        if (Number(params[0]) === ADMIN.id) return { rowCount: 1, rows: [ADMIN] };
        if (Number(params[0]) === 701) return { rowCount: 1, rows: [targetUser] };
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO access_audit_log/i.test(sql)) {
        auditEntries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    };

    pool.query = mockQuery;
    pool.connect = async () => ({
      query: mockQuery,
      release: () => {}
    });

    const res = await fetch(`http://127.0.0.1:${port}/admin/users/701/delete`, {
      method: 'POST',
      headers: {
        Cookie: ADMIN_COOKIE
      },
      redirect: 'manual'
    });

    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').includes('/admin?msg=deleted'));

    assert.equal(auditEntries.length, 1);
    const deleteAudit = auditEntries[0];
    assert.equal(deleteAudit.params[1], ADMIN.id); // actor
    assert.equal(deleteAudit.params[2], 'delete'); // action
    assert.equal(deleteAudit.params[3], 'active'); // previous_status
    assert.equal(deleteAudit.params[4], 'deleted'); // new_status
    assert.equal(deleteAudit.params[7], 'deleted@example.com'); // target_email
    assert.ok(deleteAudit.params[8].includes('Local deletion'));
  } finally {
    process.env.LOCAL_USER_DELETE_ENABLED = prevEnv;
    process.env.NODE_ENV = prevNodeEnv;
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Bulk operations generate lifecycle audit entries for all affected users', async () => {
  const auditEntries = [];
  const fakeUsers = [
    { id: 801, email: 'u1@example.com', status: 'pending', access_expires_at: null, app_role: 'USER' },
    { id: 802, email: 'u2@example.com', status: 'revoked', access_expires_at: null, app_role: 'USER' }
  ];

  const origConnect = pool.connect;
  try {
    pool.connect = async () => ({
      query: async (sql, params = []) => {
        if (/SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = \$1/i.test(sql)) {
          const u = fakeUsers.find(x => x.id === params[0]);
          return { rowCount: u ? 1 : 0, rows: u ? [u] : [] };
        }
        if (/FROM roles/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: 1, name: 'DefaultRole' }] };
        }
        if (/UPDATE users SET status = 'active'/i.test(sql)) {
          const u = fakeUsers.find(x => x.id === params[0]);
          return { rowCount: 1, rows: [{ ...u, status: 'active', access_expires_at: params[1] }] };
        }
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          auditEntries.push({ sql, params });
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => {}
    });

    const expiry = new Date(Date.now() + 30 * 86400000);
    const result = await bulkActivateUsers(ADMIN.id, [801, 802], expiry);
    assert.equal(result.applied, 2);

    // 801 was pending -> approve + default_roles_assigned (2 audit entries)
    // 802 was revoked -> reactivate (1 audit entry)
    // Total 3 audit entries
    assert.equal(auditEntries.length, 3);
    assert.ok(auditEntries.some(e => e.params[2] === 'approve' && e.params[7] === 'u1@example.com'));
    assert.ok(auditEntries.some(e => e.params[2] === 'default_roles_assigned' && e.params[7] === 'u1@example.com'));
    assert.ok(auditEntries.some(e => e.params[2] === 'reactivate' && e.params[7] === 'u2@example.com'));
  } finally {
    pool.connect = origConnect;
  }
});

test('getAuditLog returns target_email and details for audit log views', async () => {
  const origQuery = pool.query;
  try {
    pool.query = async (sql, params = []) => {
      assert.match(sql, /details/);
      assert.match(sql, /target_email/);
      return {
        rows: [
          {
            id: 901,
            action: 'delete',
            previous_status: 'active',
            new_status: 'deleted',
            previous_expires_at: null,
            new_expires_at: null,
            created_at: new Date(),
            user_email: 'deleteduser@example.com',
            admin_email: 'admin@example.com',
            details: 'Local deletion of user account (deleteduser@example.com)'
          }
        ]
      };
    };

    const logs = await getAuditLog(10);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'delete');
    assert.equal(logs[0].user_email, 'deleteduser@example.com');
    assert.equal(logs[0].details, 'Local deletion of user account (deleteduser@example.com)');
  } finally {
    pool.query = origQuery;
  }
});
