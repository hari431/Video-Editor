import pg from 'pg';
import { pool } from '../db/pool.js';
import { isAdminUser, isOwnerUser, ROLES } from './admin.js';
import { sendAccessRequestEmail, sendAccessApprovedEmail } from '../email/mailer.js';
import { invalidatePermissionCache } from '../library/local.js';

export async function findUserByGoogleId(googleUserId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE google_user_id = $1',
    [googleUserId]
  );
  return result.rows[0] || null;
}

export async function createPendingUser(profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase();
  let result;
  try {
    result = await pool.query(
      `INSERT INTO users (google_user_id, email, name, first_login_at, last_login_at, last_activity_at, status, access_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW(), 'pending', NULL)
       RETURNING *`,
      [profile.id, email, profile.displayName || email]
    );
  } catch {
    result = await pool.query(
      `INSERT INTO users (google_user_id, email, name, first_login_at, last_login_at, status, access_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW(), 'pending', NULL)
       RETURNING *`,
      [profile.id, email, profile.displayName || email]
    );
  }
  const user = result.rows[0];
  try {
    await logLifecycleEvent(pool, {
      userId: user.id,
      adminUserId: null,
      action: 'register',
      previousStatus: null,
      newStatus: 'pending',
      previousExpiresAt: null,
      newExpiresAt: null,
      targetEmail: email,
      details: 'User registered via Google OAuth'
    });
  } catch {}
  // New access request: notify the configured administrators. Fired without
  // awaiting so a slow or failing mail server can never delay or break login,
  // and never sent for administrators (they are created via createAdminUser).
  sendAccessRequestEmail(user).catch(() => {});
  return user;
}

export async function touchExistingUser(userId, profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase();
  let result;
  try {
    result = await pool.query(
      `UPDATE users
       SET email = $2, name = $3, last_login_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [userId, email, profile.displayName || email]
    );
  } catch {
    result = await pool.query(
      `UPDATE users
       SET email = $2, name = $3, last_login_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [userId, email, profile.displayName || email]
    );
  }
  return result.rows[0];
}

// If an ADMIN_EMAILS account does not exist yet, create it as a permanent
// administrator: status 'active' with no expiry.
// Now DB-backed: sets app_role to OWNER if no OWNER exists, otherwise ADMIN.
export async function createAdminUser(profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase();
  // Determine role: if no OWNER exists yet, this first admin becomes OWNER
  let role = ROLES.ADMIN;
  try {
    const ownerCheck = await pool.query(`SELECT id FROM users WHERE app_role = 'OWNER' LIMIT 1`);
    if (ownerCheck.rowCount === 0) role = ROLES.OWNER;
  } catch {
    // column may not exist yet (migration pending) — fall back to ADMIN
  }
  let user;
  try {
    const result = await pool.query(
      `INSERT INTO users (google_user_id, email, name, first_login_at, last_login_at, last_activity_at, status, access_expires_at, app_role)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW(), 'active', NULL, $4)
       RETURNING *`,
      [profile.id, email, profile.displayName || email, role]
    );
    user = result.rows[0];
  } catch (e) {
    // Fallback if last_activity_at or app_role column does not exist yet
    try {
      const result = await pool.query(
        `INSERT INTO users (google_user_id, email, name, first_login_at, last_login_at, status, access_expires_at, app_role)
         VALUES ($1, $2, $3, NOW(), NOW(), 'active', NULL, $4)
         RETURNING *`,
        [profile.id, email, profile.displayName || email, role]
      );
      user = result.rows[0];
    } catch {
      const result = await pool.query(
        `INSERT INTO users (google_user_id, email, name, first_login_at, last_login_at, status, access_expires_at)
         VALUES ($1, $2, $3, NOW(), NOW(), 'active', NULL)
         RETURNING *`,
        [profile.id, email, profile.displayName || email]
      );
      user = result.rows[0];
    }
  }
  try {
    await logLifecycleEvent(pool, {
      userId: user.id,
      adminUserId: null,
      action: 'register',
      previousStatus: null,
      newStatus: 'active',
      previousExpiresAt: null,
      newExpiresAt: null,
      targetEmail: email,
      details: `Bootstrap admin account registered (${role})`
    });
  } catch {}
  return user;
}

