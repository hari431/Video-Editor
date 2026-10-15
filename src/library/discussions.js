import { pool } from '../db/pool.js';

// --- Questions ---

export async function createDiscussion(userId, itemPath, title, body, initialStatus = 'pending') {
  const result = await pool.query(
    `INSERT INTO discussions (user_id, item_path, title, body, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id, item_path, title, body, status, created_at`,
    [userId, itemPath, title.trim(), body.trim(), initialStatus]
  );
  return result.rows[0];
}

export async function getDiscussion(id, currentUserId = null) {
  const result = await pool.query(
    `SELECT d.*, u.email AS author_email, u.name AS author_name,
            (SELECT COUNT(*)::int FROM discussion_likes WHERE discussion_id = d.id) AS like_count,
            (SELECT EXISTS (SELECT 1 FROM discussion_likes WHERE discussion_id = d.id AND user_id = $2)) AS user_liked
     FROM discussions d
     JOIN users u ON d.user_id = u.id
     WHERE d.id = $1`,
    [id, currentUserId]
  );
  return result.rows[0] || null;
}

export async function getDiscussionReplies(discussionId, includeHidden = false, currentUserId = null) {
  let statusFilter = '';
  const params = [discussionId, currentUserId];
  if (!includeHidden) {
    if (currentUserId) {
      statusFilter = `AND (r.status IN ('visible', 'approved') OR (r.status = 'pending' AND r.user_id = $2))`;
    } else {
      statusFilter = `AND r.status IN ('visible', 'approved')`;
    }
  }
  const result = await pool.query(
    `SELECT r.*, u.email AS author_email, u.name AS author_name, COALESCE(u.app_role, 'USER') AS author_app_role,
            (SELECT COUNT(*)::int FROM reply_likes WHERE reply_id = r.id) AS like_count,
            (SELECT EXISTS (SELECT 1 FROM reply_likes WHERE reply_id = r.id AND user_id = $2)) AS user_liked
     FROM discussion_replies r
     JOIN users u ON r.user_id = u.id
     WHERE r.discussion_id = $1 ${statusFilter}
     ORDER BY r.created_at ASC`,
    params
  );
  return result.rows;
}

