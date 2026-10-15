import { readFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import {
  isSafeLibraryPath,
  resolveLibraryPath,
  canAccessLibraryPath,
  contentRouteForPath,
  getTypeDisplayName,
  getCachedPermission,
  loadFolderPermissions
} from './local.js';
import { getFileTypeFromFilename } from './file-types.js';
import { findVideo, findFile } from './tree.js';
import { isAdminUser } from '../auth/admin.js';

export const MAX_NEW_ITEMS = 20;
export const FRESHNESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, '..', 'config', 'content-manifest.json');

let cachedManifest = null;

export function loadContentManifest(manifestPath = MANIFEST_PATH) {
  if (cachedManifest && manifestPath === MANIFEST_PATH) return cachedManifest;
  try {
    if (existsSync(manifestPath)) {
      const raw = readFileSync(manifestPath, 'utf8');
      cachedManifest = JSON.parse(raw);
      return cachedManifest;
    }
  } catch (err) {
    console.warn('[new-content] Failed to load content manifest:', err.message);
  }
  return {};
}

export function resetManifestCache() {
  cachedManifest = null;
}

function categoryForNewContent(filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Uncategorized';
}

function encodeNewContentPath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

function resolveBaseline(user) {
  const raw = user?.first_login_at ?? user?.created_at ?? null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function collectLeafPaths(tree) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'folder') {
      if (node.children) for (const child of node.children.values()) walk(child);
      return;
    }
    // Any non-folder leaf is individual content (file/video/pdf/...)
    if (typeof node.path === 'string' && node.path) out.push(node.path);
  }
  walk(tree);
  return out;
}

/**
 * Persistently mark a content item as seen by a user.
 * Only called on actual content access (query/watch/item pages).
 * Idempotent for already-seen rows: the conditional upsert keeps the first
 * seen_at. A row previously 'ignored' is upgraded to 'seen' here because the
 * user did actually open the content afterwards.
 */
export async function markContentSeen(userId, itemPath) {
  if (!userId || !itemPath || typeof itemPath !== 'string' || !itemPath.trim()) return;
  const pathValue = itemPath.trim();
  await pool.query(
    `INSERT INTO content_seen (user_id, item_path, seen_at, created_at, status)
     VALUES ($1, $2, NOW(), NOW(), 'seen')
     ON CONFLICT (user_id, item_path) DO UPDATE
       SET status = 'seen', seen_at = NOW()
       WHERE content_seen.status <> 'seen'`,
    [userId, pathValue]
  );
}

/**
 * Mark a content item as ignored/dismissed by a user without viewing it.
 * Only called from the authenticated Ignore action. Never touches
 * recently_viewed and never records a view. Idempotent and never overwrites
 * a 'seen' row: an item the user actually opened stays 'seen'.
 */
export async function markContentIgnored(userId, itemPath) {
  if (!userId || !itemPath || typeof itemPath !== 'string' || !itemPath.trim()) return;
  const pathValue = itemPath.trim();
  await pool.query(
    `INSERT INTO content_seen (user_id, item_path, seen_at, created_at, status)
     VALUES ($1, $2, NOW(), NOW(), 'ignored')
     ON CONFLICT (user_id, item_path) DO NOTHING`,
    [userId, pathValue]
  );
}

/**
 * Batch-ignore multiple content items for a user in a single DB round-trip.
 * Used by Ignore All. Reuses the same 'ignored' semantics as markContentIgnored:
 * never overwrites a 'seen' row, never touches recently_viewed, idempotent,
 * and safe to retry. No-op for empty input.
 * Avoids N+1 inserts by issuing one INSERT with many VALUES.
 */
export async function markContentsIgnored(userId, itemPaths, db = pool) {
  if (!userId || !Array.isArray(itemPaths) || itemPaths.length === 0) return;
  const cleaned = [];
  const seen = new Set();
  for (const raw of itemPaths) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    cleaned.push(p);
  }
  if (cleaned.length === 0) return;

  const BATCH_SIZE = 100;
  const runBatches = async (queryDb) => {
    for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
      const batch = cleaned.slice(i, i + BATCH_SIZE);
      const valuesClauses = [];
      const params = [];
      let idx = 1;
      for (const p of batch) {
        valuesClauses.push(`($${idx}, $${idx + 1}, NOW(), NOW(), 'ignored')`);
        params.push(userId, p);
        idx += 2;
      }
      const sql = `INSERT INTO content_seen (user_id, item_path, seen_at, created_at, status) VALUES ${valuesClauses.join(', ')} ON CONFLICT (user_id, item_path) DO NOTHING`;
      await queryDb.query(sql, params);
    }
  };

  if (db === pool && cleaned.length > BATCH_SIZE) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await runBatches(client);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } else {
    await runBatches(db);
  }
}

