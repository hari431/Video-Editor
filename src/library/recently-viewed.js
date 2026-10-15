import { pool } from '../db/pool.js';

const MAX_HISTORY = 20;

/**
 * Record a recently viewed item for a user.
 * - Upserts (user_id, item_path) with current timestamp.
 * - Enforces max history of 20 per user by deleting oldest entries.
 * - No-op if userId or itemPath is missing/invalid.
 */
export async function recordRecentlyViewed(userId, itemPath) {
  if (!userId || !itemPath || typeof itemPath !== 'string' || !itemPath.trim()) return;
  const pathValue = itemPath.trim();
  // Upsert: update timestamp if exists, insert otherwise
  await pool.query(
    `INSERT INTO recently_viewed (user_id, item_path, last_viewed_at, created_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (user_id, item_path) DO UPDATE SET last_viewed_at = NOW()`,
    [userId, pathValue]
  );
  // Enforce max history: keep only 20 most recent per user
  await pool.query(
    `DELETE FROM recently_viewed
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM recently_viewed
         WHERE user_id = $1
         ORDER BY last_viewed_at DESC
         LIMIT $2
       )`,
    [userId, MAX_HISTORY]
  );
}

/**
 * Get recently viewed items for a user, ordered by most recent first.
 * Returns array of { item_path, last_viewed_at, ... }
 */
export async function getRecentlyViewed(userId, limit = MAX_HISTORY) {
  if (!userId) return [];
  const capped = Math.min(Math.max(Number(limit) || MAX_HISTORY, 1), MAX_HISTORY);
  const result = await pool.query(
    `SELECT item_path, last_viewed_at, created_at
     FROM recently_viewed
     WHERE user_id = $1
     ORDER BY last_viewed_at DESC
     LIMIT $2`,
    [userId, capped]
  );
  return result.rows;
}

export { MAX_HISTORY };
