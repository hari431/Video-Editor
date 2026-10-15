import { pool } from '../db/pool.js';
import { isAdminUser, isOwnerUser, ROLES } from './admin.js';
import { hasUserActiveAccess } from './users.js';

export const PERMISSIONS = {
  COPY_QUERY: 'COPY_QUERY',
  DOWNLOAD_PDF: 'DOWNLOAD_PDF',
  NOTES: 'NOTES'
};

const VALID_PERMISSIONS = new Set(Object.values(PERMISSIONS));

export function isValidPermission(permission) {
  return VALID_PERMISSIONS.has(permission);
}

export async function hasNotesPermission(user, dbClient = pool) {
  if (!user) return false;
  if (isOwnerUser(user) || isAdminUser(user)) return true;
  // Expired users cannot use Notes/Likes/Discussions – reuse Notes entitlement (no new permission)
  // Keep active-user behavior unchanged: only block when user is definitively expired (status or expiry) and has no active entitlement
  try {
    const isExplicitExpired = user.status === 'expired';
    const isActiveExpired = user.status === 'active' && user.access_expires_at && (()=>{ try{ return new Date(user.access_expires_at).getTime() <= Date.now(); }catch{ return false; }})();
    const isNoStatusExpired = !user.status && user.access_expires_at && (()=>{ try{ return new Date(user.access_expires_at).getTime() <= Date.now(); }catch{ return false; }})();
    if ((isExplicitExpired || isActiveExpired || isNoStatusExpired) && !hasUserActiveAccess(user)) return false;
  } catch {}
  if (
    user.notes_available === true ||
    user.has_notes === true ||
    user.hasNotes === true ||
    user.notes_enabled === true ||
    user.can_notes === true ||
    user.notes === true ||
    user.notes_permission === true
  ) {
    return true;
  }
  if (
    user.app_role === 'PREMIUM' ||
    user.role === 'PREMIUM' ||
    user.appRole === 'PREMIUM' ||
    user.app_role === 'Notes' ||
    user.role === 'Notes' ||
    user.app_role === 'NOTES' ||
    user.role === 'NOTES'
  ) {
    return true;
  }

  // If user object has role objects or strings loaded in memory (user.roles or user.user_roles)
  const roleList = Array.isArray(user.roles) ? user.roles : (Array.isArray(user.user_roles) ? user.user_roles : []);
  for (const r of roleList) {
    if (typeof r === 'string' && (r.toUpperCase() === 'NOTES' || r.toUpperCase() === 'PREMIUM')) {
      return true;
    }
    if (r && typeof r === 'object') {
      if (r.notes_available === true || r.notesAvailable === true) {
        return true;
      }
      if (typeof r.role_name === 'string' && (r.role_name.toUpperCase() === 'NOTES' || r.role_name.toUpperCase() === 'PREMIUM')) {
        return true;
      }
      if (typeof r.name === 'string' && (r.name.toUpperCase() === 'NOTES' || r.name.toUpperCase() === 'PREMIUM')) {
        return true;
      }
    }
  }

  if (user.id) {
    const userId = Number.parseInt(user.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) return false;

    // Check direct content_action_permissions
    try {
      const capRes = await dbClient.query(
        'SELECT 1 FROM content_action_permissions WHERE user_id = $1 AND permission = $2 LIMIT 1',
        [userId, PERMISSIONS.NOTES]
      );
      if (capRes.rowCount > 0 || (capRes.rows && capRes.rows.length > 0)) return true;
    } catch {}

    // Check role capabilities from user_roles
    try {
      if (Array.isArray(user.roles) && user.roles.length > 0) {
        const numericRoleIds = user.roles
          .map(r => (typeof r === 'object' && r ? r.id : r))
          .map(id => Number.parseInt(id, 10))
          .filter(id => Number.isInteger(id) && id > 0);
        
        if (numericRoleIds.length > 0) {
          const roleRes = await dbClient.query(
            'SELECT 1 FROM roles WHERE id = ANY($1::int[]) AND notes_available = TRUE LIMIT 1',
            [numericRoleIds]
          );
          if (roleRes.rowCount > 0 || (roleRes.rows && roleRes.rows.length > 0)) return true;
        }
      }

      const urRes = await dbClient.query(
        `SELECT 1 FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         WHERE ur.user_id = $1 AND r.notes_available = TRUE LIMIT 1`,
        [userId]
      );
      if (urRes.rowCount > 0 || (urRes.rows && urRes.rows.length > 0)) return true;
    } catch {}
  }

  return false;
}

