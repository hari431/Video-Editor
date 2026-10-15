import { pool } from '../db/pool.js';
import { hasNotesPermission } from '../auth/content-permissions.js';
import { getReqId as getReqIdFolder } from '../utils/perf.js';

const perfDiagnosticsEnabledFolder = String(process.env.PERF_DIAGNOSTICS || 'false').toLowerCase() === 'true';

/**
 * Returns all distinct item paths viewed by the user from existing activity / view tables.
 * Does not introduce any new completion or tracking system.
 *
 * @param {number|string} userId
 * @param {object} [dbClient=pool]
 * @returns {Promise<Set<string>>}
 */
export async function getUserViewedItemPaths(userId, dbClient = pool) {
  if (!userId) return new Set();
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return new Set();

  const viewed = new Set();
  const tTotal = perfDiagnosticsEnabledFolder ? Date.now() : 0;
  let tUnion = 0, tContentSeen = 0, tRecentlyViewed = 0, tVideoViews = 0, tQueryUsage = 0;
  let usedFallback = false;
  try {
    const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
    const res = await dbClient.query(
      `SELECT DISTINCT item_path FROM (
        SELECT item_path FROM content_seen WHERE user_id = $1 AND status = 'seen'
        UNION
        SELECT item_path FROM recently_viewed WHERE user_id = $1
        UNION
        SELECT video_path AS item_path FROM video_views WHERE user_id = $1
        UNION
        SELECT query_path AS item_path FROM query_usage WHERE user_id = $1 AND action = 'view'
      ) sub WHERE item_path IS NOT NULL`,
      [uid]
    );
    if (perfDiagnosticsEnabledFolder) tUnion = Date.now() - t0;
    for (const row of res.rows) {
      if (row.item_path) {
        viewed.add(row.item_path);
      }
    }
  } catch {
    usedFallback = true;
    // If the union query fails due to missing table or test mock, query individually with graceful fallbacks
    try {
      const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
      const cs = await dbClient.query(`SELECT item_path FROM content_seen WHERE user_id = $1 AND status = 'seen'`, [uid]);
      if (perfDiagnosticsEnabledFolder) tContentSeen = Date.now() - t0;
      for (const r of (cs.rows || [])) if (r.item_path) viewed.add(r.item_path);
    } catch { if (perfDiagnosticsEnabledFolder) tContentSeen = 0; }
    try {
      const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
      const rv = await dbClient.query(`SELECT item_path FROM recently_viewed WHERE user_id = $1`, [uid]);
      if (perfDiagnosticsEnabledFolder) tRecentlyViewed = Date.now() - t0;
      for (const r of (rv.rows || [])) if (r.item_path) viewed.add(r.item_path);
    } catch { if (perfDiagnosticsEnabledFolder) tRecentlyViewed = 0; }
    try {
      const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
      const vv = await dbClient.query(`SELECT video_path AS item_path FROM video_views WHERE user_id = $1`, [uid]);
      if (perfDiagnosticsEnabledFolder) tVideoViews = Date.now() - t0;
      for (const r of (vv.rows || [])) if (r.item_path) viewed.add(r.item_path);
    } catch { if (perfDiagnosticsEnabledFolder) tVideoViews = 0; }
    try {
      const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
      const qu = await dbClient.query(`SELECT query_path AS item_path FROM query_usage WHERE user_id = $1 AND action = 'view'`, [uid]);
      if (perfDiagnosticsEnabledFolder) tQueryUsage = Date.now() - t0;
      for (const r of (qu.rows || [])) if (r.item_path) viewed.add(r.item_path);
    } catch { if (perfDiagnosticsEnabledFolder) tQueryUsage = 0; }
  }
  if (perfDiagnosticsEnabledFolder) {
    const total = Date.now() - tTotal;
    const reqId = getReqIdFolder();
    if (usedFallback) {
      console.log(`PERF viewedPaths reqId=${reqId} total=${total}ms unionQuery=0ms contentSeen=${tContentSeen}ms recentlyViewed=${tRecentlyViewed}ms videoViews=${tVideoViews}ms queryUsage=${tQueryUsage}ms`);
    } else {
      console.log(`PERF viewedPaths reqId=${reqId} total=${total}ms unionQuery=${tUnion}ms`);
    }
  }

  return viewed;
}

/**
 * Collects all leaf content item paths within a folder node in the filtered tree.
 * Respects access control because the tree has already been filtered for the user.
 *
 * @param {object} folderNode
 * @returns {string[]}
 */
