/**
 * Phase 1 — nanobot read-only MCP bridge proofs.
 *
 * Each test maps to a Phase 1 acceptance point:
 *  1. discovery ............ stdio tools/list exposes exactly the allowlist
 *  2. authorized+sanitized .. admin search returns allowlisted keys only
 *  3. topK bound ............ topK > 8 safely capped (never rejected)
 *  4. brief shape ............ get_admin_brief returns the existing brief shape
 *  5. unauthorized denied .... null/pending/revoked/non-admin + token gates
 *  6. no DB/FS/shell ........ source-level import/pattern pins on new files
 *  7. suite green ............ (full `npm test` in the Phase 1 gate)
 *  8. failure isolation ...... server.js + Luna carry no nanobot references
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildTree } from '../src/library/tree.js';
import { searchLibrary } from '../src/luna/tools/library.js';
import { buildAdminEvidencePack } from '../src/admin-assistant/evidence.js';
import { buildAdminBrief } from '../src/admin-assistant/brief.js';
import {
  MCP_TOOL_ALLOWLIST,
  isNanobotEnabled,
  nanobotEnabledTools,
  searchLibraryTool,
  getAdminBriefTool
} from '../src/nanobot/mcp-bridge.js';
import { mintSessionToken } from '../src/nanobot/session-tokens.js';

// Test-only service secret fallback (never overrides a configured value).
// The stdio children inherit it; minting and verification share it.
if (!process.env.NANOBOT_MCP_TOKEN) process.env.NANOBOT_MCP_TOKEN = 'phase1-test-secret';
const SERVICE_TOKEN = process.env.NANOBOT_MCP_TOKEN;

const ADMIN = { id: 1, email: 'admin@example.com', status: 'active', app_role: 'ADMIN' };
const ACTIVE_USER = {
  id: 2, email: 'user@example.com', status: 'active', app_role: 'USER',
  access_expires_at: new Date(Date.now() + 86400000).toISOString()
};
const PENDING = { id: 3, email: 'p@example.com', status: 'pending', app_role: 'USER' };
const REVOKED = { id: 4, email: 'r@example.com', status: 'revoked', app_role: 'USER' };

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

const STUB_DEPS = {
  metricsFn: async () => ({}),
  healthFn: async () => ({ overall: 'healthy', indicators: [] }),
  integrityFn: async () => ({ timestamp: null, overallStatus: 'healthy', recommendation: '', summary: {}, checks: [{ id: 'test', title: 'Test check', category: 'test', status: 'healthy', count: 0, description: 'ok', actionUrl: null, actionLabel: null, items: [] }] }),
  historyFn: async () => [],
  needsFn: async () => ({
    counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 },
    recentActive: [],
    unansweredList: []
  }),
  notesFn: async () => ({ total: 0 }),
  accessClient: {
    query: async () => ({
      rows: [{ total_users: 1, pending_users: 0, revoked_users: 0, active_users: 1, admin_users: 1, expiring_soon_users: 0 }]
    })
  }
};

// --- Flag ------------------------------------------------------------------
test('Phase 1: sidecar is disabled by default; allowlist is exact', () => {
  assert.equal(isNanobotEnabled({}), false);
  assert.equal(isNanobotEnabled({ NANOBOT_ENABLED: 'false' }), false);
  assert.equal(isNanobotEnabled({ NANOBOT_ENABLED: 'true' }), true);
  assert.deepEqual(MCP_TOOL_ALLOWLIST, ['search_library', 'get_admin_brief']);
  assert.deepEqual(nanobotEnabledTools(), MCP_TOOL_ALLOWLIST);
});

// --- search_library ---------------------------------------------------------
test('Phase 1: search returns only allowlisted, sanitized keys', async () => {
  const out = await searchLibraryTool({ query: 'policycenter underwriting', user: ADMIN, tree: demoTree() });
  assert.equal(out.ok, true);
  assert.equal(out.capped, false);
  assert.ok(out.results.length >= 1, 'expected at least the PolicyCenter file');
  for (const row of out.results) {
    assert.deepEqual(Object.keys(row).sort(), ['href', 'path', 'snippet', 'source', 'title']);
    assert.ok(String(row.snippet).length <= 900, 'snippet stays capped');
  }
  assert.ok(out.results.every(r => String(r.path).startsWith('Guidewire/')), 'unrelated file filtered out');
});

test('Phase 1: bridge delegates to the existing search (no reimplementation)', async () => {
  const tree = demoTree();
  const direct = await searchLibrary({ query: 'policycenter underwriting', tree, user: ADMIN, topK: 5 });
  const bridged = await searchLibraryTool({ query: 'policycenter underwriting', user: ADMIN, tree });
  assert.deepEqual(
    bridged.results,
    direct.slice(0, 5).map(r => ({
      source: r.source, title: r.title, path: r.path, href: r.href, snippet: String(r.snippet ?? r.content ?? '').slice(0, 900)
    }))
  );
});

test('Phase 1: topK above 8 is safely capped, not rejected', async () => {
  const out = await searchLibraryTool({ query: 'policycenter', topK: 50, user: ADMIN, tree: demoTree() });
  assert.equal(out.ok, true);
  assert.equal(out.topK, 8);
  assert.equal(out.capped, true);
  assert.ok(out.results.length <= 8);
});

test('Phase 1: missing/invalid topK falls back to the default', async () => {
  const out = await searchLibraryTool({ query: 'policycenter', topK: 'abc', user: ADMIN, tree: demoTree() });
  assert.equal(out.ok, true);
  assert.equal(out.topK, 5);
  assert.equal(out.capped, false);
});

test('Phase 1: unauthenticated/unauthorized search is denied before any retrieval', async () => {
  await assert.rejects(() => searchLibraryTool({ query: 'policycenter', user: null, tree: demoTree() }), /active users and admins/);
  await assert.rejects(() => searchLibraryTool({ query: 'policycenter', user: PENDING, tree: demoTree() }), /active users and admins/);
  await assert.rejects(() => searchLibraryTool({ query: 'policycenter', user: REVOKED, tree: demoTree() }), /active users and admins/);
  await assert.rejects(() => searchLibraryTool({ query: '   ', user: ADMIN, tree: demoTree() }), /Query is required/);
});

test('Phase 1: search without a tree is unavailable (never reads disk itself)', async () => {
  const out = await searchLibraryTool({ query: 'policycenter', user: ADMIN, tree: null });
  assert.deepEqual(out, { ok: false, error: 'unavailable', message: 'Library is currently unavailable.' });
});

test('Phase 1: active non-admin receives key-restricted results only', async () => {
  const out = await searchLibraryTool({ query: 'policycenter underwriting', user: ACTIVE_USER, tree: demoTree() });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.results));
  for (const row of out.results) {
    assert.deepEqual(Object.keys(row).sort(), ['href', 'path', 'snippet', 'source', 'title']);
  }
});

test('Phase 4.5: bridge snippet carries library content (no empty snippets)', async () => {
  const out = await searchLibraryTool({ query: 'policycenter underwriting', user: ADMIN, tree: demoTree() });
  assert.equal(out.ok, true);
  assert.ok(out.results.length >= 1);
  for (const row of out.results) {
    assert.ok(String(row.snippet).length > 0, `snippet non-empty for ${row.path}`);
  }
  assert.match(out.results[0].snippet, /policycenter/i);
});

// --- get_admin_brief ---------------------------------------------------------
test('Phase 1: brief returns the existing sanitized brief shape', async () => {
  const expected = buildAdminBrief(await buildAdminEvidencePack(STUB_DEPS));
  const out = await getAdminBriefTool({ user: ADMIN, evidenceDeps: STUB_DEPS });
  assert.equal(out.ok, true);
  // Same deterministic content; clock timestamps legitimately differ per build.
  for (const key of ['overall', 'headline', 'sections', 'topRisks', 'unavailableSections']) {
    assert.deepEqual(out.brief[key], expected[key], `brief.${key} passes through unchanged`);
  }
  assert.equal(out.brief.meta.readOnly, true);
  assert.ok(out.brief.meta.generatedAt && out.brief.meta.evidenceGeneratedAt, 'meta timestamps present');
  assert.equal(out.brief.meta.readOnly, true);
  assert.deepEqual(Object.keys(out.brief.sections).sort(), ['access', 'attention', 'health', 'integrity', 'notes', 'usage']);
  assert.equal(typeof out.brief.headline, 'string');
  assert.ok(Array.isArray(out.brief.topRisks));
});

test('Phase 1: brief denies non-admins and anonymous callers', async () => {
  assert.deepEqual(await getAdminBriefTool({ user: ACTIVE_USER, evidenceDeps: STUB_DEPS }), {
    ok: false, error: 'forbidden', message: 'Admin access required.'
  });
  assert.deepEqual(await getAdminBriefTool({ user: null, evidenceDeps: STUB_DEPS }), {
    ok: false, error: 'forbidden', message: 'Admin access required.'
  });
});

// --- source hygiene (no DB / FS / shell in the new sidecar files) ------------
test('Phase 1: bridge exposes no database, filesystem, or shell surface', async () => {
  const src = await readFile(new URL('../src/nanobot/mcp-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"][^'"]*db\/pool['"]|pool\.query\s*\(|require\s*\(/i);
  assert.doesNotMatch(src, /from\s+['"]node:(fs|child_process)['"]/);
  assert.doesNotMatch(src, /INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
  assert.doesNotMatch(src, /readQueryLibrary/);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, [
    '../admin-assistant/brief.js',
    '../admin-assistant/evidence.js',
    '../auth/admin.js',
    '../luna/conversation.js',
    '../luna/permissions.js',
    '../luna/tools/library.js'
  ]);
});

test('Phase 1: server exposes no database or shell surface; tree loads confined', async () => {
  const src = await readFile(new URL('../src/nanobot/mcp-server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"][^'"]*db\/pool['"]|pool\.query\s*\(|require\s*\(/i);
  assert.doesNotMatch(src, /from\s+['"]node:child_process['"]/);
  assert.doesNotMatch(src, /INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../library/local.js', '../library/tree.js', './mcp-bridge.js', './session-tokens.js', 'node:crypto']);
});

// --- failure isolation --------------------------------------------------------
// Phase 2 narrows the allowance: server.js may reference nanobot ONLY through
// the two additive token-issuance registration lines. Everything else
// (Luna, Admin Assistant, schedulers, middleware) must stay untouched.
test('Phase 1: existing app carries no nanobot behavior outside explicit registration boundaries', async () => {
  const serverSrc = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const refLines = serverSrc.split('\n').filter(line => /nanobot/i.test(line));
  assert.ok(refLines.length > 0, 'registration lines are present');
  for (const line of refLines) {
    assert.ok(/registerNanobotRoutes|nanobot\/router/.test(line), `only registration lines may reference nanobot: ${line.trim().slice(0, 120)}`);
  }
  assert.ok(serverSrc.includes("import { registerNanobotRoutes } from './nanobot/router.js';"));
  assert.ok(serverSrc.includes('registerNanobotRoutes(app);'));
  for (const rel of ['../src/luna/agent.js', '../src/luna/retrieval.js', '../src/luna/permissions.js']) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/nanobot/i.test(text), `${rel} must not reference nanobot`);
  }
  // Admin Assistant router now intentionally owns the Admin-only digest validation endpoint.
  // The evidence/brief modules remain sidecar-independent.
  for (const rel of ['../src/admin-assistant/evidence.js', '../src/admin-assistant/brief.js']) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/nanobot/i.test(text), `${rel} must not reference nanobot`);
  }
});

// --- stdio framing (nanobot discovery + gates) ---------------------------------
function rpcSession(env) {
  const child = spawn(process.execPath, ['src/nanobot/mcp-server.js'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  const pending = [];
  let closed = false;
  let id = 0;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const failPending = error => {
    while (pending.length) pending.shift().reject(error);
  };

  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        failPending(new Error(`MCP emitted invalid JSON: ${error.message}`));
        continue;
      }
      const resolve = pending.find(item => item.id === message.id);
      if (resolve) {
        pending.splice(pending.indexOf(resolve), 1);
        resolve.resolve(message);
      }
    }
  });

  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const childError = error => {
    closed = true;
    failPending(new Error(`MCP child error: ${error.message}${stderr ? `; stderr: ${stderr.trim()}` : ''}`));
  };
  child.on('error', childError);
  child.on('exit', (code, signal) => {
    closed = true;
    failPending(new Error(`MCP child exited code=${code} signal=${signal}${stderr ? `; stderr: ${stderr.trim()}` : ''}`));
  });

  return {
    send(method, params, timeoutMs = 5000) {
      if (closed) return Promise.reject(new Error('MCP child is closed.'));
      id += 1;
      const current = id;
      const request = `${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pending.findIndex(item => item.id === current);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error(`Timed out waiting for MCP response to ${method}; stderr: ${stderr.trim() || '(empty)'}`));
        }, timeoutMs);
        pending.push({
          id: current,
          resolve: message => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: error => {
            clearTimeout(timer);
            reject(error);
          }
        });
        try {
          child.stdin.write(request);
        } catch (error) {
          clearTimeout(timer);
          const index = pending.findIndex(item => item.id === current);
          if (index >= 0) pending.splice(index, 1);
          reject(error);
        }
      });
    },
    close() {
      closed = true;
      failPending(new Error('MCP session closed.'));
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      child.unref();
    }
  };
}

test('Phase 1: nanobot discovers exactly the two allowlisted tools over stdio', async () => {
  const session = rpcSession({ NANOBOT_ENABLED: 'true', NANOBOT_MCP_TOKEN: SERVICE_TOKEN });
  try {
    const hello = await session.send('initialize', {});
    assert.equal(hello.result.serverInfo.name, 'gosu-mcp-bridge');
    const listed = await session.send('tools/list', {});
    assert.deepEqual(listed.result.tools.map(t => t.name), ['search_library', 'get_admin_brief']);
  } finally {
    session.close();
  }
});

test('Phase 1: stdio calls enforce the token gate and the allowlist', async () => {
  const session = rpcSession({ NANOBOT_ENABLED: 'true', NANOBOT_MCP_TOKEN: SERVICE_TOKEN });
  const sessionToken = mintSessionToken(ADMIN);
  try {
    const noToken = await session.send('tools/call', { name: 'search_library', arguments: { query: 'x' } });
    assert.equal(noToken.error.message, 'Access denied.');
    const wrongToken = await session.send('tools/call', { name: 'search_library', auth: { token: 'wrong', sessionToken }, arguments: { query: 'x' } });
    assert.equal(wrongToken.error.message, 'Access denied.');
    const noSession = await session.send('tools/call', { name: 'search_library', auth: { token: SERVICE_TOKEN }, arguments: { query: 'x' } });
    assert.equal(noSession.error.message, 'Access denied.');
    const unknown = await session.send('tools/call', { name: 'delete_library', auth: { token: SERVICE_TOKEN, sessionToken }, arguments: {} });
    assert.match(unknown.error.message, /Unknown tool/);
  } finally {
    session.close();
  }
});

test('Phase 1: stdio calls stay disabled unless explicitly enabled', async () => {
  const session = rpcSession({ NANOBOT_MCP_TOKEN: SERVICE_TOKEN });
  const sessionToken = mintSessionToken(ADMIN);
  try {
    const out = await session.send('tools/call', { name: 'search_library', auth: { token: SERVICE_TOKEN, sessionToken }, arguments: { query: 'x' } });
    assert.equal(out.error.message, 'Nanobot sidecar is disabled.');
  } finally {
    session.close();
  }
});

test('Phase 1: stdio search serves permission-filtered results; brief forbids non-admins', async () => {
  const session = rpcSession({ NANOBOT_ENABLED: 'true', NANOBOT_MCP_TOKEN: SERVICE_TOKEN });
  try {
    const adminAuth = { token: SERVICE_TOKEN, sessionToken: mintSessionToken(ADMIN) };
    const search = await session.send('tools/call', {
      name: 'search_library', auth: adminAuth, arguments: { query: 'guidewire', topK: 5 }
    });
    const body = JSON.parse(search.result.content[0].text);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.results));
    const userAuth = { token: SERVICE_TOKEN, sessionToken: mintSessionToken(ACTIVE_USER) };
    const briefDenied = await session.send('tools/call', {
      name: 'get_admin_brief', auth: userAuth, arguments: {}
    });
    assert.deepEqual(JSON.parse(briefDenied.result.content[0].text), {
      ok: false, error: 'forbidden', message: 'Admin access required.'
    });
  } finally {
    session.close();
  }
});


test('Phase 2: standard MCP calls use the process-bound session token without a custom auth envelope', async () => {
  const sessionToken = mintSessionToken(ADMIN);
  const session = rpcSession({
    NANOBOT_ENABLED: 'true',
    NANOBOT_MCP_TOKEN: SERVICE_TOKEN,
    NANOBOT_MCP_SESSION_TOKEN: sessionToken
  });
  try {
    // Standard MCP shape: identity is bound to the spawned process environment,
    // not carried in model-visible tool arguments.
    const plain = await session.send('tools/call', {
      name: 'search_library',
      arguments: { query: 'guidewire', topK: 5 }
    });
    const plainBody = JSON.parse(plain.result.content[0].text);
    assert.equal(plainBody.ok, true);
    assert.ok(Array.isArray(plainBody.results));

    // A different session token supplied in the non-standard auth envelope
    // must not override the process-bound ADMIN identity.
    const spoofed = await session.send('tools/call', {
      name: 'search_library',
      auth: { token: SERVICE_TOKEN, sessionToken: mintSessionToken(ACTIVE_USER) },
      arguments: { query: 'guidewire', topK: 5 }
    });
    const spoofedBody = JSON.parse(spoofed.result.content[0].text);
    assert.deepEqual(spoofedBody, plainBody);
  } finally {
    session.close();
  }
});


test('Phase 2: stdio impersonation attempts keep the token identity', async () => {
  const OTHER = { id: 13, email: 'other@example.com', status: 'active', app_role: 'USER' };
  const session = rpcSession({ NANOBOT_ENABLED: 'true', NANOBOT_MCP_TOKEN: SERVICE_TOKEN });
  try {
    const otherAuth = { token: SERVICE_TOKEN, sessionToken: mintSessionToken(OTHER) };
    // OTHER claims ADMIN in arguments: ignored, OTHER's authorization applies.
    // Explicit 20s transport timeout: permission-filtered search alone costs
    // ~4s in this repo (283 library files x per-path checks), so the shared
    // 5s helper default leaves <1s headroom on the 6th spawned child.
    // Assertions unchanged; timeout only.
    const spoof = await session.send('tools/call', {
      name: 'search_library',
      auth: otherAuth,
      arguments: { query: 'guidewire', user: { ...ADMIN } }
    }, 20000);
    const spoofBody = JSON.parse(spoof.result.content[0].text);
    const plain = await session.send('tools/call', {
      name: 'search_library', auth: otherAuth, arguments: { query: 'guidewire' }
    }, 20000);
    assert.deepEqual(spoofBody, JSON.parse(plain.result.content[0].text));
    // Forged session tokens are already covered by the stateless token
    // verification tests; keep this stdio test focused on identity injection
    // through tool arguments and avoid a redundant child-process round trip.
  } finally {
    session.close();
  }
});