/**
 * Return the set of item_paths the user has dismissed from New Content,
 * regardless of state ('seen' or 'ignored'). Used for eligibility: both
 * states exclude the item from New / Missed Content.
 */
export async function getSeenPaths(userId) {
  if (!userId) return new Set();
  const result = await pool.query(
    `SELECT item_path FROM content_seen WHERE user_id = $1`,
    [userId]
  );
  return new Set((result.rows || []).map(r => r.item_path));
}

/**
 * Return per-item acknowledgement state for a user: Map of
 * item_path -> 'seen' | 'ignored'. Rows pre-dating the status column (or
 * with any unexpected value) report as 'seen' to preserve the established
 * meaning of existing rows.
 */
export async function getContentStates(userId) {
  if (!userId) return new Map();
  const result = await pool.query(
    `SELECT item_path, status FROM content_seen WHERE user_id = $1`,
    [userId]
  );
  const states = new Map();
  for (const row of result.rows || []) {
    states.set(row.item_path, row.status === 'ignored' ? 'ignored' : 'seen');
  }
  return states;
}

/**
 * Loads role assignment timestamps for a user (role_id -> Date).
 */
export async function getUserRoleGrantTimestamps(userId, db = pool) {
  if (!userId) return new Map();
  const map = new Map();
  try {
    const res = await db.query(
      `SELECT role_id, created_at FROM user_roles WHERE user_id = $1`,
      [userId]
    );
    for (const r of res.rows || []) {
      if (r.role_id != null && r.created_at) {
        const d = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
        if (!Number.isNaN(d.getTime())) {
          map.set(Number(r.role_id), d);
        }
      }
    }
  } catch {
    // If table doesn't exist or query fails in test mock
  }
  return map;
}

/**
 * Compute unseen new/missed content for a user with reliable timestamps.
 *
 * Primary timestamp source for Git-tracked files: build-time Git content manifest (commit timestamp).
 * In development or mock test harnesses where an item is not in the manifest, fallback to opts.statFn/stat
 * (or mock timestamps) ONLY when explicit mock stat / test environment is active, NEVER relying on
 * checkout/deployment mtime for tracked content in production.
 *
 * Newly Available Detection:
 * If an item is under a folder restricted to specific role(s) (access_level = 'role'),
 * and the user was granted one of the granting roles within the 14-day freshness window,
 * the content is treated as newly available (using the role grant timestamp) even if the Git commit is older.
 *
 * Eligibility:
 * 1. RBAC allowed (canAccess(user, itemPath) === true)
 * 2. Effective timestamp > baseline (user.first_login_at / created_at)
 * 3. Effective timestamp >= (now - 14 days)
 * 4. Item path NOT in content_seen for this user.
 *
 * @param {object} user - req.user (uses .id and .first_login_at)
 * @param {object} tree - library tree from getLibrary()
 * @param {object} opts - optional overrides { seenPaths:Set, canAccess, statFn, manifest:Object, userRoleGrants:Map, now:Date }
 */