export function getFolderLeafItemPaths(folderNode) {
  const itemPaths = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'folder') {
      if (node.children) {
        for (const child of node.children.values()) {
          walk(child);
        }
      }
    } else {
      if (node.path) {
        itemPaths.push(node.path);
      }
    }
  }
  walk(folderNode);
  return itemPaths;
}

/**
 * Calculates progress indicators for all folder nodes in a filtered tree.
 *
 * @param {object} tree - Tree filtered for the current user (respecting access control)
 * @param {Set<string>} [viewedPathsSet=new Set()] - Set of item paths viewed by the user
 * @returns {Record<string, { total: number, viewed: number, percent: number, text: string, percentText: string, label: string }>}
 */
export function calculateFolderProgressMap(tree, viewedPathsSet = new Set()) {
  const progressMap = {};

  function traverse(node) {
    if (!node) return;
    if (node.type === 'folder') {
      const leafPaths = getFolderLeafItemPaths(node);
      const total = leafPaths.length;
      let viewed = 0;
      for (const lp of leafPaths) {
        if (viewedPathsSet.has(lp)) {
          viewed++;
        }
      }
      const percent = total > 0 ? Math.round((viewed / total) * 100) : 0;
      const key = node.path || '';
      progressMap[key] = {
        total,
        viewed,
        percent,
        text: `${viewed} of ${total} items viewed`,
        percentText: `${percent}%`,
        label: `${viewed} of ${total} items viewed (${percent}%)`
      };

      if (node.children) {
        for (const child of node.children.values()) {
          traverse(child);
        }
      }
    }
  }

  traverse(tree);
  return progressMap;
}

/**
 * Retrieves folder progress indicators for the given user and filtered library tree.
 * Progress is only calculated and shown if the user has Notes roles/permissions.
 *
 * @param {object} user
 * @param {object} filteredTree
 * @param {object} [dbClient=pool]
 * @returns {Promise<{ enabled: boolean, progressMap: Record<string, { total: number, viewed: number, percent: number, text: string, percentText: string, label: string }> }>}
 */
export async function getFolderProgressForUser(user, filteredTree, dbClient = pool, cachedHasNotes) {
  const tTotal = perfDiagnosticsEnabledFolder ? Date.now() : 0;
  let tHasNotes = 0, tViewedPaths = 0, tCalculation = 0;
  if (!user) {
    if (perfDiagnosticsEnabledFolder) {
      const reqId = getReqIdFolder();
      console.log(`PERF folderProgress reqId=${reqId} total=${Date.now() - tTotal}ms hasNotes=0ms viewedPaths=0ms calculation=0ms`);
    }
    return { enabled: false, progressMap: {} };
  }

  let hasNotes;
  if (typeof cachedHasNotes === 'boolean') {
    hasNotes = cachedHasNotes;
  } else if (cachedHasNotes && typeof cachedHasNotes.then === 'function') {
    const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
    try { hasNotes = await cachedHasNotes; } catch { hasNotes = false; }
    if (perfDiagnosticsEnabledFolder) tHasNotes = Date.now() - t0;
  } else {
    const t0 = perfDiagnosticsEnabledFolder ? Date.now() : 0;
    hasNotes = await hasNotesPermission(user, dbClient);
    if (perfDiagnosticsEnabledFolder) tHasNotes = Date.now() - t0;
  }
  if (!hasNotes) {
    if (perfDiagnosticsEnabledFolder) {
      const reqId = getReqIdFolder();
      console.log(`PERF folderProgress reqId=${reqId} total=${Date.now() - tTotal}ms hasNotes=${tHasNotes}ms viewedPaths=0ms calculation=0ms`);
    }
    return { enabled: false, progressMap: {} };
  }

  const tViewed = perfDiagnosticsEnabledFolder ? Date.now() : 0;
  const viewedPaths = await getUserViewedItemPaths(user.id, dbClient);
  if (perfDiagnosticsEnabledFolder) tViewedPaths = Date.now() - tViewed;

  const tCalc = perfDiagnosticsEnabledFolder ? Date.now() : 0;
  const progressMap = calculateFolderProgressMap(filteredTree, viewedPaths);
  if (perfDiagnosticsEnabledFolder) tCalculation = Date.now() - tCalc;

  if (perfDiagnosticsEnabledFolder) {
    const total = Date.now() - tTotal;
    const reqId = getReqIdFolder();
    console.log(`PERF folderProgress reqId=${reqId} total=${total}ms hasNotes=${tHasNotes}ms viewedPaths=${tViewedPaths}ms calculation=${tCalculation}ms`);
  }

  return { enabled: true, progressMap };
}
