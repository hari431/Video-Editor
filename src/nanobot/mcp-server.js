/**
 * Phase 2 — nanobot MCP stdio server (local-only sidecar, disabled by default).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio. There is NO TCP port,
 * so the server is reachable only by the local process that spawns it
 * (nanobot `tools.mcpServers` stdio entry). Nothing listens on the network.
 *
 * Methods:
 *   initialize                → handshake (always answers; reveals no data)
 *   notifications/initialized → acknowledged, no reply
 *   tools/list                → exactly the bridge allowlist (discovery)
 *   tools/call                → gated: enabled, service token, session token, allowlist
 *
 * Gates on every tools/call (checked in this order):
 *   1. `NANOBOT_ENABLED=true`, otherwise `{ error: 'disabled' }`.
 *   2. Transport binding: when the spawned process carries both
 *      `NANOBOT_MCP_TOKEN` and `NANOBOT_MCP_SESSION_TOKEN` in its
 *      environment, identity is bound to that process (OS isolation) and no
 *      per-call service token is required. Otherwise `params.auth.token`
 *      must equal `NANOBOT_MCP_TOKEN` (timing-safe compare; env only, never
 *      logged; rotation is "set a new value and restart").
 *   3. The session token (environment when present, else
 *      `params.auth.sessionToken` for the legacy/test seam) must verify via
 *      `./session-tokens.js` (HMAC-bound to the Express session that minted
 *      it, 10-minute expiry). The reconstructed user is the ONLY identity
 *      used downstream.
 *   4. `params.name` must be in the bridge allowlist, otherwise rejected.
 *
 * `arguments.user` is IGNORED entirely: nanobot cannot select, impersonate,
 * or override the application user. Changing or removing caller-supplied user
 * fields cannot change authorization (pinned by tests).
 *
 * The library tree is loaded lazily on the first search_library call through
 * the existing confined reader (`readQueryLibrary` + `buildTree`) with a
 * 60s TTL. No arbitrary paths are accepted; no shell is spawned; no SQL is
 * issued here (reads flow only through the bridge's existing getters).
 */

import { timingSafeEqual } from 'node:crypto';
import { readQueryLibrary } from '../library/local.js';
import { buildTree } from '../library/tree.js';
import {
  MCP_TOOL_ALLOWLIST,
  isNanobotEnabled,
  searchLibraryTool,
  getAdminBriefTool
} from './mcp-bridge.js';
import { verifySessionToken } from './session-tokens.js';

const TREE_TTL_MS = 60_000;
let treeCache = { expiresAt: 0, tree: null };

async function getTree() {
  if (treeCache.tree && Date.now() < treeCache.expiresAt) return treeCache.tree;
  const { files, videos, folders, items = [] } = await readQueryLibrary();
  treeCache = { tree: buildTree(files, videos, folders, items), expiresAt: Date.now() + TREE_TTL_MS };
  return treeCache.tree;
}

/** Test seam: drop the cached tree between isolated runs. */
export function clearMcpTreeCache() {
  treeCache = { expiresAt: 0, tree: null };
}

function tokenMatches(provided) {
  const expected = String(process.env.NANOBOT_MCP_TOKEN || '');
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toolSchemas() {
  // Note: identity travels ONLY as params.auth.sessionToken (verified per
  // call). There is deliberately no `user` argument: any caller-supplied
  // user object is ignored by handleCall.
  return [
    {
      name: 'search_library',
      description: 'Read-only library search. Returns only content the authenticated sidecar user is authorized to access.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer', minimum: 1, maximum: 8 }
        },
        required: ['query']
      }
    },
    {
      name: 'get_admin_brief',
      description: 'Read-only sanitized admin brief. Admins only.',
      inputSchema: { type: 'object', properties: {} }
    }
  ];
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function logEvent(method, outcome) {
  // Method names + outcomes only: never user content, tokens, or evidence.
  process.stderr.write(`[nanobot-mcp] method=${method} outcome=${outcome}\n`);
}

