import { pool } from '../db/pool.js';

export function getQuestionKey(categorySlug, articleSlug, index) {
  const cat = String(categorySlug || 'general').trim().toLowerCase().replace(/\s+/g, '-');
  const art = String(articleSlug || 'general').trim().toLowerCase().replace(/\s+/g, '-');
  const idx = Number.isInteger(Number(index)) ? Number(index) : 0;
  return `${cat}/${art}/q${idx}`;
}

export async function saveNote({
  userId,
  questionKey = null,
  contentKey = null,
  itemPath = null,
  categorySlug = null,
  articleSlug = null,
  questionIndex = 0,
  questionText = '',
  title = '',
  noteText = '',
  contentType = null
}, dbClient = pool) {
  if (!userId) {
    throw new Error('User ID is required to save a private note.');
  }
  let cleanKey = String(contentKey || questionKey || itemPath || '').trim();
  if (!cleanKey && categorySlug && articleSlug) {
    cleanKey = getQuestionKey(categorySlug, articleSlug, questionIndex);
  }
  if (!cleanKey) {
    throw new Error('Question identifier or content key (questionKey or contentKey) is required.');
  }
  const cleanNote = String(noteText || '').trim();
  if (!cleanNote) {
    throw new Error('Note content cannot be empty.');
  }
  if (cleanNote.length > 10000) {
    throw new Error('Note content exceeds maximum allowed length (10,000 characters).');
  }
  const cleanQuestion = String(title || questionText || cleanKey).trim();
  const qIdx = Number.isInteger(Number(questionIndex)) ? Number(questionIndex) : 0;
  const cleanCategory = categorySlug ? String(categorySlug).trim() : null;
  const cleanArticle = articleSlug ? String(articleSlug).trim() : null;

  const result = await dbClient.query(
    `INSERT INTO interview_question_notes (
      user_id,
      question_key,
      category_slug,
      article_slug,
      question_index,
      question_text,
      note_text,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (user_id, question_key)
    DO UPDATE SET
      note_text = EXCLUDED.note_text,
      question_text = CASE 
        WHEN EXCLUDED.question_text IS NOT NULL AND EXCLUDED.question_text <> '' 
        THEN EXCLUDED.question_text 
        ELSE interview_question_notes.question_text 
      END,
      category_slug = COALESCE(EXCLUDED.category_slug, interview_question_notes.category_slug),
      article_slug = COALESCE(EXCLUDED.article_slug, interview_question_notes.article_slug),
      question_index = COALESCE(EXCLUDED.question_index, interview_question_notes.question_index),
      updated_at = NOW()
    RETURNING *`,
    [userId, cleanKey, cleanCategory, cleanArticle, qIdx, cleanQuestion, cleanNote]
  );

  return result.rows[0];
}

export async function getNote(userId, keyOrPath, dbClient = pool) {
  if (!userId || !keyOrPath) return null;
  const cleanKey = String(keyOrPath).trim();
  const result = await dbClient.query(
    'SELECT * FROM interview_question_notes WHERE user_id = $1 AND question_key = $2',
    [userId, cleanKey]
  );
  return result.rows[0] || null;
}

export const getUserNote = getNote;

export async function getUserNotes(userId, dbClient = pool) {
  if (!userId) return [];
  const result = await dbClient.query(
    `SELECT * FROM interview_question_notes WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function getUserNotesForArticle(userId, articleSlug, dbClient = pool) {
  if (!userId || !articleSlug) return [];
  const slug = String(articleSlug).trim();
  const result = await dbClient.query(
    `SELECT * FROM interview_question_notes 
     WHERE user_id = $1 AND (article_slug = $2 OR question_key LIKE $3)
     ORDER BY question_index ASC, updated_at DESC`,
    [userId, slug, `%/${slug}/%`]
  );
  return result.rows;
}

export async function getUserNotesForCategory(userId, categorySlug, dbClient = pool) {
  if (!userId || !categorySlug) return [];
  const slug = String(categorySlug).trim();
  const result = await dbClient.query(
    `SELECT * FROM interview_question_notes 
     WHERE user_id = $1 AND (category_slug = $2 OR question_key LIKE $3)
     ORDER BY updated_at DESC`,
    [userId, slug, `${slug}/%`]
  );
  return result.rows;
}

export async function getUserNotesMap(userId, { articleSlug = null, categorySlug = null } = {}, dbClient = pool) {
  let notes = [];
  if (articleSlug) {
    notes = await getUserNotesForArticle(userId, articleSlug, dbClient);
  } else if (categorySlug) {
    notes = await getUserNotesForCategory(userId, categorySlug, dbClient);
  } else {
    notes = await getUserNotes(userId, dbClient);
  }
  const map = {};
  for (const n of notes) {
    if (n && n.question_key) {
      map[n.question_key] = n;
    }
  }
  return map;
}

export async function deleteNote(userId, { id = null, questionKey = null, contentKey = null, itemPath = null } = {}, dbClient = pool) {
  if (!userId) {
    throw new Error('User ID is required to delete a private note.');
  }
  const cleanKey = String(contentKey || questionKey || itemPath || '').trim();
  if (!id && !cleanKey) {
    throw new Error('Either note ID or content key is required to delete a note.');
  }

  let result;
  if (id) {
    result = await dbClient.query(
      `DELETE FROM interview_question_notes WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, Number(id)]
    );
  } else {
    result = await dbClient.query(
      `DELETE FROM interview_question_notes WHERE user_id = $1 AND question_key = $2 RETURNING *`,
      [userId, cleanKey]
    );
  }

  const deleted = (result.rowCount > 0 || (result.rows && result.rows.length > 0));
  return {
    deleted,
    note: (result.rows && result.rows.length > 0) ? result.rows[0] : null
  };
}

export async function getAllNotesForAdmin({ limit = 50, offset = 0 } = {}, dbClient = pool) {
  const l = Math.max(1, Math.min(Number(limit) || 50, 200));
  const o = Math.max(0, Number(offset) || 0);

  const result = await dbClient.query(
    `SELECT 
      n.id,
      n.user_id,
      n.question_key,
      n.category_slug,
      n.article_slug,
      n.question_index,
      n.question_text,
      n.note_text,
      n.created_at,
      n.updated_at,
      u.email AS user_email,
      u.name AS user_name,
      u.status AS user_status
    FROM interview_question_notes n
    JOIN users u ON n.user_id = u.id
    ORDER BY n.updated_at DESC
    LIMIT $1 OFFSET $2`,
    [l, o]
  );
  return result.rows;
}

export async function getAdminNotesStats(dbClient = pool) {
  const result = await dbClient.query(
    `SELECT 
      COUNT(*)::int AS total_notes,
      COUNT(DISTINCT user_id)::int AS unique_learners,
      COUNT(DISTINCT question_key)::int AS unique_questions
    FROM interview_question_notes`
  );
  const row = result.rows[0] || {};
  return {
    total_notes: Number(row.total_notes) || 0,
    unique_learners: Number(row.unique_learners) || 0,
    unique_questions: Number(row.unique_questions) || 0
  };
}
