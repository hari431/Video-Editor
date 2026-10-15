/**
 * Phase 5 Step 1 — Admin evidence pack (read-only).
 *
 * Deterministic aggregation only. No LLM/provider calls, no routes, no UI,
 * no writes, no background jobs. Consumes existing read-only getters and
 * fixed aggregate SQL; never returns secrets, raw user rows, or PII.
 *
 * Allowed imports are read-only getters only. This module must never import
 * admin mutation functions (approve/extend/revoke/grant*), Luna, or env
 * secrets. A unit test pins that boundary at the source level.
 */
import { getMetrics } from '../monitoring/metrics.js';
import { getHealthIndicators } from '../monitoring/health.js';
import { getSystemIntegrityReport } from '../monitoring/integrity.js';
import { getDailyHistory } from '../monitoring/history.js';
import { getNeedsAttention } from '../library/discussions.js';
import { getAdminNotesStats } from '../knowledge/notes.js';
import { pool } from '../db/pool.js';

/** Hard caps for the evidence pack. */
export const EVIDENCE_CAPS = {
  MAX_HISTORY_DAYS: 14,
  MAX_ITEMS_PER_CHECK: 10,
  MAX_DETAIL_CHARS: 300,
  MAX_TITLE_CHARS: 120,
  MAX_LIST_ITEMS: 5
};