export async function hasContentPermission(user, permission, dbClient = pool) {
  if (!isValidPermission(permission)) throw new Error('Unknown permission.');
  if (!user) return false;
  // OWNER and ADMIN are always allowed
  if (isOwnerUser(user) || isAdminUser(user)) return true;
  if (permission === PERMISSIONS.NOTES) {
    return hasNotesPermission(user, dbClient);
  }
  // USER: check explicit grant
  // user may have app_role = USER or no app_role (fallback USER)
  const result = await dbClient.query(
    'SELECT 1 FROM content_action_permissions WHERE user_id = $1 AND permission = $2 LIMIT 1',
    [user.id, permission]
  );
  return (result.rowCount > 0 || (result.rows && result.rows.length > 0));
}

// Synchronous helper for already-fetched permission sets (avoid N queries in loops)
export function hasPermissionFromSet(user, permission, grantedSet) {
  if (!isValidPermission(permission)) return false;
  if (!user) return false;
  if (isOwnerUser(user) || isAdminUser(user)) return true;
  return grantedSet ? grantedSet.has(permission) : false;
}

export async function getUserContentPermissions(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user.');
  try {
    const result = await pool.query(
      'SELECT permission FROM content_action_permissions WHERE user_id = $1',
      [id]
    );
    return new Set(result.rows.map(r => r.permission));
  } catch {
    // table may not exist yet (migration pending)
    return new Set();
  }
}