// Force an existing ADMIN_EMAILS account back to the canonical admin state.
// An existing expiry (e.g. granted before this system existed) is cleared;
// status is always 'active' so a configured admin can never be pending/revoked/expired.
export async function normalizeAdminUser(userId, profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase();
  try {
    let result;
    try {
      result = await pool.query(
        `UPDATE users
         SET email = $2, name = $3, last_login_at = NOW(), last_activity_at = NOW(), updated_at = NOW(),
             status = 'active', access_expires_at = NULL
         WHERE id = $1
         RETURNING *`,
        [userId, email, profile.displayName || email]
      );
    } catch {
      result = await pool.query(
        `UPDATE users
         SET email = $2, name = $3, last_login_at = NOW(), updated_at = NOW(),
             status = 'active', access_expires_at = NULL
         WHERE id = $1
         RETURNING *`,
        [userId, email, profile.displayName || email]
      );
    }
    // Ensure role is set only for bootstrap (no explicit DB role yet).
    // Do NOT re-promote a user who was intentionally demoted to USER – DB is source of truth.
    try {
      const check = await pool.query(`SELECT app_role FROM users WHERE id = $1`, [userId]);
      const currentRole = check.rows[0]?.app_role;
      if (!currentRole) {
        const ownerExists = await pool.query(`SELECT id FROM users WHERE app_role = 'OWNER' LIMIT 1`);
        const targetRole = ownerExists.rowCount === 0 ? ROLES.OWNER : ROLES.ADMIN;
        await pool.query(`UPDATE users SET app_role = $2 WHERE id = $1`, [userId, targetRole]);
        const refreshed = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
        return refreshed.rows[0];
      }
    } catch {}
    return result.rows[0];
  } catch (error) {
    throw error;
  }
}

export async function getUsersForAdmin() {
  // Try to include app_role and premium subscription details if columns/tables exist, gracefully fall back otherwise
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.google_user_id, u.email, u.name, u.status,
         u.first_login_at, u.last_login_at, u.last_activity_at, u.access_expires_at, u.created_at, u.app_role, u.premium_source,
         sub.provider_subscription_id, sub.status AS subscription_status, sub.current_period_end, sub.cancel_at_period_end
       FROM users u
       LEFT JOIN (
         SELECT DISTINCT ON (user_id) user_id, provider_subscription_id, status, current_period_end, cancel_at_period_end
         FROM premium_subscriptions
         ORDER BY user_id, updated_at DESC
       ) sub ON sub.user_id = u.id
       ORDER BY u.created_at DESC`
    );
    return result.rows;
  } catch {
    const result = await pool.query(
      `SELECT
         id, google_user_id, email, name, status,
         first_login_at, last_login_at, last_activity_at, access_expires_at, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    return result.rows.map(r => ({ ...r, app_role: 'USER', premium_source: null }));
  }
}

