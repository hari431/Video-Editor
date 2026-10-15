import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';

// Short Share Links (/s/<code>) — one stable opaque code per exact library
// file path. Codes are random and carry no path, filename, user identity or
// access information. Opening a short URL redirects to the canonical content
// route, which re-applies the existing authentication + authorization checks;
// the link itself never grants access. Storage only (migration 043).

// 12 URL-safe chars from 9 random bytes (~72 bits): short, opaque, unguessable.
export const SHARE_CODE_BYTES = 9;
const CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_GENERATE_ATTEMPTS = 5;

export function generateShareCode() {
  return randomBytes(SHARE_CODE_BYTES).toString('base64url');
}

export function isValidShareCode(code) {
  return typeof code === 'string' && CODE_RE.test(code.trim());
}

// Resolve a code to its library file path, or null for malformed/unknown
// codes. Database errors propagate (missing table → caller renders 500).
export async function findShareTarget(code) {
  const clean = String(code || '').trim();
  if (!isValidShareCode(clean)) return null;
  const res = await pool.query('SELECT file_path FROM share_links WHERE share_code = $1', [clean]);
  return res.rows[0]?.file_path || null;
}

// Return the existing code for this exact file path, or generate + persist
// one. Race-safe: concurrent creators converge via the file_path unique
// constraint; share_code collisions regenerate (23505 → retry).
export async function getOrCreateShareCode(filePath, userId) {
  const relPath = String(filePath || '');
  const existing = await pool.query('SELECT share_code FROM share_links WHERE file_path = $1', [relPath]);
  if (existing.rows.length) return existing.rows[0].share_code;
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const code = generateShareCode();
    try {
      const ins = await pool.query(
        `INSERT INTO share_links (file_path, share_code, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (file_path) DO NOTHING
         RETURNING share_code`,
        [relPath, code, userId ?? null]
      );
      if (ins.rows.length) return ins.rows[0].share_code;
      // Lost a file_path race: re-read the winner's code.
      const reread = await pool.query('SELECT share_code FROM share_links WHERE file_path = $1', [relPath]);
      if (reread.rows.length) return reread.rows[0].share_code;
    } catch (err) {
      if (err?.code === '23505') continue; // share_code collision → regenerate
      throw err;
    }
  }
  throw new Error('Unable to generate share link.');
}