export async function getNewContentForUser(user, tree, opts = {}) {
  try {
    if (!user || !user.id) return [];
    if (!tree) return [];
    const baseline = resolveBaseline(user);
    if (!baseline) return [];

    let seen;
    if (opts.seenPaths instanceof Set) {
      seen = opts.seenPaths;
    } else {
      try {
        seen = await getSeenPaths(user.id);
      } catch {
        return [];
      }
    }

    const canAccess = opts.canAccess || canAccessLibraryPath;
    const manifest = opts.manifest || loadContentManifest();
    const nowTime = opts.now ? (opts.now instanceof Date ? opts.now.getTime() : new Date(opts.now).getTime()) : Date.now();
    const freshnessThreshold = nowTime - FRESHNESS_WINDOW_MS;

    // Load role assignment timestamps for "newly available" role access detection
    let roleGrantMap = opts.userRoleGrants;
    if (!roleGrantMap) {
      roleGrantMap = await getUserRoleGrantTimestamps(user.id);
    }

    try {
      await loadFolderPermissions();
    } catch {}

    const leafPaths = collectLeafPaths(tree);
    const items = [];
    for (const itemPath of leafPaths) {
      if (!isSafeLibraryPath(itemPath)) continue;
      let allowed = false;
      try {
        allowed = canAccess(user, itemPath);
      } catch {
        allowed = false;
      }
      if (!allowed) continue;
      if (seen.has(itemPath)) continue; // already seen or ignored

      const base = itemPath.split('/').at(-1) || itemPath;
      const typeInfo = getFileTypeFromFilename(base);
      if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) continue;

      // 1. Determine Git timestamp from manifest
      let gitTime = null;
      if (manifest && manifest[itemPath] !== undefined) {
        const rawTime = manifest[itemPath];
        const t = typeof rawTime === 'number' ? rawTime : new Date(rawTime).getTime();
        if (Number.isFinite(t)) {
          gitTime = new Date(t);
        }
      }

      // 2. Fallback for test harness / mocks if provided in opts or during test environment
      if (!gitTime && (opts.statFn || opts.allowStatFallback || process.env.NODE_ENV === 'test')) {
        try {
          const absPath = resolveLibraryPath(itemPath);
          if (absPath) {
            const statFn = opts.statFn || stat;
            if (typeof statFn === 'function') {
              const stats = await statFn(absPath);
              if (stats && (typeof stats.isFile !== 'function' || stats.isFile())) {
                const mt = stats.mtime instanceof Date ? stats.mtime : new Date(stats.mtime);
                if (mt && !Number.isNaN(mt.getTime())) {
                  gitTime = mt;
                }
              }
            }
          }
        } catch {}
      }

      // 3. Determine newly available role grant timestamp
      let roleGrantTime = null;
      if (!isAdminUser(user)) {
        const permEntry = getCachedPermission(itemPath);
        if (permEntry && permEntry.accessLevel === 'role' && Array.isArray(permEntry.roleIds)) {
          // Find if user has access through one of these roleIds and check grant time
          for (const rid of permEntry.roleIds) {
            if (roleGrantMap.has(rid)) {
              const grantDate = roleGrantMap.get(rid);
              if (grantDate && (!roleGrantTime || grantDate.getTime() > roleGrantTime.getTime())) {
                roleGrantTime = grantDate;
              }
            }
          }
        }
      }

      // 4. Resolve effective addedAt timestamp (the newest between gitTime and roleGrantTime)
      let effectiveTime = null;
      if (gitTime && roleGrantTime) {
        effectiveTime = gitTime.getTime() > roleGrantTime.getTime() ? gitTime : roleGrantTime;
      } else if (gitTime) {
        effectiveTime = gitTime;
      } else if (roleGrantTime) {
        effectiveTime = roleGrantTime;
      }

      if (!effectiveTime) continue; // No valid timestamp source
      const effectiveMs = effectiveTime.getTime();

      // Check freshness window (within 14 days)
      if (effectiveMs < freshnessThreshold) continue;

      // Check baseline (must be added / granted after user registration/first login)
      if (!(effectiveTime > baseline)) continue;

      // Route reuse: mirror recently-viewed href logic.
      let kind = typeInfo.type;
      let href;
      if (findVideo(tree, itemPath)) {
        kind = 'video';
        href = '/watch/' + encodeNewContentPath(itemPath);
      } else if (findFile(tree, itemPath)) {
        kind = 'text';
        href = '/query/' + encodeNewContentPath(itemPath);
      } else {
        const route = contentRouteForPath(itemPath);
        if (route === '/browse/') continue; // never show folders
        href = route + encodeNewContentPath(itemPath);
      }

      items.push({
        path: itemPath,
        name: base,
        title: base.replace(/\.[^.]+$/i, ''),
        typeLabel: kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : getTypeDisplayName(typeInfo.type),
        kind,
        href,
        category: categoryForNewContent(itemPath),
        addedAt: effectiveTime
      });
    }

    items.sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
    if (opts.limit === null || opts.unlimited || opts.limit === 0) {
      return items;
    }
    const limit = typeof opts.limit === 'number' ? opts.limit : MAX_NEW_ITEMS;
    return limit > 0 ? items.slice(0, limit) : items;
  } catch {
    return [];
  }
}

export { categoryForNewContent };
