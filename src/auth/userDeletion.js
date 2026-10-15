// src/auth/userDeletion.js — shared permanent user deletion (manual + automatic)
// Batch-safe, idempotent, FK-aware. Uses SAVEPOINT per table so missing tables don't abort transaction.
import { pool } from '../db/pool.js';
import { logLifecycleEvent } from './users.js';
import { isAdminUser, isOwnerUser } from './admin.js';

async function safeDelete(client, sql, params) {
  // Defensive: SAVEPOINT must be inside transaction; if no transaction, fallback to direct delete
  let savepointCreated = false;
  try {
    await client.query('SAVEPOINT sp_del');
    savepointCreated = true;
  } catch (e) {
    // No transaction active (batch without outer BEGIN) or other error – try direct delete without savepoint
    try {
      await client.query(sql, params);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await client.query(sql, params);
    try { await client.query('RELEASE SAVEPOINT sp_del'); } catch {}
    return true;
  } catch (e) {
    if (savepointCreated) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_del'); } catch {}
    }
    return false;
  }
}

// All known user-owned tables (explicit deletes cover SET NULL / no FK cases; CASCADE handles the rest)
const USER_TABLE_DELETES = [
  { sql: 'DELETE FROM content_action_permissions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM content_permission_audit_log WHERE target_user_id = $1 OR actor_user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM discussion_likes WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM reply_likes WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM discussion_moderation_actions WHERE actor_user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM interview_question_notes WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM recently_viewed WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM content_seen WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM content_ignore WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM item_likes WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM query_usage WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM video_views WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM video_progress WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM discussion_replies WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM discussions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM folder_permissions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM user_roles WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM user_product_grants WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM paid_product_events WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM promo_redemptions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM paid_product_promo_redemptions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM premium_subscription_events WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM premium_subscription_events WHERE subscription_id IN (SELECT id FROM premium_subscriptions WHERE user_id = $1)', params: (id)=>[id] },
  { sql: 'DELETE FROM premium_subscriptions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM paid_orders WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM paid_subscriptions WHERE user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM role_audit_log WHERE target_user_id = $1 OR actor_user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM access_audit_log WHERE user_id = $1 OR admin_user_id = $1', params: (id)=>[id] },
  { sql: 'DELETE FROM daily_usage_history WHERE user_id = $1', params: (id)=>[id] },
];

async function deleteUserSessions(client, userId) {
  let spCreated = false;
  try {
    await client.query('SAVEPOINT sp_sess');
    spCreated = true;
  } catch {}
  if (spCreated) {
    try {
      const likeString = '%"user":' + userId + '}%';
      await client.query('DELETE FROM user_sessions WHERE sess::jsonb::text LIKE $1', [likeString]);
      try { await client.query('RELEASE SAVEPOINT sp_sess'); } catch {}
      return;
    } catch (e) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_sess'); } catch {}
    }
  } else {
    // No transaction – try direct deletes without savepoint
    try {
      const likeString = '%"user":' + userId + '}%';
      await client.query('DELETE FROM user_sessions WHERE sess::jsonb::text LIKE $1', [likeString]);
      return;
    } catch {}
  }
  // Fallback second form
  let sp2Created = false;
  try {
    await client.query('SAVEPOINT sp_sess2');
    sp2Created = true;
  } catch {}
  if (sp2Created) {
    try {
      await client.query('DELETE FROM user_sessions WHERE sess::text LIKE $1', ['%"user":' + userId + '}%']);
      try { await client.query('RELEASE SAVEPOINT sp_sess2'); } catch {}
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_sess2'); } catch {}
    }
  } else {
    try { await client.query('DELETE FROM user_sessions WHERE sess::text LIKE $1', ['%"user":' + userId + '}%']); } catch {}
  }
}

export async function deleteUserPermanently(targetUserId, opts = {}) {
  const client = opts.client || await pool.connect();
  const shouldRelease = !opts.client;
  const actorUserId = opts.actorUserId || null;
  const id = Number.parseInt(String(targetUserId), 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user ID.');

  // Fetch to validate existence and admin guard
  let userRow;
  try {
    const r = await client.query('SELECT id, email, status, access_expires_at, app_role FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new Error('User not found.');
    userRow = r.rows[0];
  } catch (e) {
    if (e.message === 'User not found.') throw e;
    const r = await client.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new Error('User not found.');
    userRow = r.rows[0];
  }
  if (isOwnerUser(userRow) || isAdminUser(userRow)) {
    throw new Error('Cannot delete OWNER or ADMIN accounts.');
  }

  const isOuterTx = !!opts.client;
  if (!isOuterTx) await client.query('BEGIN');
  try {
    for (const entry of USER_TABLE_DELETES) {
      await safeDelete(client, entry.sql, entry.params(id));
    }
    await deleteUserSessions(client, id);
    // Finally delete users row
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    // Audit log (best effort)
    try {
      await logLifecycleEvent(client, {
        userId: null,
        adminUserId: actorUserId,
        action: 'delete',
        previousStatus: userRow.status || null,
        newStatus: 'deleted',
        previousExpiresAt: userRow.access_expires_at || null,
        newExpiresAt: null,
        targetEmail: userRow.email || null,
        details: actorUserId ? `User ${userRow.email || id} permanently deleted by admin ${actorUserId}` : `Inactive user ${userRow.email || id} automatically deleted`
      });
    } catch {}
    if (!isOuterTx) await client.query('COMMIT');
    return { deleted: true, user: userRow };
  } catch (e) {
    if (!isOuterTx) try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    if (shouldRelease && client.release) client.release();
  }
}
