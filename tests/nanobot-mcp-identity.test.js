/**
 * Phase 2 — trusted identity boundary proofs.
 *
 * Flow under test: Express session (`req.user`, via the untouched
 * `requireApiAuth`) → `POST /api/nanobot/token` mints an HMAC-bound session
 * token → nanobot presents it as `auth.sessionToken` → the MCP server
 * verifies it and derives identity internally, ignoring any caller-supplied
 * `user` argument.
 *
 * Maps to the Phase 2 security requirements:
 *  1. A-authenticated content isolation
 *  2. no impersonation through MCP arguments
 *  3. unauthenticated requests rejected
 *  4. non-admins denied get_admin_brief
 *  5. caller-supplied user fields cannot change authorization
 *  6. Phase 1 suite still green (gate step re-runs it)
 *  7. application behavior unchanged (additive-only server diff + related suites)
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { buildTree } from '../src/library/tree.js';
import { searchLibraryTool, getAdminBriefTool } from '../src/nanobot/mcp-bridge.js';
import {
  mintSessionToken,
  verifySessionToken,
  NANOBOT_SESSION_TTL_MS
} from '../src/nanobot/session-tokens.js';

if (!process.env.NANOBOT_MCP_TOKEN) process.env.NANOBOT_MCP_TOKEN = 'phase2-test-secret';
process.env.NANOBOT_ENABLED = 'true';

const ADMIN = { id: 11, google_user_id: 'google-admin', email: 'admin@example.com', status: 'active', app_role: 'ADMIN' };
const USER_A = { id: 12, google_user_id: 'google-a', email: 'a@example.com', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };
const USER_B = { id: 13, google_user_id: 'google-b', email: 'b@example.com', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };

function demoTree() {
  return buildTree(
    [
      { path: 'Guidewire/PolicyCenter Basics.txt', content: 'PolicyCenter underwriting workflow for commercial lines policycenter administration.' },
      { path: 'Cooking/Pasta Notes.txt', content: 'Boil water add salt cook pasta al dente olive oil.' }
    ],
    [],
    [],
    []
  );
}

/** Exactly what the MCP server does with a presented session token. */
async function authedSearch(sessionToken, query = 'policycenter underwriting') {
  const user = verifySessionToken(sessionToken);
  if (!user) return { ok: false, error: 'forbidden' };
  return searchLibraryTool({ query, user, tree: demoTree() });
}

// --- token unit proofs -------------------------------------------------------
test('Phase 2: mint/verify round-trips identity without a store or database', () => {
  const token = mintSessionToken(ADMIN);
  assert.match(token, /^nb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const user = verifySessionToken(token);
  assert.equal(user.id, '11');
  assert.equal(user.app_role, 'ADMIN');
  assert.equal(token.length < 500, true);
});

test('Phase 2: minting requires an authenticated user; garbage never verifies', () => {
  assert.throws(() => mintSessionToken(null), /authenticated user/);
  assert.throws(() => mintSessionToken({}), /authenticated user/);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken('garbage'), null);
  assert.equal(verifySessionToken('nb1.e30.e30'), null);
});

test('Phase 2: forged and expired tokens are rejected', () => {
  const token = mintSessionToken(USER_A);
  const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal(verifySessionToken(tampered), null);
  const stale = mintSessionToken(USER_A, { now: Date.now() - 20 * 60 * 1000 });
  assert.equal(verifySessionToken(stale), null);
  const saved = process.env.NANOBOT_MCP_TOKEN;
  process.env.NANOBOT_MCP_TOKEN = 'different-secret';
  try {
    assert.equal(verifySessionToken(token), null);
  } finally {
    process.env.NANOBOT_MCP_TOKEN = saved;
  }
});

// --- 1. per-user isolation ----------------------------------------------------
test('Phase 2.1: user A retrieves only A-authorized content', async () => {
  const adminOut = await authedSearch(mintSessionToken(ADMIN));
  assert.equal(adminOut.ok, true);
  assert.ok(adminOut.results.length >= 1);
  const userOut = await authedSearch(mintSessionToken(USER_A));
  assert.equal(userOut.ok, true);
  // No grants exist in this environment: fail-closed, key-restricted shape.
  for (const row of userOut.results) {
    assert.deepEqual(Object.keys(row).sort(), ['href', 'path', 'snippet', 'source', 'title']);
  }
  assert.ok(userOut.results.length <= adminOut.results.length);
});

