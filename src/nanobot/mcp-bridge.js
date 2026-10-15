/**
 * Phase 1 — nanobot read-only MCP tool layer (sidecar, disabled by default).
 *
 * Exposes EXACTLY two capabilities to nanobot:
 *   - search_library  (library search, Luna-authorized users only)
 *   - get_admin_brief (sanitized admin brief, admins only)
 *
 * Security properties (all reuse existing code, nothing duplicated):
 * - Authorization: `assertLunaUser()` (src/luna/permissions.js) for search,
 *   `isAdminUser()` (src/auth/admin.js) for the brief. No new auth logic.
 * - Permission filtering: existing `searchLibrary()` (src/luna/tools/library.js),
 *   which checks `canAccessLibraryPathAsync()` per path. No reimplementation.
 * - Sanitization/caps: existing evidence caps (`EVIDENCE_CAPS`), brief caps
 *   (`BRIEF_CAPS`), email masking, and snippet truncation travel unchanged.
 * - No database access here: this module never imports `db/pool` and issues
 *   no SQL. Reads flow only through the existing getters named above.
 * - No filesystem/shell access here: no `node:fs`, no `node:child_process`,
 *   no `queries/` scanning. The caller injects an already-built library tree
 *   (production wiring in a later phase passes the Express-cached tree).
 * - `topK` is clamped to [1, 8]; requests above 8 are safely capped and the
 *   response flags `capped: true` (never rejected with a transport error, so
 *   nanobot degrades gracefully instead of failing).
 *
 * Out of scope for Phase 1 (explicit): Express route wiring, nanobot
 * `config.json` edits, real provider keys, and binding the caller's session
 * user server-side. Callers pass `user` explicitly; a later phase will replace
 * that argument with the authenticated session user so nanobot cannot
 * self-assert identity.
 */

import { searchLibrary } from '../luna/tools/library.js';
import { assertLunaUser } from '../luna/permissions.js';
import { MAX_QUERY_LENGTH } from '../luna/conversation.js';
import { isAdminUser } from '../auth/admin.js';
import { buildAdminEvidencePack } from '../admin-assistant/evidence.js';
import { buildAdminBrief } from '../admin-assistant/brief.js';

/** The only tool names this bridge (and nanobot's `enabledTools`) may use. */
export const MCP_TOOL_ALLOWLIST = ['search_library', 'get_admin_brief'];

export const MCP_TOPK_DEFAULT = 5;
export const MCP_TOPK_MAX = 8;
export const MCP_SNIPPET_CHARS = 900;

/**
 * Sidecar kill switch. Default false: the bridge/server does nothing unless
 * `NANOBOT_ENABLED=true` is set explicitly. Reads env only, never persisted.
 */
export function isNanobotEnabled(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  return String(source.NANOBOT_ENABLED || 'false').trim().toLowerCase() === 'true';
}

/** Exact `enabledTools` value nanobot's `config.json` must pin (allowlist). */
export function nanobotEnabledTools() {
  return [...MCP_TOOL_ALLOWLIST];
}

function clampTopK(value) {
  const parsed = Number.parseInt(value, 10);
  const safe = Number.isFinite(parsed) ? parsed : MCP_TOPK_DEFAULT;
  const clamped = Math.max(1, Math.min(safe, MCP_TOPK_MAX));
  return { topK: clamped, capped: safe > MCP_TOPK_MAX };
}

function cleanQuery(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Query is required.');
  if (text.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds the maximum length of ${MAX_QUERY_LENGTH} characters.`);
  }
  return text;
}

/** Allowlisted output keys only: never scores internals, bytes, or raw rows. */
function toPublicResult(row) {
  return {
    source: row?.source ?? null,
    title: row?.title ?? null,
    path: row?.path ?? null,
    href: row?.href ?? null,
    snippet: String(row?.snippet ?? row?.content ?? '').slice(0, MCP_SNIPPET_CHARS)
  };
}

/**
 * search_library — permission-filtered library search (read-only).
 * Throws for unauthenticated/unauthorized users (same rule as Luna).
 * Returns `{ ok, results, topK, capped }`, or `{ ok:false, error:'unavailable' }`
 * when no library tree was provided (never reads the disk itself).
 */
export async function searchLibraryTool({ query, topK, user, tree, deps = {} } = {}) {
  assertLunaUser(user);
  const clean = cleanQuery(query);
  const { topK: safeTopK, capped } = clampTopK(topK);
  if (!tree) {
    return { ok: false, error: 'unavailable', message: 'Library is currently unavailable.' };
  }
  const searchImpl = deps.searchImpl || searchLibrary;
  const rows = await searchImpl({ query: clean, tree, user, topK: safeTopK });
  return {
    ok: true,
    results: (Array.isArray(rows) ? rows : []).slice(0, safeTopK).map(toPublicResult),
    topK: safeTopK,
    capped
  };
}

/**
 * get_admin_brief — sanitized admin evidence brief (read-only).
 * Non-admins (including unauthenticated) receive `{ ok:false, error:'forbidden' }`.
 * `evidenceDeps` is passed straight to `buildAdminEvidencePack()` (injectable
 * for tests, exactly like the existing evidence tests do).
 */
export async function getAdminBriefTool({ user, evidenceDeps = {} } = {}) {
  if (!isAdminUser(user)) {
    return { ok: false, error: 'forbidden', message: 'Admin access required.' };
  }
  const pack = await buildAdminEvidencePack(evidenceDeps);
  return { ok: true, brief: buildAdminBrief(pack) };
}