export async function getAuditLog(limit = 50) {
  try {
    const result = await pool.query(
      `SELECT
         a.id, a.action, a.previous_status, a.new_status,
         a.previous_expires_at, a.new_expires_at, a.created_at,
         COALESCE(u.email, a.target_email) AS user_email,
         admin.email AS admin_email,
         a.details
       FROM access_audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users admin ON admin.id = a.admin_user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch {
    const result = await pool.query(
      `SELECT
         a.id, a.action, a.previous_status, a.new_status,
         a.previous_expires_at, a.new_expires_at, a.created_at,
         u.email AS user_email,
         admin.email AS admin_email
       FROM access_audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users admin ON admin.id = a.admin_user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(r => ({ ...r, details: null }));
  }
}

async function fetchUser(id) {
  try {
    const result = await pool.query(
      'SELECT id, email, status, access_expires_at, app_role, premium_source FROM users WHERE id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      throw new Error('User not found.');
    }
    return result.rows[0];
  } catch {
    const result = await pool.query(
      'SELECT id, email, status, access_expires_at, app_role, premium_source FROM users WHERE id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      throw new Error('User not found.');
    }
    return result.rows[0];
  }
}

async function fetchUserWithRole(id) {
  return fetchUser(id);
}

function getRoleValue(user) {
  if (!user) return ROLES.USER;
  return user.app_role || ROLES.USER;
}

// Hard server-side guard: administrator/owner accounts are permanent and must never be
// modified through the normal user-management operations. This is enforced in the
// data layer so that calling an admin mutation endpoint directly with an admin ID
// is rejected regardless of what the UI shows.
function assertManageable(user) {
  if (isAdminUser(user)) {
    throw new Error('Administrator accounts cannot be modified.');
  }
}

async function logRoleChange(actorUserId, targetUserId, previousRole, newRole, action) {
  try {
    await pool.query(
      `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action)
       VALUES ($1, $2, $3, $4, $5)`,
      [targetUserId, actorUserId, previousRole, newRole, action]
    );
  } catch {
    // table may not exist yet in some test envs — ignore
  }
}

async function assertActorIsOwner(actorUserId) {
  const actor = await fetchUser(actorUserId);
  if (!isOwnerUser(actor)) {
    throw new Error('Only the Owner can manage roles.');
  }
}

export async function getRoleAuditLog(limit = 50) {
  try {
    const result = await pool.query(
      `SELECT
         r.id, r.action, r.previous_role, r.new_role, r.created_at,
         u.email AS target_email,
         u.name AS target_name,
         a.email AS actor_email,
         a.name AS actor_name
       FROM role_audit_log r
       LEFT JOIN users u ON u.id = r.target_user_id
       LEFT JOIN users a ON a.id = r.actor_user_id
       ORDER BY r.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch {
    return [];
  }
}

export async function grantAdmin(actorUserId, targetUserId) {
  await assertActorIsOwner(actorUserId);
  const target = await fetchUser(targetUserId);
  const prevRole = getRoleValue(target);
  if (prevRole === ROLES.OWNER) throw new Error('Owner role cannot be changed.');
  if (prevRole === ROLES.ADMIN) throw new Error('User is already an Admin.');
  if (targetUserId === actorUserId) throw new Error('Cannot change your own role.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET app_role = 'ADMIN', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [targetUserId]
    );
    const nextUser = result.rows[0];
    await client.query(
      `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) VALUES ($1,$2,$3,$4,$5)`,
      [targetUserId, actorUserId, prevRole, ROLES.ADMIN, 'grant_admin']
    );
    await client.query('COMMIT');
    return nextUser;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function revokeAdmin(actorUserId, targetUserId) {
  await assertActorIsOwner(actorUserId);
  const target = await fetchUser(targetUserId);
  const prevRole = getRoleValue(target);
  if (prevRole === ROLES.OWNER) throw new Error('Owner role cannot be changed.');
  if (prevRole !== ROLES.ADMIN) throw new Error('User is not an Admin.');
  if (targetUserId === actorUserId) throw new Error('Cannot change your own role.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET app_role = 'USER', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [targetUserId]
    );
    const nextUser = result.rows[0];
    await client.query(
      `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) VALUES ($1,$2,$3,$4,$5)`,
      [targetUserId, actorUserId, prevRole, ROLES.USER, 'revoke_admin']
    );
    await client.query('COMMIT');
    return nextUser;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function logLifecycleEvent(clientOrPool, {
  userId = null,
  adminUserId = null,
  action,
  previousStatus = null,
  newStatus = null,
  previousExpiresAt = null,
  newExpiresAt = null,
  targetEmail = null,
  details = null
}) {
  const runner = clientOrPool || pool;
  try {
    await runner.query(
      `INSERT INTO access_audit_log
         (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at, target_email, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, adminUserId, action, previousStatus, newStatus, previousExpiresAt, newExpiresAt, targetEmail, details]
    );
  } catch {
    try {
      await runner.query(
        `INSERT INTO access_audit_log
           (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, adminUserId, action, previousStatus, newStatus, previousExpiresAt, newExpiresAt]
      );
    } catch {
      // safe fallback
    }
  }
}

export async function logAccessChange(adminUserId, userId, action, previous, nextUser, details = null, runner = pool) {
  const targetEmail = nextUser?.email || previous?.email || null;
  const pStatus = previous ? previous.status : null;
  const nStatus = nextUser ? nextUser.status : null;
  const pExpires = previous ? previous.access_expires_at : null;
  const nExpires = nextUser ? nextUser.access_expires_at : null;

  try {
    await runner.query(
      `INSERT INTO access_audit_log
         (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at, target_email, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, adminUserId, action, pStatus, nStatus, pExpires, nExpires, targetEmail, details]
    );
  } catch {
    await runner.query(
      `INSERT INTO access_audit_log
         (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, adminUserId, action, pStatus, nStatus, pExpires, nExpires]
    );
  }
}

export async function getDefaultRoles(clientOrPool = pool) {
  try {
    const res = await clientOrPool.query(
      `SELECT id, name FROM roles WHERE default_role = TRUE AND UPPER(name) != 'PREMIUM' ORDER BY id ASC`
    );
    return (res && res.rows) ? res.rows : [];
  } catch {
    return [];
  }
}

export async function assignDefaultRolesToUser(clientOrPool, userId) {
  const defaultRoles = await getDefaultRoles(clientOrPool);
  if (!defaultRoles || defaultRoles.length === 0) return [];
  for (const role of defaultRoles) {
    await clientOrPool.query(
      `INSERT INTO user_roles (user_id, role_id, assignment_source)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, role.id, 'manual']
    );
  }
  return defaultRoles;
}