export async function deleteDiscussionAsUser(id, userId) {
  // Soft delete: mark as deleted instead of physically removing
  return pool.query(
    `UPDATE discussions SET status = 'deleted', deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

export async function deleteReplyAsUser(id, userId) {
  // Soft delete: mark as deleted and clear accepted if needed
  const res = await pool.query(
    `UPDATE discussion_replies SET status = 'deleted', deleted_at = NOW(), deleted_by = $2, accepted_at = NULL, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return res;
}

// --- Accepted Answer (multiple) ---

export async function acceptReply(discussionId, replyId) {
  const replyCheck = await pool.query(
    `SELECT id, discussion_id, status, accepted_at FROM discussion_replies WHERE id = $1`,
    [replyId]
  );
  if (replyCheck.rowCount === 0) throw new Error('Reply not found.');
  const reply = replyCheck.rows[0];
  if (Number(reply.discussion_id) !== Number(discussionId)) throw new Error('Reply does not belong to this question.');
  if (reply.status !== 'visible' && reply.status !== 'approved') throw new Error('Only visible or approved replies can be accepted.');
  const discussionCheck = await pool.query(`SELECT id FROM discussions WHERE id = $1`, [discussionId]);
  if (discussionCheck.rowCount === 0) throw new Error('Discussion not found.');
  if (reply.accepted_at) return; // already accepted, idempotent
  await pool.query(`UPDATE discussion_replies SET accepted_at = NOW(), updated_at = NOW() WHERE id = $1`, [replyId]);
}

export async function unacceptReply(discussionId, replyId) {
  // New signature: unaccept specific reply; if replyId omitted, clear all for discussion (backwards compat)
  if (replyId) {
    await pool.query(`UPDATE discussion_replies SET accepted_at = NULL, updated_at = NOW() WHERE id = $1 AND discussion_id = $2`, [replyId, discussionId]);
  } else {
    await pool.query(`UPDATE discussion_replies SET accepted_at = NULL, updated_at = NOW() WHERE discussion_id = $1 AND accepted_at IS NOT NULL`, [discussionId]);
  }
}

// Deprecated single helper kept for compatibility but now returns first accepted or null
export async function getAcceptedReplyId(discussionId) {
  const r = await pool.query(`SELECT id FROM discussion_replies WHERE discussion_id = $1 AND accepted_at IS NOT NULL ORDER BY accepted_at ASC LIMIT 1`, [discussionId]);
  return r.rows[0]?.id || null;
}

export async function getAcceptedReplies(discussionId) {
  const r = await pool.query(`SELECT * FROM discussion_replies WHERE discussion_id = $1 AND accepted_at IS NOT NULL AND status = 'visible' ORDER BY accepted_at ASC`, [discussionId]);
  return r.rows;
}

// --- Moderation audit ---

export async function recordModerationAction(targetType, targetId, action, actorUserId) {
  // target_type: 'question' | 'reply', action: 'delete'|'restore'|'hide'|'unhide'
  return pool.query(
    `INSERT INTO discussion_moderation_actions (target_type, target_id, action, actor_user_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [targetType, targetId, action, actorUserId]
  );
}

export async function getLatestModerationForTargets(targetType, targetIds) {
  if (!targetIds || targetIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT DISTINCT ON (target_id) target_id, target_type, action, actor_user_id, created_at,
            u.email AS actor_email, u.name AS actor_name
     FROM discussion_moderation_actions
     LEFT JOIN users u ON u.id = actor_user_id
     WHERE target_type = $1 AND target_id = ANY($2::bigint[])
     ORDER BY target_id, created_at DESC`,
    [targetType, targetIds]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.target_id), row);
  }
  return map;
}

export async function getModerationHistory(targetType, targetId) {
  const result = await pool.query(
    `SELECT m.*, u.email AS actor_email, u.name AS actor_name
     FROM discussion_moderation_actions m
     LEFT JOIN users u ON u.id = m.actor_user_id
     WHERE m.target_type = $1 AND m.target_id = $2
     ORDER BY m.created_at ASC`,
    [targetType, targetId]
  );
  return result.rows;
}

// --- Admin moderation ---

export async function adminHideDiscussion(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussions SET status = 'hidden', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('question', id, 'hide', actorUserId).catch(() => {});
  }
  return;
}

export async function adminUnhideDiscussion(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussions SET status = 'visible', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('question', id, 'unhide', actorUserId).catch(() => {});
  }
  return;
}

export async function adminHideReply(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussion_replies SET status = 'hidden', accepted_at = NULL, updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('reply', id, 'hide', actorUserId).catch(() => {});
  }
  return;
}

export async function adminUnhideReply(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussion_replies SET status = 'visible', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('reply', id, 'unhide', actorUserId).catch(() => {});
  }
  return;
}

export async function adminDeleteDiscussion(id, adminUserId) {
  // Admin soft delete: mark as deleted with admin metadata
  await pool.query(
    `UPDATE discussions SET status = 'deleted', deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
     WHERE id = $1`,
    [id, adminUserId]
  );
  await recordModerationAction('question', id, 'delete', adminUserId).catch(() => {});
  return;
}