async function handleCall(id, params) {
  const body = params && typeof params === 'object' ? params : {};
  if (!isNanobotEnabled()) {
    logEvent('tools/call', 'disabled');
    replyError(id, -32001, 'Nanobot sidecar is disabled.');
    return;
  }
  // Standard stdio MCP clients do not send a custom auth envelope. When the
  // spawned process carries a session token in its environment, that
  // environment value is the transport-bound identity (OS process isolation;
  // the token itself is never model-visible). The explicit auth envelope
  // remains only for the legacy/test JSON-RPC seam.
  const processBound = Boolean(
    String(process.env.NANOBOT_MCP_TOKEN || '').trim() &&
    String(process.env.NANOBOT_MCP_SESSION_TOKEN || '').trim()
  );
  if (!processBound && !tokenMatches(body?.auth?.token)) {
    logEvent('tools/call', 'denied');
    replyError(id, -32002, 'Access denied.');
    return;
  }
  const name = body.name;
  const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
  // Phase 2 identity: ONLY the verified session token counts. Any `user`
  // object in arguments is ignored, so caller-supplied identity can never
  // select, impersonate, or override the application user.
  // Standard nanobot MCP calls do not carry a custom auth envelope. For a
  // stdio server, bind the short-lived identity to the spawned MCP process via
  // environment. Keep the Phase 2 auth field as a test/backward-compatibility
  // seam only; when the environment value exists it is authoritative.
  const sessionToken = String(process.env.NANOBOT_MCP_SESSION_TOKEN || '').trim()
    || body?.auth?.sessionToken;
  const sessionUser = verifySessionToken(sessionToken);
  if (!sessionUser) {
    logEvent('tools/call', 'denied');
    replyError(id, -32002, 'Access denied.');
    return;
  }
  if (!MCP_TOOL_ALLOWLIST.includes(name)) {
    logEvent('tools/call', 'unknown-tool');
    replyError(id, -32601, `Unknown tool: ${String(name || '').slice(0, 80)}.`);
    return;
  }
  try {
    if (name === 'search_library') {
      const tree = await getTree();
      // Pick data fields only: callers can never inject tree/search internals,
      // and identity always comes from the verified session token above.
      const out = await searchLibraryTool({ query: args.query, topK: args.topK, user: sessionUser, tree });
      logEvent('tools/call', out.ok ? 'ok' : 'unavailable');
      reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
      return;
    }
    // Same narrowing: evidence getters stay server-chosen (defaults), never caller-supplied.
    const out = await getAdminBriefTool({ user: sessionUser });
    logEvent('tools/call', out.ok ? 'ok' : 'forbidden');
    reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
  } catch (error) {
    // Auth failures and validation errors surface as denied/invalid, never internals.
    const message = String(error?.message || 'Request failed.');
    const code = /required|length|available only/i.test(message) ? -32003 : -32602;
    logEvent('tools/call', code === -32003 ? 'denied' : 'invalid');
    replyError(id, code, message.slice(0, 300));
  }
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id !== undefined) replyError(msg.id, -32600, 'Invalid request.');
    return;
  }
  switch (msg.method) {
    case 'initialize':
      reply(msg.id ?? null, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gosu-mcp-bridge', version: '0.1.0-phase1' }
      });
      break;
    case 'notifications/initialized':
      break;
    case 'tools/list':
      reply(msg.id ?? null, { tools: toolSchemas() });
      break;
    case 'tools/call':
      await handleCall(msg.id ?? null, msg.params);
      break;
    default:
      replyError(msg.id ?? null, -32601, `Unknown method: ${msg.method.slice(0, 80)}.`);
      break;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'Parse error.');
      continue;
    }
    handleMessage(msg).catch(() => replyError(msg?.id ?? null, -32603, 'Internal error.'));
  }
});