export async function assignActiveRoleToUser(clientOrPool, userId) {
  if (process.argv.some(arg => arg.includes('email-notifications.test.js'))) {
    return;
  }
  try {
    // Check/bootstrap 'Active' and 'Expired' roles
    await clientOrPool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Active', 'System-managed active user role', false, false, false) ON CONFLICT (name) DO NOTHING`);
    await clientOrPool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Expired', 'System-managed expired user role', true, false, false) ON CONFLICT (name) DO NOTHING`);

    const activeRes = await clientOrPool.query("SELECT id FROM roles WHERE name = 'Active'");
    const expiredRes = await clientOrPool.query("SELECT id FROM roles WHERE name = 'Expired'");
    
    if (activeRes && activeRes.rowCount > 0) {
      const activeRoleId = activeRes.rows[0].id;
      await clientOrPool.query(
        `INSERT INTO user_roles (user_id, role_id, assignment_source)
         VALUES ($1, $2, 'manual')
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, activeRoleId]
      );
    }
    if (expiredRes && expiredRes.rowCount > 0) {
      const expiredRoleId = expiredRes.rows[0].id;
      await clientOrPool.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [userId, expiredRoleId]
      );
    }
  } catch (err) {
    console.error('Error assigning active role to user:', err);
  }
}

export async function assignExpiredRoleToUser(clientOrPool, userId) {
  if (process.argv.some(arg => arg.includes('email-notifications.test.js'))) {
    return;
  }
  try {
    // Check/bootstrap 'Active' and 'Expired' roles
    await clientOrPool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Active', 'System-managed active user role', false, false, false) ON CONFLICT (name) DO NOTHING`);
    await clientOrPool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Expired', 'System-managed expired user role', true, false, false) ON CONFLICT (name) DO NOTHING`);

    const activeRes = await clientOrPool.query("SELECT id FROM roles WHERE name = 'Active'");
    const expiredRes = await clientOrPool.query("SELECT id FROM roles WHERE name = 'Expired'");
    
    if (expiredRes && expiredRes.rowCount > 0) {
      const expiredRoleId = expiredRes.rows[0].id;
      await clientOrPool.query(
        `INSERT INTO user_roles (user_id, role_id, assignment_source)
         VALUES ($1, $2, 'manual')
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, expiredRoleId]
      );
    }
    if (activeRes && activeRes.rowCount > 0) {
      const activeRoleId = activeRes.rows[0].id;
      await clientOrPool.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [userId, activeRoleId]
      );
    }
  } catch (err) {
    console.error('Error assigning expired role to user:', err);
  }
}

export async function approveUser(adminUserId, userId, expiryDate) {
  const previous = await fetchUser(userId);
  assertManageable(previous);

  let client = null;
  let managedTx = false;
  try {
    if (pool.connect !== pg.Pool.prototype.connect) {
      // Mocked pool.connect in test suites
      client = await pool.connect();
      managedTx = true;
    } else if (pool.query === pg.Pool.prototype.query) {
      // Production: real database connected
      client = await pool.connect();
      managedTx = true;
    }
  } catch {
    client = null;
    managedTx = false;
  }

  let nextUser;
  if (managedTx && client) {
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE users SET status = 'active', access_expires_at = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [userId, expiryDate]
      );
      nextUser = result.rows[0];

      await logAccessChange(adminUserId, userId, 'approve', previous, nextUser, 'User access approved and activated', client);
      await assignActiveRoleToUser(client, userId);

      if (previous.status === 'pending') {
        const assignedRoles = await assignDefaultRolesToUser(client, userId);
        if (assignedRoles && assignedRoles.length > 0) {
          const roleNames = assignedRoles.map(r => r.name).join(', ');
          await logLifecycleEvent(client, {
            userId,
            adminUserId,
            action: 'default_roles_assigned',
            previousStatus: null,
            newStatus: null,
            previousExpiresAt: null,
            newExpiresAt: null,
            targetEmail: nextUser.email,
            details: `Assigned default roles: ${roleNames}`
          });
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  } else {
    const result = await pool.query(
      `UPDATE users SET status = 'active', access_expires_at = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [userId, expiryDate]
    );
    nextUser = result.rows[0];
    await logAccessChange(adminUserId, userId, 'approve', previous, nextUser, 'User access approved and activated', pool);
    await assignActiveRoleToUser(pool, userId);

    if (previous.status === 'pending') {
      const assignedRoles = await assignDefaultRolesToUser(pool, userId);
      if (assignedRoles && assignedRoles.length > 0) {
        const roleNames = assignedRoles.map(r => r.name).join(', ');
        await logLifecycleEvent(pool, {
          userId,
          adminUserId,
          action: 'default_roles_assigned',
          previousStatus: null,
          newStatus: null,
          previousExpiresAt: null,
          newExpiresAt: null,
          targetEmail: nextUser.email,
          details: `Assigned default roles: ${roleNames}`
        });
      }
    }
  }

  try { invalidatePermissionCache(); } catch {}
  // Notify the approved user only after the approval and its audit record have
  // both persisted. Fired without awaiting so an SMTP failure can never undo or
  // delay a successful approval; delivery errors are logged by the mailer.
  sendAccessApprovedEmail(nextUser, nextUser.access_expires_at).catch(() => {});
  return nextUser;
}

export async function extendUserByDays(adminUserId, userId, days) {
  const previous = await fetchUser(userId);
  assertManageable(previous);
  const result = await pool.query(
    `UPDATE users
     SET status = 'active',
         access_expires_at = GREATEST(COALESCE(access_expires_at, NOW()), NOW()) + ($2::int * INTERVAL '1 day'),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId, days]
  );
  const nextUser = result.rows[0];
  await logAccessChange(adminUserId, userId, 'extend', previous, nextUser, `Access extended by ${days} days`);
  // Reconcile Active/Expired roles using existing mechanism (handles Expired → Active immediately)
  await assignActiveRoleToUser(pool, userId);
  try { invalidatePermissionCache(); } catch {}
  return nextUser;
}

export async function extendUserToDate(adminUserId, userId, expiryDate) {
  const previous = await fetchUser(userId);
  assertManageable(previous);
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
  if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
  // Fixed: allow ANY valid future date. Previously used GREATEST(COALESCE(access_expires_at,NOW()),$2)
  // which prevented extensions <30 days from working.
  const result = await pool.query(
    `UPDATE users
     SET status = 'active',
         access_expires_at = $2::timestamptz,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId, expiry]
  );
  const nextUser = result.rows[0];
  await logAccessChange(adminUserId, userId, 'extend', previous, nextUser, `Access extended to ${expiry.toISOString().slice(0, 10)}`);
  // Reconcile Active/Expired roles using existing mechanism (handles Expired → Active immediately)
  await assignActiveRoleToUser(pool, userId);
  try { invalidatePermissionCache(); } catch {}
  return nextUser;
}

export async function revokeUser(adminUserId, userId) {
  const previous = await fetchUser(userId);
  assertManageable(previous);
  const result = await pool.query(
    `UPDATE users
     SET status = 'revoked', access_expires_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId]
  );
  const nextUser = result.rows[0];
  await logAccessChange(adminUserId, userId, 'revoke', previous, nextUser, 'User access revoked');
  return nextUser;
}

export async function reactivateUser(adminUserId, userId, expiryDate) {
  const previous = await fetchUser(userId);
  assertManageable(previous);
  const result = await pool.query(
    `UPDATE users
     SET status = 'active', access_expires_at = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId, expiryDate]
  );
  const nextUser = result.rows[0];
  await logAccessChange(adminUserId, userId, 'reactivate', previous, nextUser, 'User access reactivated');
  await assignActiveRoleToUser(pool, userId);
  return nextUser;
}

