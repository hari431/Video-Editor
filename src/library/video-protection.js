import { pool } from '../db/pool.js';
import { isAdminUser, getAdminEmails } from '../auth/admin.js';

// Video Recording Protection Layer (server helpers).
// Isolated module: masking, admin exemption, session binding, session mapping.
// Admin detection reuses the existing isAdminUser() helper, which already covers
// both DB app_role and the ADMIN_EMAILS env fallback. No new admin config here.
// The on-screen "Licensed to" identity is the configured contact address: the
// first entry of ADMIN_EMAILS via the shared getAdminEmails() parser — never
// the viewer's own email. Persistence is a lightweight session mapping only
// (session_code + user_id + created_at + last_seen_at); browser signals drive
// client-side behavior and are never stored. The raw Express session ID is
// never persisted.

// Event types the server accepts. Anything else is rejected with 400.
export const PROTECTION_EVENT_TYPES = new Set([
  'VIDEO_ACCESS',
  'VIDEO_HIDDEN',
  'VIDEO_VISIBLE',
  'WINDOW_BLURRED',
  'WINDOW_FOCUSED',
  'FULLSCREEN_CHANGED',
  'SUSPECTED_SCREENSHOT_KEY',
  'CONTEXTMENU_BLOCKED',
  'YOUTUBE_PAUSE_ATTEMPTED'
]);

const MAX_ITEM_PATH_LENGTH = 500;

// Mask an email for on-screen watermarking, e.g. "h***@gmail.com".
// Keeps only the first character of the local part so a screen recording
// still carries an identifiable mark without exposing the full address.
export function maskEmailForWatermark(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '';
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.') || /\s/.test(trimmed)) return '';
  return `${trimmed[0]}***@${domain}`;
}

// Admins/owners are exempt so they can test and troubleshoot videos without
// the protection layer interfering. Reuses existing admin logic (ADMIN_EMAILS
// fallback included); never hard-codes addresses here.
export function isVideoProtectionExempt(user) {
  try {
    return isAdminUser(user);
  } catch {
    return false;
  }
}

// Display identity for the watermark: the configured contact address (first
// ADMIN_EMAILS entry, canonical parsing shared with exemption checks),
// masked with the existing maskEmailForWatermark() logic. The viewer's own
// email is never used here; it stays server-side in the audit log. The
// viewer's display NAME is exposed separately (see getViewerDisplayName):
// names are already public in the page header, while full emails never are.
export function getWatermarkSourceEmail() {
  try {
    return getAdminEmails()[0] || '';
  } catch {
    return '';
  }
}
// Short session-specific identifier bound to the authenticated session.
// Derived from the express-session ID; safe to render (opaque, 8 chars).
export function getVideoProtectionSessionShort(req, fallback = '') {
  try {
    const raw = String(req?.sessionID || fallback || '').replace(/[^a-zA-Z0-9]/g, '');
    if (!raw) return '00000000';
    return raw.slice(-8).padStart(8, '0');
  } catch {
    return '00000000';
  }
}

// Viewer display name for the watermark's "For <name> · Downloading or Recording is prohibited"
// line. Taken from the currently authenticated user only; trimmed, never the
// email address. Empty when missing/exempt — templates fall back to 'member'.
export function getViewerDisplayName(user) {
  try {
    const name = String(user?.name || '').trim();
    return name || '';
  } catch {
    return '';
  }
}

// Per-video override from the External - file's `Watermark:` directive.
// Explicit true/false always wins; null/absent keeps today's role default.
export function resolveVideoWatermarkEnabled({ fileWatermark = null, protectionEnabled = false } = {}) {
  if (fileWatermark === true) return true;
  if (fileWatermark === false) return false;
  return !!protectionEnabled;
}

// Pill-only visibility for the recording-protection watermark overlay.
// Unlike resolveVideoWatermarkEnabled (whole protection layer), an explicit
// false hides ONLY the pill — shields, toolbars, scripts and branding keep
// following the protection default. Explicit true forces it visible.
export function resolveWatermarkVisible({ fileWatermark = null, protectionEnabled = false } = {}) {
  if (fileWatermark === false) return false;
  if (fileWatermark === true) return true;
  return !!protectionEnabled;
}

