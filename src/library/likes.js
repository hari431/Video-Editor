import { pool } from '../db/pool.js';

const LIKES_TABLE = 'item_likes';
const ITEM_PATH_COLUMN = 'item_path';

export async function getLikeState(userId, itemPath) {
  const [likeResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id FROM ${LIKES_TABLE} WHERE ${ITEM_PATH_COLUMN} = $1 AND user_id = $2`,
      [itemPath, userId]
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM ${LIKES_TABLE} WHERE ${ITEM_PATH_COLUMN} = $1`,
      [itemPath]
    )
  ]);
  return {
    liked: likeResult.rows.length > 0,
    likeCount: Number(countResult.rows[0].cnt)
  };
}

export async function toggleLike(userId, itemPath) {
  const existing = await pool.query(
    `SELECT id FROM ${LIKES_TABLE} WHERE ${ITEM_PATH_COLUMN} = $1 AND user_id = $2`,
    [itemPath, userId]
  );
  const liked = existing.rows.length === 0;
  if (liked) {
    await pool.query(
      `INSERT INTO ${LIKES_TABLE} (${ITEM_PATH_COLUMN}, user_id, created_at) VALUES ($1, $2, NOW())`,
      [itemPath, userId]
    );
  } else {
    await pool.query(
      `DELETE FROM ${LIKES_TABLE} WHERE ${ITEM_PATH_COLUMN} = $1 AND user_id = $2`,
      [itemPath, userId]
    );
  }
  const countResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${LIKES_TABLE} WHERE ${ITEM_PATH_COLUMN} = $1`,
    [itemPath]
  );
  return { liked, likeCount: Number(countResult.rows[0].cnt) };
}