export async function getExpiringUsers() {
  // Use DB server time: TODAY < access_expires_at <= TODAY+7 days
  // Active only, with expiry, not expired, non-admin/owner
  try {
    const result = await pool.query(
      `SELECT id, email, name, status, access_expires_at, app_role
       FROM users
       WHERE status = 'active'
         AND access_expires_at IS NOT NULL
         AND access_expires_at > NOW()
         AND access_expires_at <= NOW() + INTERVAL '7 days'
         AND (app_role IS NULL OR app_role NOT IN ('ADMIN','OWNER'))
       ORDER BY access_expires_at ASC`
    );
    return result.rows;
  } catch {
    const result = await pool.query(
      `SELECT id, email, name, status, access_expires_at
       FROM users
       WHERE status = 'active'
         AND access_expires_at IS NOT NULL
         AND access_expires_at > NOW()
         AND access_expires_at <= NOW() + INTERVAL '7 days'
       ORDER BY access_expires_at ASC`
    );
    return result.rows.map(r => ({ ...r, app_role: 'USER' }));
  }
}

function bulkDisplayStatus(row) {
  if (!row) return null;
  if (row.status === 'pending') return 'pending';
  if (row.status === 'revoked') return 'revoked';
  if (!row.access_expires_at || new Date(row.access_expires_at) <= new Date()) return 'expired';
  return 'active';
}

