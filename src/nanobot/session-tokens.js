/**
 * Phase 2 — trusted identity for the nanobot sidecar (stateless session tokens).
 *
 * Problem (Phase 1 residual): the MCP server accepted a caller-supplied `user`
 * object, so nanobot could assert any identity. This module closes that gap
 * without shared state, new tables, timers, or database access:
 *
 * - Express mints the token from `req.user` (the authenticated session, the
 *   single source of truth) via `POST /api/nanobot/token` (see `./router.js`).
 * - The token embeds a minimal authorization snapshot
 *   `{ uid, email, status, admin, roles, exp }` and an HMAC-SHA256 signature keyed by
 *   the server-side `NANOBOT_MCP_TOKEN` secret (env only, never logged).
 * - The MCP server verifies the signature + expiry and rebuilds the user
 *   internally. Any `user` argument supplied by nanobot is ignored entirely,
 *   so selecting, impersonating, or overriding the application user is
 *   impossible at the MCP boundary.
 *
 * Snapshot staleness is bounded by a short TTL (10 minutes) — strictly tighter
 * than the application's own 30-day session cookies. Token theft is scoped to
 * the two read-only allowlisted tools and the same TTL window.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAdminUser } from '../auth/admin.js';

export const NANOBOT_TOKEN_PREFIX = 'nb1';
export const NANOBOT_SESSION_TTL_MS = 10 * 60 * 1000;
export const NANOBOT_MAX_SNAPSHOT_ROLES = 64;

function serviceKey() {
  const secret = String(process.env.NANOBOT_MCP_TOKEN || '');
  if (!secret) throw new Error('Nanobot service token is not configured.');
  return secret;
}

function base64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function snapshotRoles(user) {
  const seen = new Set();
  const out = [];
  for (const source of [user?.roles, user?.paidProductRoleIds]) {
    if (!Array.isArray(source)) continue;
    for (const id of source) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 0 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= NANOBOT_MAX_SNAPSHOT_ROLES) return out;
    }
  }
  return out;
}

/**
 * Mint a session token for an authenticated user object (call with `req.user`).
 * Throws for missing users and when the service secret is unconfigured.
 * `overrides` is a test seam ({ now, ttlMs }); production passes nothing.
 */
export function mintSessionToken(user, overrides = {}) {
  if (!user || user.id === undefined || user.id === null || String(user.id) === '') {
    throw new Error('Cannot mint a nanobot token without an authenticated user.');
  }
  const key = serviceKey();
  const now = Number.isInteger(overrides.now) ? overrides.now : Date.now();
  const ttl = Number.isInteger(overrides.ttlMs) ? overrides.ttlMs : NANOBOT_SESSION_TTL_MS;
  const role = typeof user.app_role === 'string' && user.app_role
    ? user.app_role
    : (typeof user.appRole === 'string' && user.appRole ? user.appRole : null);
  const payload = {
    v: 1,
    uid: String(user.id),
    email: typeof user.email === 'string' ? user.email : '',
    status: typeof user.status === 'string' ? user.status : '',
    admin: isAdminUser(user),
    role: role || (isAdminUser(user) ? 'ADMIN' : 'USER'),
    roles: snapshotRoles(user),
    exp: now + Math.max(1000, ttl)
  };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const sig = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${NANOBOT_TOKEN_PREFIX}.${encoded}.${sig}`;
}

/**
 * Verify a session token. Returns the reconstructed user
 * (`{ id, email, status, app_role, roles }`) or null when invalid/expired/forged.
 * Never throws on attacker input; never touches the network or database.
 */
export function verifySessionToken(token) {
  try {
    if (typeof token !== 'string' || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== NANOBOT_TOKEN_PREFIX) return null;
    const [, encoded, sig] = parts;
    const expected = createHmac('sha256', serviceKey()).update(encoded).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(base64urlDecode(encoded));
    if (!payload || payload.v !== 1) return null;
    if (typeof payload.uid !== 'string' || !payload.uid) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= Date.now()) return null;
    const role = typeof payload.role === 'string' && payload.role
      ? payload.role
      : (payload.admin === true ? 'ADMIN' : 'USER');
    return {
      id: payload.uid,
      email: typeof payload.email === 'string' ? payload.email : '',
      status: typeof payload.status === 'string' ? payload.status : '',
      app_role: role,
      roles: Array.isArray(payload.roles) ? payload.roles.filter(n => Number.isInteger(n)) : []
    };
  } catch {
    return null;
  }
}