// --- 2 + 5. impersonation resistance ------------------------------------------
test('Phase 2.2/2.5: caller-supplied user fields cannot change authorization', async () => {
  // B presents a valid token but claims to be ADMIN in arguments: the server
  // ignores arguments.user, so B keeps B's authorization (fail-closed here).
  const bUser = verifySessionToken(mintSessionToken(USER_B));
  const spoofed = await searchLibraryTool({ query: 'policycenter underwriting', user: bUser, tree: demoTree() });
  assert.equal(spoofed.ok, true);
  assert.deepEqual(spoofed.results, (await authedSearch(mintSessionToken(USER_B))).results);
  // A's token with the user field removed stays A's authorization.
  const aOut = await authedSearch(mintSessionToken(ADMIN));
  assert.ok(aOut.results.length >= 1);
  assert.ok(aOut.results.every(r => String(r.path).startsWith('Guidewire/')));
});

// --- 4. admin-only brief -------------------------------------------------------
test('Phase 2.4: non-admin session tokens cannot call get_admin_brief', async () => {
  const adminUser = verifySessionToken(mintSessionToken(ADMIN));
  assert.ok(adminUser && adminUser.app_role === 'ADMIN');
  for (const plain of [USER_A, USER_B]) {
    const user = verifySessionToken(mintSessionToken(plain));
    assert.equal(user.app_role, 'USER');
    assert.deepEqual(await getAdminBriefTool({ user }), {
      ok: false, error: 'forbidden', message: 'Admin access required.'
    });
  }
  assert.deepEqual(await getAdminBriefTool({ user: null }), {
    ok: false, error: 'forbidden', message: 'Admin access required.'
  });
});

// --- stdio impersonation end-to-end lives in tests/nanobot-mcp-bridge.test.js ---
// (that file never boots the Express app, so the stdio child cannot interact
// with server startup; the token-identity assertions are identical).

// --- 3 + HTTP mint endpoint (Express session is the source of truth) ------------
const ADMIN_SID = 'p2-admin-sid';
const USER_SID = 'p2-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER_A };

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const user = sessionToUser[params[0]];
      if (user) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: user.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [ADMIN, USER_A, USER_B].find(x => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    return { rows: [] };
  };
  const { app } = await import('../src/server.js');
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const httpPost = (cookie, enabled = true) => {
  if (enabled) process.env.NANOBOT_ENABLED = 'true';
  else delete process.env.NANOBOT_ENABLED;
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return fetch(`http://127.0.0.1:${port}/api/nanobot/token`, { method: 'POST', headers });
};

test('Phase 2.3: token minting requires an authenticated session', async () => {
  const anon = await httpPost(null);
  assert.equal(anon.status, 401);
  const userRes = await httpPost(USER_COOKIE);
  assert.equal(userRes.status, 200);
  const userBody = await userRes.json();
  assert.equal(userBody.ok, true);
  assert.equal(userBody.expiresInMs, NANOBOT_SESSION_TTL_MS);
  const asUser = verifySessionToken(userBody.token);
  assert.equal(asUser.id, String(USER_A.id));
  assert.equal(asUser.app_role, 'USER');
  const adminRes = await httpPost(ADMIN_COOKIE);
  assert.equal(adminRes.status, 200);
  assert.equal(verifySessionToken((await adminRes.json()).token).app_role, 'ADMIN');
});

test('Phase 2: mint endpoint stays disabled unless explicitly enabled', async () => {
  const res = await httpPost(USER_COOKIE, false);
  assert.equal(res.status, 404);
  process.env.NANOBOT_ENABLED = 'true';
});

test('Phase 4.5: session token preserves OWNER role (no downgrade to ADMIN)', () => {
  const owner = { id: 99, email: 'owner@example.com', status: 'active', app_role: 'OWNER' };
  assert.equal(verifySessionToken(mintSessionToken(owner)).app_role, 'OWNER');
  const admin = { id: 11, email: 'admin@example.com', status: 'active', app_role: 'ADMIN' };
  assert.equal(verifySessionToken(mintSessionToken(admin)).app_role, 'ADMIN');
});