// Build the template context for video/external pages. `enabled` is false
// for exempt (admin) users; templates then skip watermark + client script.
// options.forceWatermark (true/false/null, from the file directive) overrides
// the role-based default without changing it for other videos.
export function buildVideoProtectionContext(req, itemPath, itemType, options = {}) {
  const user = req?.user || null;
  const baseEnabled = !!user && !isVideoProtectionExempt(user);
  const force = options && typeof options === 'object' ? options.forceWatermark ?? null : null;
  const enabled = resolveVideoWatermarkEnabled({ fileWatermark: force, protectionEnabled: baseEnabled });
  return {
    enabled,
    maskedEmail: enabled ? maskEmailForWatermark(getWatermarkSourceEmail()) : '',
    sessionShort: getVideoProtectionSessionShort(req),
    viewerName: enabled ? getViewerDisplayName(user) : '',
    itemPath: String(itemPath || ''),
    itemType: String(itemType || '')
  };
}

function sanitizeItemPath(value) {
  const s = String(value || '').trim();
  if (!s || s.length > MAX_ITEM_PATH_LENGTH) return null;
  if (s.includes('\0')) return null;
  return s;
}

// SQL twin of getVideoProtectionSessionShort(), for admin lookup of a video
// session by its 8-character watermark code. The CASE form is required:
// PostgreSQL LPAD() truncates overlong strings (verified live —
// RIGHT(LPAD(r,8,'0'),8) wrongly yields the FIRST 8 chars). The column
// reference is allowlisted to a safe identifier pattern to prevent injection.
export function videoProtectionSessionCodeSql(columnRef) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(columnRef || ''))) {
    throw new Error('Invalid column reference.');
  }
  const filtered = `REGEXP_REPLACE(${columnRef},'[^a-zA-Z0-9]','','g')`;
  return `CASE WHEN LENGTH(${filtered}) < 8 THEN LPAD(${filtered},8,'0') ELSE RIGHT(${filtered},8) END`;
}

// ADMIN-ONLY lookup: find the viewer session behind an 8-character
// watermark code (e.g. from a recorded video). Returns at most the single
// session mapping row (session_code is the PRIMARY KEY). The raw session ID
// is never stored, so it is never selected or returned — only the code.
// Unauthenticated/irrelevant callers are gated by the route's requireAdmin;
// this helper additionally validates input and never throws (missing table
// 42P01 degrades to a friendly message).
export async function searchVideoProtectionSession(sessionCode) {
  const clean = String(sessionCode || '').replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length !== 8) {
    return { ok: false, error: 'Enter the 8-character Protection Session code shown in the video watermark.' };
  }
  try {
    const codeSql = videoProtectionSessionCodeSql('s.session_code');
    const res = await pool.query(
      `SELECT ${codeSql} AS session_code,
              s.user_id, u.email AS user_email, u.name AS user_name,
              u.app_role AS user_role, u.status AS user_status,
              s.created_at AS first_seen, s.last_seen_at AS last_seen
         FROM video_protection_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE LOWER(${codeSql}) = LOWER($1)`,
      [clean]
    );
    if (res.rows.length === 0) {
      return { ok: true, code: clean, session: null };
    }
    return { ok: true, code: clean, session: res.rows[0] };
  } catch (error) {
    if (error?.code === '42P01') {
      return { ok: false, error: 'Protection session table is not available yet (migration 042 has not run).' };
    }
    console.error('Error searching video protection sessions:', error?.message || error);
    return { ok: false, error: 'Unable to search protection sessions right now.' };
  }
}
// Session mapping touch (UPSERT). First protected-video access for a session
// creates exactly one row; subsequent accesses only bump last_seen_at — never
// one row per video or per browser signal. Never throws: returns { ok }.
// Tolerates the migration not having run yet (42P01 undefined_table).
export async function touchVideoProtectionSession(req) {
  try {
    const userId = req?.user?.id;
    if (!userId) return { ok: false, touched: false };
    const code = getVideoProtectionSessionShort(req);
    await pool.query(
      `INSERT INTO video_protection_sessions (session_code, user_id, created_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (session_code) DO UPDATE SET last_seen_at = NOW()`,
      [code, userId]
    );
    return { ok: true, touched: true };
  } catch (error) {
    // Table may not exist until migration 042 runs; page views must not break.
    if (error?.code === '42P01') return { ok: true, touched: false };
    console.error('Error touching video protection session:', error?.message || error);
    return { ok: false, touched: false };
  }
}