/** Mask an email address: keep first char + domain, drop the rest. */
export function maskEmail(email) {
  const raw = String(email || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return '***';
  const domain = raw.slice(at + 1).toLowerCase();
  return `${raw[0].toLowerCase()}***@${domain}`;
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isSecretKey(key) {
  return /(token|secret|password|api[_-]?key|webhook|private[_-]?key)/i.test(String(key || ''));
}

/** Sanitize one integrity item: mask emails, drop secret-ish keys, truncate strings. */
function sanitizeIntegrityItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (isSecretKey(key)) continue;
    if (/e-?mail/i.test(key)) {
      out[key] = typeof value === 'string' && value ? maskEmail(value) : value;
    } else if (typeof value === 'string') {
      out[key] = truncateText(value, EVIDENCE_CAPS.MAX_DETAIL_CHARS);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sanitize an integrity report: keep check metadata, cap + sanitize items.
 * Never forwards raw user emails.
 */
export function sanitizeIntegrityReport(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  return {
    timestamp: report?.timestamp || null,
    overallStatus: report?.overallStatus || 'unknown',
    recommendation: truncateText(report?.recommendation || '', EVIDENCE_CAPS.MAX_DETAIL_CHARS),
    summary: report?.summary && typeof report.summary === 'object' ? { ...report.summary } : null,
    checks: checks.map(check => ({
      id: check?.id || null,
      title: check?.title || null,
      category: check?.category || null,
      status: check?.status || 'unknown',
      count: Number(check?.count) || 0,
      description: truncateText(check?.description || '', EVIDENCE_CAPS.MAX_DETAIL_CHARS),
      actionUrl: check?.actionUrl || null,
      actionLabel: check?.actionLabel || null,
      items: (Array.isArray(check?.items) ? check.items : [])
        .slice(0, EVIDENCE_CAPS.MAX_ITEMS_PER_CHECK)
        .map(sanitizeIntegrityItem)
        .filter(Boolean)
    }))
  };
}

/** Pick only numeric attention counts (no user rows). */
function pickCounts(counts) {
  const source = counts && typeof counts === 'object' ? counts : {};
  const pick = key => {
    const n = Number(source[key]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    unanswered_count: pick('unanswered_count'),
    hidden_questions_count: pick('hidden_questions_count'),
    hidden_replies_count: pick('hidden_replies_count'),
    recent_questions_count: pick('recent_questions_count'),
    recent_replies_count: pick('recent_replies_count')
  };
}

/** Keep discussion metadata (id/title/path/status) without author names. */
function sanitizeDiscussionRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? null,
    title: truncateText(row.title || '', EVIDENCE_CAPS.MAX_TITLE_CHARS),
    item_path: row.item_path ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null
  };
}

/**
 * Sanitize needs-attention data: counts plus capped, author-free lists.
 * Author names are PII and are never forwarded.
 */
export function sanitizeNeedsAttention(data) {
  const counts = pickCounts(data?.counts);
  const recentActive = (Array.isArray(data?.recentActive) ? data.recentActive : [])
    .slice(0, EVIDENCE_CAPS.MAX_LIST_ITEMS)
    .map(sanitizeDiscussionRow)
    .filter(Boolean);
  const unansweredList = (Array.isArray(data?.unansweredList) ? data.unansweredList : [])
    .slice(0, EVIDENCE_CAPS.MAX_LIST_ITEMS)
    .map(sanitizeDiscussionRow)
    .filter(Boolean);
  return { counts, recentActiveCount: recentActive.length, unansweredListCount: unansweredList.length, recentActive, unansweredList };
}

// Fixed read-only aggregate: status counts only, no names/emails/content.
const ACCESS_OVERVIEW_SQL = `
  SELECT
    COUNT(*)::int AS total_users,
    COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_users,
    COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked_users,
    COUNT(*) FILTER (WHERE status = 'active')::int AS active_users,
    COUNT(*) FILTER (WHERE COALESCE(app_role, 'USER') IN ('ADMIN', 'OWNER'))::int AS admin_users,
    COUNT(*) FILTER (
      WHERE status = 'active'
        AND access_expires_at IS NOT NULL
        AND access_expires_at > NOW()
        AND access_expires_at <= NOW() + INTERVAL '7 days'
        AND COALESCE(app_role, 'USER') NOT IN ('ADMIN', 'OWNER')
    )::int AS expiring_soon_users
  FROM users
`;

// Fallback when the app_role column does not exist yet (migration pending).
const ACCESS_OVERVIEW_SQL_FALLBACK = `
  SELECT
    COUNT(*)::int AS total_users,
    COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_users,
    COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked_users,
    COUNT(*) FILTER (WHERE status = 'active')::int AS active_users,
    0::int AS admin_users,
    COUNT(*) FILTER (
      WHERE status = 'active'
        AND access_expires_at IS NOT NULL
        AND access_expires_at > NOW()
        AND access_expires_at <= NOW() + INTERVAL '7 days'
    )::int AS expiring_soon_users
  FROM users
`;

function toAccessOverview(row) {
  const source = row && typeof row === 'object' ? row : {};
  const pick = key => {
    const n = Number(source[key]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    total_users: pick('total_users'),
    pending_users: pick('pending_users'),
    revoked_users: pick('revoked_users'),
    active_users: pick('active_users'),
    admin_users: pick('admin_users'),
    expiring_soon_users: pick('expiring_soon_users')
  };
}

/** Read-only user access overview (counts only, no PII). */
export async function getAccessOverview(dbClient = pool) {
  try {
    const result = await dbClient.query(ACCESS_OVERVIEW_SQL);
    return toAccessOverview(result?.rows?.[0]);
  } catch {
    const result = await dbClient.query(ACCESS_OVERVIEW_SQL_FALLBACK);
    return toAccessOverview(result?.rows?.[0]);
  }
}

function sectionError(message) {
  return truncateText(String(message || 'Unavailable'), EVIDENCE_CAPS.MAX_DETAIL_CHARS);
}

/**
 * Build the full admin evidence pack. Every section is independent and
 * failure-isolated: a failing getter yields `{ ok: false }` for that section
 * only, never rejects the pack. All fns are injectable for tests.
 */
export async function buildAdminEvidencePack(deps = {}) {
  const {
    metricsFn = () => getMetrics(),
    healthFn = metrics => getHealthIndicators(metrics),
    integrityFn = () => getSystemIntegrityReport(pool),
    historyFn = limit => getDailyHistory(limit),
    needsFn = () => getNeedsAttention(),
    notesFn = () => getAdminNotesStats(pool),
    accessClient = pool,
    historyLimit = EVIDENCE_CAPS.MAX_HISTORY_DAYS
  } = deps || {};

  const pack = {
    meta: {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      caps: { ...EVIDENCE_CAPS }
    },
    access: null,
    attention: null,
    health: null,
    integrity: null,
    usage: null,
    notes: null
  };

  try {
    pack.access = { ok: true, data: await getAccessOverview(accessClient) };
  } catch (error) {
    pack.access = { ok: false, error: sectionError(error?.message) };
  }

  try {
    pack.attention = { ok: true, data: sanitizeNeedsAttention(await needsFn()) };
  } catch (error) {
    pack.attention = { ok: false, error: sectionError(error?.message) };
  }

  try {
    const metrics = await metricsFn();
    pack.health = { ok: true, data: await healthFn(metrics) };
  } catch (error) {
    pack.health = { ok: false, error: sectionError(error?.message) };
  }

  try {
    pack.integrity = { ok: true, data: sanitizeIntegrityReport(await integrityFn()) };
  } catch (error) {
    pack.integrity = { ok: false, error: sectionError(error?.message) };
  }

  try {
    const limit = Math.min(Math.max(Number(historyLimit) || EVIDENCE_CAPS.MAX_HISTORY_DAYS, 1), EVIDENCE_CAPS.MAX_HISTORY_DAYS);
    const history = await historyFn(limit);
    pack.usage = { ok: true, data: Array.isArray(history) ? history.slice(0, limit) : [] };
  } catch (error) {
    pack.usage = { ok: false, error: sectionError(error?.message) };
  }

  try {
    pack.notes = { ok: true, data: await notesFn() };
  } catch (error) {
    pack.notes = { ok: false, error: sectionError(error?.message) };
  }

  return pack;
}