export async function adminDeleteReply(id, adminUserId) {
  await pool.query(
    `UPDATE discussion_replies SET status = 'deleted', deleted_at = NOW(), deleted_by = $2, accepted_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, adminUserId]
  );
  await recordModerationAction('reply', id, 'delete', adminUserId).catch(() => {});
  return;
}

export async function adminRestoreDiscussion(id, actorUserId) {
  await pool.query(
    `UPDATE discussions SET status = 'visible', deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  await recordModerationAction('question', id, 'restore', actorUserId).catch(() => {});
  return;
}

export async function adminRestoreReply(id, actorUserId) {
  await pool.query(
    `UPDATE discussion_replies SET status = 'visible', deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  await recordModerationAction('reply', id, 'restore', actorUserId).catch(() => {});
  return;
}

// --- Listing / search ---

const VALID_FILTERS = new Set(['all', 'unanswered', 'answered', 'most-replies', 'newest']);

export function isValidFilter(filter) {
  return VALID_FILTERS.has(filter);
}

const ADMIN_VALID_FILTERS = new Set([
  'all', 'unanswered', 'answered', 'most-replies', 'no-replies', 'hidden', 'deleted', 'newest', 'oldest-unanswered', 'pending', 'pending-replies'
]);

export function isValidAdminFilter(filter) {
  return ADMIN_VALID_FILTERS.has(filter);
}

export async function listDiscussions(itemPath, filter = 'newest', currentUserId = null) {
  let where;
  const params = [itemPath];
  if (currentUserId) {
    where = `WHERE (d.status IN ('visible', 'approved') OR (d.status = 'pending' AND d.user_id = $2)) AND d.item_path = $1`;
    params.push(currentUserId);
  } else {
    where = `WHERE d.status IN ('visible', 'approved') AND d.item_path = $1`;
  }

  const replyCountSql = currentUserId
    ? `COUNT(dr.id) FILTER (WHERE dr.status IN ('visible', 'approved') OR (dr.status = 'pending' AND dr.user_id = $2))`
    : `COUNT(dr.id) FILTER (WHERE dr.status IN ('visible', 'approved'))`;

  const acceptedCountSql = currentUserId
    ? `COUNT(dr.id) FILTER (WHERE dr.accepted_at IS NOT NULL AND (dr.status IN ('visible', 'approved') OR (dr.status = 'pending' AND dr.user_id = $2)))`
    : `COUNT(dr.id) FILTER (WHERE dr.accepted_at IS NOT NULL AND dr.status IN ('visible', 'approved'))`;

  let order;
  switch (filter) {
    case 'unanswered':
      order = `HAVING ${replyCountSql} = 0 ORDER BY d.created_at DESC`;
      break;
    case 'answered':
      order = `HAVING ${replyCountSql} > 0 ORDER BY d.created_at DESC`;
      break;
    case 'most-replies':
      order = `ORDER BY reply_count DESC, d.created_at DESC`;
      break;
    case 'newest':
    default:
      order = `ORDER BY d.created_at DESC`;
      break;
  }

  const sql = `
    SELECT d.id, d.user_id, d.item_path, d.title, d.body, d.status, d.created_at, d.updated_at,
           u.name AS author_name,
           ${replyCountSql} AS reply_count,
           ${acceptedCountSql} AS accepted_count
    FROM discussions d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN discussion_replies dr ON dr.discussion_id = d.id
    ${where}
    GROUP BY d.id, u.name
    ${order}
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

export async function listAllDiscussionsForAdmin(filter = 'all', searchTerm = '', limit = 50, offset = 0) {
  let having = '';
  let order = 'ORDER BY d.created_at DESC';
  let whereExtra = '';
  const params = [];

  if (searchTerm) {
    const searchPattern = `%${searchTerm}%`;
    whereExtra += ` AND (d.title ILIKE $${params.length + 1} OR d.body ILIKE $${params.length + 2} OR u.name ILIKE $${params.length + 3} OR u.email ILIKE $${params.length + 4} OR d.item_path ILIKE $${params.length + 5} OR CAST(d.id AS TEXT) ILIKE $${params.length + 6} OR d.status ILIKE $${params.length + 7})`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
  }

  switch (filter) {
    case 'unanswered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') = 0';
      break;
    case 'answered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') > 0';
      break;
    case 'no-replies':
      having = 'HAVING COUNT(dr.id) = 0';
      break;
    case 'most-replies':
      order = 'ORDER BY COUNT(dr.id) DESC, d.created_at DESC';
      break;
    case 'hidden':
      whereExtra += ' AND d.status = \'hidden\'';
      break;
    case 'deleted':
      whereExtra += ' AND d.status = \'deleted\'';
      break;
    case 'pending':
      whereExtra += ' AND d.status = \'pending\'';
      break;
    case 'pending-replies':
      whereExtra += ` AND EXISTS (SELECT 1 FROM discussion_replies dr2 WHERE dr2.discussion_id = d.id AND dr2.status = 'pending')`;
      break;
    case 'oldest-unanswered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') = 0';
      order = 'ORDER BY d.created_at ASC';
      break;
    case 'newest':
    default:
      break;
  }

  const sql = `
    SELECT d.id, d.user_id, d.item_path, d.title, d.body, d.status, d.created_at, d.updated_at,
           d.deleted_at, d.deleted_by,
           du.name AS deleted_by_name, du.email AS deleted_by_email,
           u.name AS author_name, u.email AS author_email,
           COUNT(dr.id) FILTER (WHERE dr.status = 'visible') AS visible_reply_count,
           COUNT(dr.id) FILTER (WHERE dr.status = 'hidden') AS hidden_reply_count,
           COUNT(dr.id) FILTER (WHERE dr.status = 'deleted') AS deleted_reply_count,
           COUNT(dr.id) AS total_reply_count,
           COUNT(dr.id) FILTER (WHERE dr.accepted_at IS NOT NULL AND dr.status = 'visible') AS accepted_count
    FROM discussions d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN users du ON du.id = d.deleted_by
    LEFT JOIN discussion_replies dr ON dr.discussion_id = d.id
    WHERE 1 = 1 ${whereExtra}
    GROUP BY d.id, u.name, u.email, du.name, du.email
    ${having}
    ${order}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  params.push(limit, offset);
  const result = await pool.query(sql, params);
  return result.rows;
}

// --- Needs Attention (Admin only, efficient, no N+1) ---

export async function getNeedsAttention() {
  try {
    const countsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM discussion_replies dr WHERE dr.discussion_id = d.id AND dr.status = 'visible'))::int AS unanswered_count,
        COUNT(*) FILTER (WHERE d.status = 'hidden')::int AS hidden_questions_count,
        COUNT(*) FILTER (WHERE d.created_at > NOW() - INTERVAL '7 days')::int AS recent_questions_count,
        (SELECT COUNT(*)::int FROM discussion_replies WHERE status = 'hidden') AS hidden_replies_count,
        (SELECT COUNT(*)::int FROM discussion_replies WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'visible') AS recent_replies_count
      FROM discussions d
    `);
    const recentActive = await pool.query(`
      SELECT d.id, d.title, d.item_path, d.status, d.created_at, d.updated_at,
             u.name AS author_name,
             (SELECT MAX(created_at) FROM discussion_replies dr WHERE dr.discussion_id = d.id) AS last_reply_at,
             COUNT(dr.id) FILTER (WHERE dr.status = 'visible') AS reply_count,
             COUNT(dr.id) FILTER (WHERE dr.accepted_at IS NOT NULL AND dr.status = 'visible') AS accepted_count
      FROM discussions d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN discussion_replies dr ON dr.discussion_id = d.id
      GROUP BY d.id, u.name
      ORDER BY GREATEST(d.updated_at, COALESCE((SELECT MAX(created_at) FROM discussion_replies dr2 WHERE dr2.discussion_id = d.id), d.created_at)) DESC
      LIMIT 5
    `);
    const unansweredList = await pool.query(`
      SELECT d.id, d.title, d.item_path, d.created_at, u.name AS author_name
      FROM discussions d
      JOIN users u ON d.user_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM discussion_replies dr WHERE dr.discussion_id = d.id AND dr.status = 'visible')
        AND d.status = 'visible'
      ORDER BY d.created_at DESC
      LIMIT 5
    `);
    return {
      counts: countsResult.rows[0] || { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 },
      recentActive: recentActive.rows || [],
      unansweredList: unansweredList.rows || []
    };
  } catch {
    return {
      counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 },
      recentActive: [],
      unansweredList: []
    };
  }
}

