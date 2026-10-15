// src/cleanup/inactiveUsers.js — automatic deletion of inactive non-active users
// Batch-safe, idempotent, respects USER_INACTIVE_DELETE_DAYS env (no hardcoded fallback)
import { pool } from '../db/pool.js';
import { getInactiveDeleteDays } from '../config/inactiveDeletion.js';
import { deleteUserPermanently } from '../auth/userDeletion.js';

function cutoffForDays(days) {
  if (!Number.isInteger(days) || days <= 0) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Find users inactive for configured days AND status != 'active' (so pending/expired/revoked etc.)
// Excludes OWNER/ADMIN (app_role) and ADMIN_EMAILS, and supports batch pagination.
export async function findInactiveUsersForDeletion(client, days, limit = 500) {
  const cutoff = cutoffForDays(days);
  if (!cutoff) return [];
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  let adminClause = '';
  const params = [cutoff, limit];
  if (adminEmails.length > 0) {
    adminClause = ` AND LOWER(email) NOT IN (${adminEmails.map((_,i)=>`$${3+i}`).join(', ')})`;
    params.push(...adminEmails);
  }
  // Authoritative activity signal: last_activity_at only (throttled 24h, updated on login + activity)
  const res = await client.query(
    `SELECT id, email, status, last_activity_at, app_role FROM users
     WHERE last_activity_at IS NOT NULL AND last_activity_at < $1
        AND status != 'active'
        AND COALESCE(app_role,'USER') NOT IN ('OWNER','ADMIN')${adminClause}
      ORDER BY last_activity_at ASC
      LIMIT $2`,
    params
  );
  return res.rows;
}

export async function runInactiveUserCleanup({ client = pool, dryRun = null, batchSize = 100, days = null } = {}) {
  const effectiveDays = days !== null && days !== undefined ? days : getInactiveDeleteDays();
  if (!Number.isInteger(effectiveDays) || effectiveDays <= 0) {
    console.warn('[inactive-deletion] Skipped: USER_INACTIVE_DELETE_DAYS missing/invalid — no users deleted.');
    return { skipped: true, reason: 'invalid_or_missing_days', processed: 0, deleted: 0, skippedCount: 0, failed: 0, dryRun: !!dryRun };
  }
  const effectiveDryRun = dryRun !== null && dryRun !== undefined ? !!dryRun : false;
  const cutoff = cutoffForDays(effectiveDays);
  console.log(`[inactive-deletion] Starting cleanup: days=${effectiveDays} cutoff=${cutoff.toISOString()} dryRun=${effectiveDryRun} batchSize=${batchSize}`);

  let processed = 0, deleted = 0, skipped = 0, failed = 0;
  const failedIds = [];
  let shouldRelease = false;
  let localClient = null;
  const useClient = client || (localClient = await pool.connect(), shouldRelease = true, localClient);

  try {
    // Idempotent loop: fetch batch, delete, repeat until no more
    while (true) {
      const batch = await findInactiveUsersForDeletion(useClient, effectiveDays, batchSize);
      if (!batch || batch.length === 0) break;
      for (const u of batch) {
        processed++;
        // Double-check status not active (race condition if user became active after fetch)
        if (u.status === 'active') {
          skipped++;
          console.log(`[inactive-deletion] Skipped user ${u.id} (${u.email}) status=active`);
          continue;
        }
        // Extra guard: skip OWNER/ADMIN again
        if (u.app_role === 'OWNER' || u.app_role === 'ADMIN') {
          skipped++;
          console.log(`[inactive-deletion] Skipped admin/owner user ${u.id}`);
          continue;
        }
        if (effectiveDryRun) {
          console.log(`[inactive-deletion] Dry-run would delete user ${u.id} (${u.email}) status=${u.status} last_activity=${u.last_activity_at}`);
          // Count as processed but not deleted in dryRun? For reporting, treat as would-be deleted
          deleted++;
          continue;
        }
        try {
          // Per-user atomic transaction – do not reuse batch client, each deletion owns its transaction
          await deleteUserPermanently(u.id, { actorUserId: null });
          deleted++;
          console.log(`[inactive-deletion] Deleted user ${u.id} (${u.email})`);
        } catch (e) {
          failed++;
          failedIds.push({ id: u.id, error: e.message });
          console.error(`[inactive-deletion] Failed to delete user ${u.id}: ${e.message}`);
          // Continue to next user (per-user transaction already rolled back)
        }
      }
      // If batch was smaller than limit, we're done
      if (batch.length < batchSize) break;
    }
  } finally {
    if (shouldRelease && localClient) localClient.release();
  }

  const summary = { processed, deleted: effectiveDryRun ? 0 : deleted, wouldDelete: effectiveDryRun ? deleted : 0, skipped, failed, failedIds, dryRun: effectiveDryRun, days: effectiveDays, cutoff: cutoff.toISOString() };
  // For dryRun, deleted should be 0 but we log wouldDelete
  if (effectiveDryRun) {
    summary.deleted = 0;
  }
  console.log(`[inactive-deletion] Summary ${JSON.stringify(summary)}`);
  // Normalize for callers: always have deleted count (actual deletes)
  return { processed, deleted: summary.deleted, wouldDelete: summary.wouldDelete || 0, skipped, failed, failedIds, dryRun: effectiveDryRun, days: effectiveDays, cutoff: cutoff.toISOString() };
}

export { cutoffForDays };