export async function getAllContentPermissions() {
  try {
    const result = await pool.query('SELECT user_id, permission FROM content_action_permissions');
    const map = new Map();
    for (const row of result.rows) {
      const set = map.get(Number(row.user_id)) || new Set();
      set.add(row.permission);
      map.set(Number(row.user_id), set);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Fetch user row for permission checks (minimal)
async function fetchUserForPerm(id) {
  try {
    const r = await pool.query('SELECT id, email, app_role FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new Error('User not found.');
    return r.rows[0];
  } catch (e) {
    if (e.message === 'User not found.') throw e;
    const r = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new Error('User not found.');
    return r.rows[0];
  }
}

async function assertActorIsOwner(actorUserId) {
  const actor = await fetchUserForPerm(actorUserId);
  if (!isOwnerUser(actor)) throw new Error('Only the Owner can manage content permissions.');
}

export async function grantContentPermission(targetUserId, permission, actorUserId) {
  if (!isValidPermission(permission)) throw new Error('Unknown permission.');
  const targetId = Number.parseInt(targetUserId, 10);
  const actorId = Number.parseInt(actorUserId, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new Error('Invalid target user.');
  if (!Number.isInteger(actorId) || actorId <= 0) throw new Error('Invalid actor.');
  await assertActorIsOwner(actorId);
  const target = await fetchUserForPerm(targetId);
  if (isOwnerUser(target)) throw new Error('Owner permissions cannot be modified.');
  // ADMIN already has implicit permissions; still allow but no-op equivalent — we treat as allowed but don't need row
  // However to keep audit clean, we still insert for ADMIN? Better to reject for ADMIN since they don't need explicit grant
  // Spec says Owner-granted permissions apply only to selected user, but Admin already allowed. We'll allow insert but it has no effect.
  // Let's allow it but it will be redundant.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content_action_permissions (user_id, permission, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, permission) DO UPDATE SET granted_by = $3, granted_at = NOW()`,
      [targetId, permission, actorId]
    );
    try {
      await client.query(
        `INSERT INTO content_permission_audit_log (target_user_id, permission, action, actor_user_id)
         VALUES ($1, $2, 'GRANT', $3)`,
        [targetId, permission, actorId]
      );
    } catch {}
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function revokeContentPermission(targetUserId, permission, actorUserId) {
  if (!isValidPermission(permission)) throw new Error('Unknown permission.');
  const targetId = Number.parseInt(targetUserId, 10);
  const actorId = Number.parseInt(actorUserId, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new Error('Invalid target user.');
  if (!Number.isInteger(actorId) || actorId <= 0) throw new Error('Invalid actor.');
  await assertActorIsOwner(actorId);
  const target = await fetchUserForPerm(targetId);
  if (isOwnerUser(target)) throw new Error('Owner permissions cannot be modified.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM content_action_permissions WHERE user_id = $1 AND permission = $2',
      [targetId, permission]
    );
    try {
      await client.query(
        `INSERT INTO content_permission_audit_log (target_user_id, permission, action, actor_user_id)
         VALUES ($1, $2, 'REVOKE', $3)`,
        [targetId, permission, actorId]
      );
    } catch {}
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function bulkUpdateContentPermissions(updates, actorUserId) {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error('No users selected.');
  const actorId = Number.parseInt(actorUserId, 10);
  if (!Number.isInteger(actorId) || actorId <= 0) throw new Error('Invalid actor.');
  await assertActorIsOwner(actorId);

  // Normalize and validate each update; deduce map to collapse duplicates (last wins)
  const dedup = new Map();
  for (const entry of updates) {
    const rawUserId = entry.user_id ?? entry.userId ?? entry.target_user_id ?? entry.id;
    const rawPermission = entry.permission;
    const rawGranted = entry.granted ?? entry.grantedState ?? entry.value;
    const targetId = Number.parseInt(rawUserId, 10);
    if (!Number.isInteger(targetId) || targetId <= 0) throw new Error('Invalid target user.');
    const permission = String(rawPermission || '').trim();
    if (!isValidPermission(permission)) throw new Error('Unknown permission.');
    let granted;
    if (typeof rawGranted === 'boolean') granted = rawGranted;
    else if (typeof rawGranted === 'string') {
      const v = rawGranted.trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'grant' || v === 'granted' || v === 'allowed') granted = true;
      else if (v === 'false' || v === '0' || v === 'revoke' || v === 'denied' || v === 'deny') granted = false;
      else throw new Error('Invalid permission state.');
    } else if (typeof rawGranted === 'number') granted = rawGranted !== 0;
    else throw new Error('Invalid permission state.');
    const key = `${targetId}:${permission}`;
    dedup.set(key, { targetId, permission, granted });
  }
  if (dedup.size === 0) throw new Error('No users selected.');
  const normalized = [...dedup.values()];

  // Validate targets: existence and not OWNER. Collect unique target IDs to check.
  const uniqueTargetIds = [...new Set(normalized.map(e => e.targetId))];
  const targetMap = new Map();
  for (const tid of uniqueTargetIds) {
    const target = await fetchUserForPerm(tid);
    if (isOwnerUser(target)) throw new Error('Owner permissions cannot be modified.');
    targetMap.set(tid, target);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { targetId, permission, granted } of normalized) {
      if (granted) {
        await client.query(
          `INSERT INTO content_action_permissions (user_id, permission, granted_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, permission) DO UPDATE SET granted_by = $3, granted_at = NOW()`,
          [targetId, permission, actorId]
        );
        try {
          await client.query(
            `INSERT INTO content_permission_audit_log (target_user_id, permission, action, actor_user_id)
             VALUES ($1, $2, 'GRANT', $3)`,
            [targetId, permission, actorId]
          );
        } catch {}
      } else {
        await client.query(
          'DELETE FROM content_action_permissions WHERE user_id = $1 AND permission = $2',
          [targetId, permission]
        );
        try {
          await client.query(
            `INSERT INTO content_permission_audit_log (target_user_id, permission, action, actor_user_id)
             VALUES ($1, $2, 'REVOKE', $3)`,
            [targetId, permission, actorId]
          );
        } catch {}
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
  const affectedUserCount = uniqueTargetIds.length;
  return { updatedUserCount: affectedUserCount, totalUpdates: normalized.length };
}

export async function getContentPermissionAuditLog(limit = 50) {
  try {
    const r = await pool.query(
      `SELECT c.id, c.permission, c.action, c.created_at,
              u.email AS target_email, u.name AS target_name,
              a.email AS actor_email, a.name AS actor_name
       FROM content_permission_audit_log c
       LEFT JOIN users u ON u.id = c.target_user_id
       LEFT JOIN users a ON a.id = c.actor_user_id
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch {
    return [];
  }
}