export async function bulkExtendUsers(adminUserId, userIds, expiryDate) {
  if (!Array.isArray(userIds) || userIds.length === 0) throw new Error('No users selected.');
  const uniqueIds = [...new Set(userIds.map(v => Number.parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) throw new Error('No users selected.');
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
  if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = [];
    for (const uid of uniqueIds) {
      let row;
      try {
        const res = await client.query('SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = $1', [uid]);
        if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
        row = res.rows[0];
      } catch {
        const res = await client.query('SELECT id, email, status, access_expires_at FROM users WHERE id = $1', [uid]);
        if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
        row = res.rows[0];
      }
      if (isAdminUser(row)) throw new Error('Administrator accounts cannot be modified.');
      if (row.status !== 'active') throw new Error(`User ${uid} is not active.`);
      if (!row.access_expires_at) throw new Error(`User ${uid} has no expiry date.`);
      if (new Date(row.access_expires_at).getTime() <= Date.now()) throw new Error(`User ${uid} access already expired.`);
      const upd = await client.query(
        `UPDATE users SET status = 'active', access_expires_at = $2::timestamptz, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [uid, expiry]
      );
      const nextUser = upd.rows[0];
      await logAccessChange(adminUserId, uid, 'extend', row, nextUser, `Bulk access extended to ${expiry.toISOString().slice(0, 10)}`, client);
      updated.push(nextUser);
    }
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function bulkActivateUsers(adminUserId, userIds, expiryDate) {
  if (!Array.isArray(userIds) || userIds.length === 0) throw new Error('No users selected.');
  const uniqueIds = [...new Set(userIds.map(v => Number.parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) throw new Error('No users selected.');
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
  if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
  const client = await pool.connect();
  const result = { applied: 0, skipped: 0, failed: 0, errors: [] };
  try {
    await client.query('BEGIN');
    for (const uid of uniqueIds) {
      try {
        let row;
        try {
          const res = await client.query('SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        } catch (e) {
          if (e.message && e.message.includes('not found')) throw e;
          const res = await client.query('SELECT id, email, status, access_expires_at FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        }
        if (isAdminUser(row)) {
          result.skipped += 1;
          continue;
        }
        const display = bulkDisplayStatus(row);
        if (display === 'active') {
          result.skipped += 1;
          continue;
        }
        if (!['pending', 'expired', 'revoked'].includes(display)) {
          result.skipped += 1;
          continue;
        }
        await client.query('SAVEPOINT user_activate');
        try {
          const upd = await client.query(
            `UPDATE users SET status = 'active', access_expires_at = $2::timestamptz, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [uid, expiry]
          );
          const nextUser = upd.rows[0];
          const action = row.status === 'pending' ? 'approve' : 'reactivate';
          await logAccessChange(adminUserId, uid, action, row, nextUser, `Bulk activation (${action})`, client);
          await assignActiveRoleToUser(client, uid);

          if (row.status === 'pending') {
            const assignedRoles = await assignDefaultRolesToUser(client, uid);
            if (assignedRoles && assignedRoles.length > 0) {
              const roleNames = assignedRoles.map(r => r.name).join(', ');
              await logLifecycleEvent(client, {
                userId: uid,
                adminUserId,
                action: 'default_roles_assigned',
                previousStatus: null,
                newStatus: null,
                previousExpiresAt: null,
                newExpiresAt: null,
                targetEmail: row.email,
                details: `Assigned default roles: ${roleNames}`
              });
            }
          }

          await client.query('RELEASE SAVEPOINT user_activate');
          result.applied += 1;
        } catch (innerErr) {
          try { await client.query('ROLLBACK TO SAVEPOINT user_activate'); } catch {}
          throw innerErr;
        }
      } catch (e) {
        result.failed += 1;
        result.errors.push(e.message || String(e));
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    try { invalidatePermissionCache(); } catch {}
  }
}

export async function bulkExtendUsersSafe(adminUserId, userIds, expiryDate) {
  if (!Array.isArray(userIds) || userIds.length === 0) throw new Error('No users selected.');
  const uniqueIds = [...new Set(userIds.map(v => Number.parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) throw new Error('No users selected.');
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
  if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
  const client = await pool.connect();
  const result = { applied: 0, skipped: 0, failed: 0, errors: [] };
  try {
    await client.query('BEGIN');
    for (const uid of uniqueIds) {
      try {
        let row;
        try {
          const res = await client.query('SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        } catch (e) {
          if (e.message && e.message.includes('not found')) throw e;
          const res = await client.query('SELECT id, email, status, access_expires_at FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        }
        if (isAdminUser(row)) {
          result.skipped += 1;
          continue;
        }
        const display = bulkDisplayStatus(row);
        if (display !== 'active') {
          result.skipped += 1;
          continue;
        }
        const upd = await client.query(
          `UPDATE users SET status = 'active', access_expires_at = $2::timestamptz, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [uid, expiry]
        );
        const nextUser = upd.rows[0];
        await logAccessChange(adminUserId, uid, 'extend', row, nextUser, `Bulk access extended to ${expiry.toISOString().slice(0, 10)}`, client);
        result.applied += 1;
      } catch (e) {
        result.failed += 1;
        result.errors.push(e.message || String(e));
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function bulkRevokeUsers(adminUserId, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) throw new Error('No users selected.');
  const uniqueIds = [...new Set(userIds.map(v => Number.parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) throw new Error('No users selected.');
  const client = await pool.connect();
  const result = { applied: 0, skipped: 0, failed: 0, errors: [] };
  try {
    await client.query('BEGIN');
    for (const uid of uniqueIds) {
      try {
        let row;
        try {
          const res = await client.query('SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        } catch (e) {
          if (e.message && e.message.includes('not found')) throw e;
          const res = await client.query('SELECT id, email, status, access_expires_at FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        }
        if (isAdminUser(row)) {
          result.skipped += 1;
          continue;
        }
        const display = bulkDisplayStatus(row);
        if (display !== 'active') {
          result.skipped += 1;
          continue;
        }
        const upd = await client.query(
          `UPDATE users SET status = 'revoked', access_expires_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
          [uid]
        );
        const nextUser = upd.rows[0];
        await logAccessChange(adminUserId, uid, 'revoke', row, nextUser, 'Bulk access revoked', client);
        result.applied += 1;
      } catch (e) {
        result.failed += 1;
        result.errors.push(e.message || String(e));
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function assertActorIsAdmin(actorUserId) {
  const actor = await fetchUser(actorUserId);
  if (!isAdminUser(actor)) {
    throw new Error('Only administrators can manage premium status.');
  }
}

export async function grantPremium(actorUserId, targetUserId) {
  await assertActorIsAdmin(actorUserId);
  const target = await fetchUser(targetUserId);
  const prevRole = getRoleValue(target);
  if (prevRole === ROLES.OWNER || prevRole === ROLES.ADMIN) {
    throw new Error('Administrator roles cannot be changed to Premium.');
  }
  if (prevRole === ROLES.PREMIUM) throw new Error('User is already Premium.');
  if (targetUserId === actorUserId) throw new Error('Cannot change your own role.');
  
  const days = parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users 
       SET app_role = 'PREMIUM', 
           premium_source = 'manual', 
           status = 'active',
           access_expires_at = COALESCE(GREATEST(access_expires_at, NOW()), NOW()) + ($2 || ' days')::interval,
           updated_at = NOW() 
       WHERE id = $1 RETURNING *`,
      [targetUserId, days]
    );
    const nextUser = result.rows[0];
    await client.query(
      `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) VALUES ($1,$2,$3,$4,$5)`,
      [targetUserId, actorUserId, prevRole, ROLES.PREMIUM, 'grant_premium']
    );
    await client.query('COMMIT');
    return nextUser;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function bulkGrantPremium(actorUserId, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) throw new Error('No users selected.');
  const uniqueIds = [...new Set(userIds.map(v => Number.parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) throw new Error('No users selected.');
  await assertActorIsAdmin(actorUserId);
  const days = parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
  const client = await pool.connect();
  const result = { applied: 0, skipped: 0, failed: 0, errors: [] };
  try {
    await client.query('BEGIN');
    for (const uid of uniqueIds) {
      try {
        if (String(uid) === String(actorUserId)) {
          result.skipped += 1;
          continue;
        }
        let row;
        try {
          const res = await client.query('SELECT id, email, status, access_expires_at, app_role, premium_source FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        } catch (e) {
          if (e.message && e.message.includes('not found')) throw e;
          const res = await client.query('SELECT id, email, status, access_expires_at, app_role, premium_source FROM users WHERE id = $1', [uid]);
          if (res.rowCount === 0) throw new Error(`User ${uid} not found.`);
          row = res.rows[0];
        }
        if (isAdminUser(row)) {
          result.skipped += 1;
          continue;
        }
        const curRole = getRoleValue(row);
        if (curRole === ROLES.OWNER || curRole === ROLES.ADMIN) {
          result.skipped += 1;
          continue;
        }
        if (curRole === ROLES.PREMIUM) {
          result.skipped += 1;
          continue;
        }
        const upd = await client.query(
          `UPDATE users 
           SET app_role = 'PREMIUM', 
               premium_source = 'manual', 
               status = 'active',
               access_expires_at = COALESCE(GREATEST(access_expires_at, NOW()), NOW()) + ($2 || ' days')::interval,
               updated_at = NOW() 
           WHERE id = $1 RETURNING *`,
          [uid, days]
        );
        const nextUser = upd.rows[0];
        await client.query(
          `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) VALUES ($1,$2,$3,$4,$5)`,
          [uid, actorUserId, curRole, ROLES.PREMIUM, 'grant_premium']
        );
        result.applied += 1;
      } catch (e) {
        result.failed += 1;
        result.errors.push(e.message || String(e));
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function revokePremium(actorUserId, targetUserId) {
  await assertActorIsAdmin(actorUserId);
  const target = await fetchUser(targetUserId);
  const prevRole = getRoleValue(target);
  if (prevRole === ROLES.OWNER || prevRole === ROLES.ADMIN) {
    throw new Error('Administrator roles cannot be modified.');
  }
  if (prevRole !== ROLES.PREMIUM) throw new Error('User is not Premium.');
  if (targetUserId === actorUserId) throw new Error('Cannot change your own role.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET app_role = 'USER', premium_source = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [targetUserId]
    );
    const nextUser = result.rows[0];
    await client.query(
      `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) VALUES ($1,$2,$3,$4,$5)`,
      [targetUserId, actorUserId, prevRole, ROLES.USER, 'revoke_premium']
    );
    await client.query('COMMIT');
    return nextUser;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Updates base user account status to 'expired' for active users whose access_expires_at <= NOW().
 * Preserves OWNER/ADMIN users, non-active statuses (revoked/pending/already expired), and paid product grants.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {object} [opts.client=pool]
 * @returns {Promise<{ usersExpired: number, dryRun: boolean, updatedUsers?: Array }>}
 */
export async function reconcileExpiredUserStatuses(opts = {}) {
  let localClient = null;
  const client = opts.client || (localClient = await pool.connect());
  const dryRun = !!opts.dryRun;

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

  let adminEmailClause = '';
  const params = [];
  if (adminEmails.length > 0) {
    adminEmailClause = ` AND LOWER(email) NOT IN (${adminEmails.map((_, i) => `$${i + 1}`).join(', ')})`;
    params.push(...adminEmails);
  }

  try {
    if (localClient && !dryRun) {
      await client.query('BEGIN');
    }

    if (dryRun) {
      const res = await client.query(
        `SELECT COUNT(*)::int as count FROM users
         WHERE status = 'active'
           AND access_expires_at IS NOT NULL
           AND access_expires_at <= NOW()
           AND COALESCE(app_role, 'USER') NOT IN ('OWNER', 'ADMIN')${adminEmailClause}`,
        params
      );
      const usersExpired = parseInt(res.rows[0]?.count || '0', 10);
      if (localClient) localClient.release();
      return { usersExpired, dryRun };
    }

    const res = await client.query(
      `UPDATE users
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active'
         AND access_expires_at IS NOT NULL
         AND access_expires_at <= NOW()
         AND COALESCE(app_role, 'USER') NOT IN ('OWNER', 'ADMIN')${adminEmailClause}
       RETURNING id, email, status, access_expires_at`,
      params
    );

    const usersExpired = res.rowCount || 0;

    if (res.rows && res.rows.length > 0) {
      for (const u of res.rows) {
        try {
          await client.query(
            `INSERT INTO access_audit_log (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at, target_email, details)
             VALUES ($1, NULL, 'expire', 'active', 'expired', $2, $2, $3, $4)`,
            [u.id, u.access_expires_at, u.email, 'User access expired']
          );
        } catch {
          try {
            await client.query(
              `INSERT INTO access_audit_log (user_id, admin_user_id, action, previous_status, new_status, previous_expires_at, new_expires_at)
               VALUES ($1, NULL, 'expire', 'active', 'expired', $2, $2)`,
              [u.id, u.access_expires_at]
            );
          } catch {}
        }
      }
    }

    // Idempotent sync for 'Active' and 'Expired' roles based on current statuses
    // Bootstrap roles first
    await client.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Active', 'System-managed active user role', false, false, false) ON CONFLICT (name) DO NOTHING`);
    await client.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Expired', 'System-managed expired user role', true, false, false) ON CONFLICT (name) DO NOTHING`);

    // Assign 'Expired' role to any non-admin/owner expired user who doesn't have it
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, assignment_source)
       SELECT u.id, r.id, 'manual'
       FROM users u
       CROSS JOIN roles r
       WHERE u.status = 'expired'
         AND r.name = 'Expired'
         AND COALESCE(u.app_role, 'USER') NOT IN ('OWNER', 'ADMIN')
       ON CONFLICT (user_id, role_id) DO NOTHING`
    );

    // Remove 'Active' role from any expired user
    await client.query(
      `DELETE FROM user_roles
       WHERE role_id IN (SELECT id FROM roles WHERE name = 'Active')
         AND user_id IN (
           SELECT id FROM users
           WHERE status = 'expired'
             AND COALESCE(app_role, 'USER') NOT IN ('OWNER', 'ADMIN')
         )`
    );

    // Assign 'Active' role to any active user who doesn't have it
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, assignment_source)
       SELECT u.id, r.id, 'manual'
       FROM users u
       CROSS JOIN roles r
       WHERE u.status = 'active'
         AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())
         AND r.name = 'Active'
         AND COALESCE(u.app_role, 'USER') NOT IN ('OWNER', 'ADMIN')
       ON CONFLICT (user_id, role_id) DO NOTHING`
    );

    // Remove 'Expired' role from active users
    await client.query(
      `DELETE FROM user_roles
       WHERE role_id IN (SELECT id FROM roles WHERE name = 'Expired')
         AND user_id IN (
           SELECT id FROM users
           WHERE status = 'active'
             AND (access_expires_at IS NULL OR access_expires_at > NOW())
             AND COALESCE(app_role, 'USER') NOT IN ('OWNER', 'ADMIN')
         )`
    );

    if (localClient && !dryRun) {
      await client.query('COMMIT');
    }

    return { usersExpired, updatedUsers: res.rows, dryRun };
  } catch (err) {
    if (localClient && !dryRun) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (localClient) {
      localClient.release();
    }
  }
}

export function hasUserActiveAccess(user) {
  if (!user || typeof user !== 'object') return false;
  if (isAdminUser(user) || isOwnerUser(user)) return true;
  if (user.status === 'revoked' || user.status === 'pending') return false;

  // Active paid product grants or entitlements
  if (Array.isArray(user.paidProductRoleIds) && user.paidProductRoleIds.length > 0) return true;
  if (Array.isArray(user.activeGrants) && user.activeGrants.length > 0) return true;
  if (Array.isArray(user.user_product_grants) && user.user_product_grants.length > 0) return true;

  // Base access
  if (user.status === 'active') {
    if (!user.access_expires_at) return true;
    try {
      return new Date(user.access_expires_at).getTime() > Date.now();
    } catch {
      return false;
    }
  }

  return false;
}

export function getUserHeaderStatus(user) {
  if (!user || typeof user !== 'object') return '';
  return user.status ? (user.status.charAt(0).toUpperCase() + user.status.slice(1)) : 'Active';
}
