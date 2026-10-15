import { pool } from '../db/pool.js';

// IST formatting helpers — consistent with Admin Users page (Asia/Kolkata).
export function formatIST(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString(undefined, { timeZone: 'Asia/Kolkata' });
}

export function formatISTDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
}

// Count folders + items from the already-loaded (cached) library tree.
// No DB access, no extra filesystem scan — walks the in-memory tree once.
export function countLibraryTree(tree) {
  let totalFolders = 0;
  let totalItems = 0;
  function walk(node, isRoot = false) {
    if (!node) return;
    if (node.type === 'folder') {
      if (!isRoot) totalFolders += 1;
      if (node.children) {
        for (const child of node.children.values()) walk(child, false);
      }
      return;
    }
    // Any non-folder leaf (file, video, pdf, document, ...) is one library item.
    totalItems += 1;
  }
  walk(tree, true);
  return { totalFolders, totalItems };
}

// --- User overview ---
// Single aggregate query. Active includes permanent Owner/Admin accounts
// ("Never expires") even though their access_expires_at is NULL; expired
// explicitly excludes Owner/Admin so NULL-expiry admins are never counted
// as expired. New users use created_at (existing users-data column).
async function userOverviewWithRole() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (
        WHERE app_role IN ('OWNER','ADMIN')
           OR (status = 'active' AND access_expires_at > NOW())
      )::int AS active_users,
      COUNT(*) FILTER (
        WHERE status = 'active'
          AND (access_expires_at IS NULL OR access_expires_at <= NOW())
          AND (app_role IS NULL OR app_role NOT IN ('OWNER','ADMIN'))
      )::int AS expired_users,
      COUNT(*) FILTER (WHERE app_role IN ('OWNER','ADMIN'))::int AS never_expires_users,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d_users
    FROM users
  `);
  return result.rows[0];
}

async function userOverviewFallback() {
  // Pre-011 schema without app_role: permanent admins are active rows with
  // NULL expiry. Pending/revoked are never counted as active or expired.
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (
        WHERE status = 'active' AND (access_expires_at > NOW() OR access_expires_at IS NULL)
      )::int AS active_users,
      COUNT(*) FILTER (
        WHERE status = 'active' AND access_expires_at IS NOT NULL AND access_expires_at <= NOW()
      )::int AS expired_users,
      COUNT(*) FILTER (
        WHERE status = 'active' AND access_expires_at IS NULL
      )::int AS never_expires_users,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d_users
    FROM users
  `);
  return result.rows[0];
}

export async function getUserOverview() {
  try {
    return await userOverviewWithRole();
  } catch {
    return await userOverviewFallback();
  }
}

// --- Discussion overview ---
// Single aggregate query over the existing discussion schema.
// Answered = question has >= 1 visible reply (matches listDiscussions logic).
// Accepted answers counts reply rows with accepted_at set (multiple accepted
// answers per question supported) restricted to visible replies.
export async function getDiscussionOverview() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_questions,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM discussion_replies r
          WHERE r.discussion_id = d.id AND r.status = 'visible'
        )
      )::int AS answered_questions,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM discussion_replies r
          WHERE r.discussion_id = d.id AND r.status = 'visible'
        )
      )::int AS unanswered_questions,
      (SELECT COUNT(*)::int FROM discussion_replies WHERE status = 'visible') AS total_replies,
      (SELECT COUNT(*)::int FROM discussion_replies WHERE accepted_at IS NOT NULL AND status = 'visible') AS accepted_answers,
      COUNT(*) FILTER (WHERE d.created_at >= NOW() - INTERVAL '30 days')::int AS new_30d_questions
    FROM discussions d
    WHERE d.status != 'deleted'
  `);
  return result.rows[0];
}

// --- Most liked content (existing item_likes table) ---
export async function getTopLiked(limit = 10) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const result = await pool.query(
    `SELECT item_path, COUNT(*)::int AS like_count, MAX(created_at) AS last_liked_at
     FROM item_likes
     GROUP BY item_path
     ORDER BY like_count DESC, last_liked_at DESC
     LIMIT $1`,
    [capped]
  );
  return result.rows;
}

// --- Most viewed content (existing recently_viewed table) ---
// recently_viewed holds one row per (user, item_path), so COUNT(*) is the
// number of distinct users who viewed the item — the best available
// "most viewed" signal without a new tracking table.
export async function getTopViewed(limit = 10) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const result = await pool.query(
    `SELECT item_path, COUNT(*)::int AS viewer_count, MAX(last_viewed_at) AS last_viewed_at
     FROM recently_viewed
     GROUP BY item_path
     ORDER BY viewer_count DESC, last_viewed_at DESC
     LIMIT $1`,
    [capped]
  );
  return result.rows;
}

// --- Recent activity (compact, no sensitive columns) ---
// Only id/name/email/timestamps are selected; no secrets.
export async function getRecentLogins(limit = 8) {
  const capped = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const result = await pool.query(
    `SELECT id, name, email, last_login_at
     FROM users
     ORDER BY last_login_at DESC NULLS LAST
     LIMIT $1`,
    [capped]
  );
  return result.rows;
}

export async function getRecentQuestions(limit = 8) {
  const capped = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const result = await pool.query(
    `SELECT d.id, d.title, d.item_path, d.created_at, u.name AS author_name
     FROM discussions d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'visible'
     ORDER BY d.created_at DESC
     LIMIT $1`,
    [capped]
  );
  return result.rows;
}

export async function getRecentViews(limit = 8) {
  const capped = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const result = await pool.query(
    `SELECT r.item_path, r.last_viewed_at, u.name AS viewer_name
     FROM recently_viewed r
     JOIN users u ON u.id = r.user_id
     ORDER BY r.last_viewed_at DESC
     LIMIT $1`,
    [capped]
  );
  return result.rows;
}

// Aggregate entry point: 7 efficient queries, no N+1.
export async function getAnalyticsOverview(tree = null) {
  let library = { totalItems: 0, totalFolders: 0 };
  if (tree) {
    try {
      const { totalItems, totalFolders } = countLibraryTree(tree);
      library = { totalItems, totalFolders };
    } catch {
      library = { totalItems: 0, totalFolders: 0 };
    }
  }
  const [
    users,
    discussions,
    topLiked,
    topViewed,
    recentLogins,
    recentQuestions,
    recentViews
  ] = await Promise.all([
    getUserOverview().catch(() => ({
      total_users: 0, active_users: 0, expired_users: 0, never_expires_users: 0, new_30d_users: 0
    })),
    getDiscussionOverview().catch(() => ({
      total_questions: 0, answered_questions: 0, unanswered_questions: 0,
      total_replies: 0, accepted_answers: 0, new_30d_questions: 0
    })),
    getTopLiked(10).catch(() => []),
    getTopViewed(10).catch(() => []),
    getRecentLogins(8).catch(() => []),
    getRecentQuestions(8).catch(() => []),
    getRecentViews(8).catch(() => [])
  ]);
  return { library, users, discussions, topLiked, topViewed, recentLogins, recentQuestions, recentViews };
}