export async function listAllDiscussionsForAdminCount(filter = 'all', searchTerm = '') {
  let having = '';
  let whereExtra = '';
  const params = [];

  if (searchTerm) {
    const searchPattern = `%${searchTerm}%`;
    whereExtra += ` AND (d.title ILIKE $${params.length + 1} OR d.body ILIKE $${params.length + 2} OR u.name ILIKE $${params.length + 3} OR u.email ILIKE $${params.length + 4} OR d.item_path ILIKE $${params.length + 5} OR CAST(d.id AS TEXT) ILIKE $${params.length + 6} OR d.status ILIKE $${params.length + 7})`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
  }

  switch (filter) {
    case 'unanswered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') = 0';
      break;
    case 'answered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') > 0';
      break;
    case 'no-replies':
      having = 'HAVING COUNT(dr.id) = 0';
      break;
    case 'oldest-unanswered':
      having = 'HAVING COUNT(dr.id) FILTER (WHERE dr.status = \'visible\') = 0';
      break;
    case 'hidden':
      whereExtra += ' AND d.status = \'hidden\'';
      break;
    case 'deleted':
      whereExtra += ' AND d.status = \'deleted\'';
      break;
    case 'pending':
      whereExtra += ' AND d.status = \'pending\'';
      break;
    case 'pending-replies':
      whereExtra += ` AND EXISTS (SELECT 1 FROM discussion_replies dr2 WHERE dr2.discussion_id = d.id AND dr2.status = 'pending')`;
      break;
    case 'most-replies':
    case 'newest':
    case 'all':
    default:
      break;
  }

  // Use a CTE to handle GROUP BY/HAVING correctly for counting
  const sql = `
    WITH filtered AS (
      SELECT DISTINCT d.id
      FROM discussions d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN discussion_replies dr ON dr.discussion_id = d.id
      WHERE 1 = 1 ${whereExtra}
      GROUP BY d.id
      ${having}
    )
    SELECT COUNT(*)::int AS count FROM filtered
  `;

  const result = await pool.query(sql, params);
  return result.rows[0]?.count || 0;
}

