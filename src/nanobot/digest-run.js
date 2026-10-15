/**
 * Phase 3 Step 2 — sidecar digest runner (read-only, no delivery).
 *
 * Connects the pure `./digest.js` composer to the real Phase 1 tools
 * (`search_library`, `get_admin_brief`) through the Phase 2 token identity.
 * Output is RETURNED to the caller only — this module performs no
 * scheduling, delivery, email, UI changes, or production wiring. Callers
 * (tests, local inspection) decide what to do with the digest artifact.
 *
 * Identity rule (mirrors `./mcp-server.js`): the ONLY accepted identity is
 * `sessionToken`, verified via `./session-tokens.js`. This function takes NO
 * `user` argument, so nanobot cannot supply or override the application
 * user — override is impossible by construction, not just by convention.
 *
 * Failure semantics are fail-closed and structured (never throws for
 * auth/tool outcomes):
 * - sidecar disabled → `{ ok:false, error:'disabled' }` before any tool runs.
 * - bad/expired token → `{ ok:false, error:'forbidden' }` before any tool runs.
 * - brief forbidden/unavailable → composer runs with `brief: null` and the
 *   digest records `admin-brief` under `unavailable`.
 * - search denied/empty/skipped → digest composes from the brief alone.
 */

import {
  MCP_TOOL_ALLOWLIST,
  isNanobotEnabled,
  searchLibraryTool,
  getAdminBriefTool
} from './mcp-bridge.js';
import { verifySessionToken } from './session-tokens.js';
import { composeDigest } from './digest.js';

/** The runner uses exactly the Phase 1 allowlist — no new tools. */
export function digestRunnerTools() {
  return [...MCP_TOOL_ALLOWLIST];
}

function isNonEmptyQuery(value) {
  return typeof value === 'string' && value.replace(/\s+/g, ' ').trim().length > 0;
}

/**
 * Build a digest for the holder of `sessionToken`.
 * Digest items come ONLY from the admin brief; library search rows are
 * supporting context only (never automatic items). Question sources named
 * in `excludedPaths` are filtered from supporting context while other
 * supporting rows are retained.
 * @param {object} args
 * @param {string} args.sessionToken Express-minted session token (required).
 * @param {string} [args.query] optional library focus query (no query → brief only).
 * @param {number} [args.topK] search cap (clamped to 8 by the bridge).
 * @param {object} [args.tree] injected library tree (never read from disk here).
 * @param {object} [args.evidenceDeps] injectable evidence getters (tests).
 * @param {object} [args.searchDeps] injectable search impl (tests).
 * @param {Set} [args.excludedPaths] question-source paths to exclude from supporting context.
 */
export async function buildSidecarDigest({
  sessionToken,
  query = '',
  topK,
  tree = null,
  evidenceDeps = {},
  searchDeps = {},
  excludedPaths = new Set()
} = {}) {
  if (!isNanobotEnabled()) {
    return { ok: false, error: 'disabled', message: 'Nanobot sidecar is disabled.' };
  }
  const user = verifySessionToken(sessionToken);
  if (!user) {
    return { ok: false, error: 'forbidden', message: 'Access denied.' };
  }

  const briefOut = await getAdminBriefTool({ user, evidenceDeps });

  let searchRows = [];
  let searchStatus = 'skipped';
  if (isNonEmptyQuery(query)) {
    try {
      const searchOut = await searchLibraryTool({ query, topK, user, tree, deps: searchDeps });
      if (searchOut && searchOut.ok) {
        searchRows = Array.isArray(searchOut.results) ? searchOut.results : [];
        searchStatus = searchRows.length ? 'ok' : 'empty';
      } else {
        searchStatus = (searchOut && searchOut.error) || 'unavailable';
      }
    } catch (error) {
      searchStatus = String(error?.message || 'denied').slice(0, 120);
    }
  }

  const composed = composeDigest({
    brief: briefOut && briefOut.ok ? briefOut.brief : null,
    searchResults: searchRows,
    excludedPaths: excludedPaths instanceof Set ? excludedPaths : new Set()
  });

  return {
    ok: true,
    digest: composed.digest,
    sources: {
      brief: briefOut && briefOut.ok ? 'ok' : (briefOut && briefOut.error) || 'unavailable',
      search: searchStatus
    }
  };
}
