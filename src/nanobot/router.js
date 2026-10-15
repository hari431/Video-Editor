/**
 * Phase 2 — nanobot Express routes (token issuance only, read-only sidecar).
 *
 * Single endpoint:
 *   POST /api/nanobot/token   (requireApiAuth)
 *
 * The authenticated session (`req.user`, established by the existing
 * `requireApiAuth` middleware — untouched) is the sole source of truth.
 * The handler mints a short-lived, HMAC-bound session token for exactly that
 * user (see `./session-tokens.js`). No identity is accepted from the request
 * body, so there is nothing for nanobot to select or override.
 *
 * Disabled by default: unless `NANOBOT_ENABLED=true`, the endpoint answers
 * 404 (same kill-switch convention as the Free-TV routes). No MCP traffic is
 * served here — calls stay on the local-only stdio server, which verifies the
 * session token and ignores any caller-supplied user object.
 */

import { requireApiAuth } from '../auth/middleware.js';
import { isNanobotEnabled } from './mcp-bridge.js';
import { mintSessionToken, NANOBOT_SESSION_TTL_MS } from './session-tokens.js';

/** Mint a session token for the authenticated request user. Exported for tests. */
export async function handleTokenMint(req, res) {
  if (!isNanobotEnabled()) {
    return res.status(404).json({ ok: false, error: 'Not found.' });
  }
  try {
    const token = mintSessionToken(req.user);
    return res.json({ ok: true, token, expiresInMs: NANOBOT_SESSION_TTL_MS });
  } catch {
    // Service secret unconfigured (or user without identity): stay unavailable
    // without saying which, and never echo secrets or user records.
    return res.status(503).json({ ok: false, error: 'Nanobot sidecar is unavailable.' });
  }
}

/** Register nanobot routes on the app. Called once from `src/server.js`. */
export function registerNanobotRoutes(app) {
  app.post('/api/nanobot/token', requireApiAuth, handleTokenMint);
}