export async function adminListDiscussionReplies(discussionId) {
  const result = await pool.query(
    `SELECT r.*, u.email AS author_email, u.name AS author_name, COALESCE(u.app_role, 'USER') AS author_app_role,
            du.email AS deleted_by_email, du.name AS deleted_by_name
     FROM discussion_replies r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN users du ON r.deleted_by = du.id
     WHERE r.discussion_id = $1
     ORDER BY r.created_at ASC`,
    [discussionId]
  );
  return result.rows;
}

export async function adminListDiscussionRepliesBatch(discussionIds) {
  if (!discussionIds || discussionIds.length === 0) return new Map();
  const ids = discussionIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT r.*, u.email AS author_email, u.name AS author_name, COALESCE(u.app_role, 'USER') AS author_app_role,
            du.email AS deleted_by_email, du.name AS deleted_by_name
     FROM discussion_replies r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN users du ON r.deleted_by = du.id
     WHERE r.discussion_id = ANY($1::bigint[])
     ORDER BY r.discussion_id ASC, r.created_at ASC`,
    [ids]
  );
  const map = new Map();
  for (const id of ids) map.set(Number(id), []);
  for (const row of result.rows) {
    const did = Number(row.discussion_id);
    if (!map.has(did)) map.set(did, []);
    map.get(did).push(row);
  }
  return map;
}

export async function getDiscussionWithReplies(id, isAdmin = false, currentUserId = null) {
  const discussion = await getDiscussion(id, currentUserId);
  if (!discussion) return null;
  discussion.replies = await getDiscussionReplies(id, isAdmin, currentUserId);
  return discussion;
}

export async function getDiscussionCounts() {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total_questions,
       COUNT(*) FILTER (WHERE status IN ('visible', 'approved'))::int AS visible_questions,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_questions,
       COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden_questions,
       COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted_questions,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS questions_today,
       (SELECT COUNT(*)::int FROM discussion_replies) AS total_replies,
       (SELECT COUNT(*)::int FROM discussion_replies WHERE status IN ('visible', 'approved')) AS visible_replies,
       (SELECT COUNT(*)::int FROM discussion_replies WHERE status = 'pending') AS pending_replies,
       (SELECT COUNT(*)::int FROM discussion_replies WHERE status = 'hidden') AS hidden_replies,
       (SELECT COUNT(*)::int FROM discussion_replies WHERE status = 'deleted') AS deleted_replies,
       (SELECT COUNT(*)::int FROM discussion_replies WHERE created_at > NOW() - INTERVAL '24 hours') AS replies_today
     FROM discussions`
  );
  return result.rows[0];
}

export async function adminApproveDiscussion(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussions SET status = 'approved', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('question', id, 'approve', actorUserId).catch(() => {});
  }
}

export async function adminApproveReply(id, actorUserId = null) {
  await pool.query(
    `UPDATE discussion_replies SET status = 'approved', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  if (actorUserId) {
    await recordModerationAction('reply', id, 'approve', actorUserId).catch(() => {});
  }
}

export async function getDiscussionLikeState(userId, discussionId) {
  const [likeResult, countResult] = await Promise.all([
    pool.query(
      `SELECT 1 FROM discussion_likes WHERE discussion_id = $1 AND user_id = $2`,
      [discussionId, userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM discussion_likes WHERE discussion_id = $1`,
      [discussionId]
    )
  ]);
  return {
    liked: likeResult.rows.length > 0,
    likeCount: Number(countResult.rows[0]?.cnt || 0)
  };
}

export async function toggleDiscussionLike(userId, discussionId) {
  const existing = await pool.query(
    `SELECT 1 FROM discussion_likes WHERE discussion_id = $1 AND user_id = $2`,
    [discussionId, userId]
  );
  const liked = existing.rows.length === 0;
  if (liked) {
    await pool.query(
      `INSERT INTO discussion_likes (discussion_id, user_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
      [discussionId, userId]
    );
  } else {
    await pool.query(
      `DELETE FROM discussion_likes WHERE discussion_id = $1 AND user_id = $2`,
      [discussionId, userId]
    );
  }
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM discussion_likes WHERE discussion_id = $1`,
    [discussionId]
  );
  return { liked, likeCount: Number(countResult.rows[0]?.cnt || 0) };
}

export async function getReplyLikeState(userId, replyId) {
  const [likeResult, countResult] = await Promise.all([
    pool.query(
      `SELECT 1 FROM reply_likes WHERE reply_id = $1 AND user_id = $2`,
      [replyId, userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM reply_likes WHERE reply_id = $1`,
      [replyId]
    )
  ]);
  return {
    liked: likeResult.rows.length > 0,
    likeCount: Number(countResult.rows[0]?.cnt || 0)
  };
}

export async function toggleReplyLike(userId, replyId) {
  const existing = await pool.query(
    `SELECT 1 FROM reply_likes WHERE reply_id = $1 AND user_id = $2`,
    [replyId, userId]
  );
  const liked = existing.rows.length === 0;
  if (liked) {
    await pool.query(
      `INSERT INTO reply_likes (reply_id, user_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
      [replyId, userId]
    );
  } else {
    await pool.query(
      `DELETE FROM reply_likes WHERE reply_id = $1 AND user_id = $2`,
      [replyId, userId]
    );
  }
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM reply_likes WHERE reply_id = $1`,
    [replyId]
  );
  return { liked, likeCount: Number(countResult.rows[0]?.cnt || 0) };
}
