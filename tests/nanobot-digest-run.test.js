/**
 * Phase 3 Step 2 — sidecar digest runner proofs (no scheduling/delivery).
 *
 * The runner (`src/nanobot/digest-run.js`) feeds REAL Phase 1 tool outputs
 * into the pure Step 1 composer through the Phase 2 token identity:
 *  1. real get_admin_brief output reaches the composer
 *  2. real search_library output reaches the composer
 *  3. the digest stays fully evidence-backed
 *  4. non-admin identity stays rejected from admin content
 *  5. nanobot cannot override the authenticated identity (no `user` argument)
 *  6. Phase 1 + Phase 2 suites stay green (gate step re-runs them)
 *  7. disabled sidecar causes no side effects
 *  8. no scheduler/delivery wiring was introduced (source-level pins)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTree } from '../src/library/tree.js';
import { readQueryLibrary } from '../src/library/local.js';
import { buildAdminEvidencePack } from '../src/admin-assistant/evidence.js';
import { buildAdminBrief } from '../src/admin-assistant/brief.js';
import { MCP_TOOL_ALLOWLIST } from '../src/nanobot/mcp-bridge.js';
import { mintSessionToken } from '../src/nanobot/session-tokens.js';
import { everyItemCited, resolveEvidenceRef } from '../src/nanobot/digest.js';
import { buildSidecarDigest, digestRunnerTools } from '../src/nanobot/digest-run.js';

if (!process.env.NANOBOT_MCP_TOKEN) process.env.NANOBOT_MCP_TOKEN = 'phase3-step2-secret';
process.env.NANOBOT_ENABLED = 'true';

const ADMIN = { id: 21, email: 'admin@example.com', status: 'active', app_role: 'ADMIN' };
const USER = {
  id: 22, email: 'user@example.com', status: 'active', app_role: 'USER',
  access_expires_at: new Date(Date.now() + 86400000).toISOString()
};

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

// Deterministic healthy evidence (same contract as the existing evidence tests).
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
      rows: [{ total_users: 4, pending_users: 2, revoked_users: 0, active_users: 2, admin_users: 1, expiring_soon_users: 1 }]
    })
  }
};

// --- 1. real brief reaches the composer ---------------------------------------
test('Phase 3.2.1: real get_admin_brief output reaches the composer', async () => {
  // Deterministic wiring proof against stubbed healthy evidence…
  const wired = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: 'policycenter underwriting',
    tree: demoTree(),
    evidenceDeps: STUB_DEPS
  });
  assert.equal(wired.ok, true);
  assert.equal(wired.sources.brief, 'ok');
  const expectedBrief = buildAdminBrief(await buildAdminEvidencePack(STUB_DEPS));
  assert.ok(wired.digest.items.some(i => String(i.id).startsWith('brief:access:')), 'brief findings surface as digest items');
  assert.equal(wired.digest.fullyCited, true);
  void expectedBrief;

  // …and the real default evidence path executes end-to-end (offline-degraded
  // sections stay structured; failure isolation is the existing behavior).
  const real = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: '',
    tree: demoTree()
  });
  assert.equal(real.ok, true);
  assert.equal(real.sources.brief, 'ok');
  assert.equal(typeof real.digest.headline, 'string');
  assert.ok(Array.isArray(real.digest.items));
});

// --- 2. real search reaches the composer ---------------------------------------
test('Phase 3.2.2: real search_library output reaches the composer', async () => {
  const out = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: 'policycenter underwriting',
    tree: demoTree(),
    evidenceDeps: STUB_DEPS
  });
  assert.equal(out.ok, true);
  assert.equal(out.sources.search, 'ok');
  const supporting = out.digest.supportingEvidence.find(r => r.path === 'Guidewire/PolicyCenter Basics.txt');
  assert.ok(supporting, 'search row surfaces as supporting context');
  assert.ok(String(supporting.snippet).length > 0, 'supporting snippet carries content');
  assert.ok(out.digest.items.every(i => !String(i.id).startsWith('search:')), 'no automatic search items');

  // Real confined library scan (existing reader, no new filesystem surface).
  const scanned = await readQueryLibrary();
  const { buildTree: rebuild } = await import('../src/library/tree.js');
  const realTree = rebuild(scanned.files, scanned.videos, scanned.folders, scanned.items || []);
  const live = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: 'guidewire',
    tree: realTree,
    evidenceDeps: STUB_DEPS
  });
  assert.equal(live.ok, true);
  assert.ok(['ok', 'empty'].includes(live.sources.search));
  assert.ok(Array.isArray(live.digest.items));
});

// --- 3. fully evidence-backed ---------------------------------------------------
test('Phase 3.2.3: digest remains fully evidence-backed', async () => {
  const out = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: 'policycenter underwriting',
    tree: demoTree(),
    evidenceDeps: STUB_DEPS
  });
  assert.equal(out.digest.fullyCited, true);
  const brief = buildAdminBrief(await buildAdminEvidencePack(STUB_DEPS));
  const rows = [
    { title: 'PolicyCenter Basics.txt', path: 'Guidewire/PolicyCenter Basics.txt', snippet: 'PolicyCenter underwriting workflow for commercial lines policycenter administration.' },
    { title: 'Pasta Notes.txt', path: 'Cooking/Pasta Notes.txt', snippet: 'Boil water add salt cook pasta al dente olive oil.' }
  ];
  assert.equal(everyItemCited(brief, rows, out.digest.items), true);
  for (const item of out.digest.items) {
    for (const ref of item.evidenceRefs) {
      assert.ok(resolveEvidenceRef(brief, rows, ref) !== null);
    }
  }
});

// --- 4. non-admin stays rejected -------------------------------------------------
test('Phase 3.2.4: unauthorized/non-admin identity remains rejected', async () => {
  assert.deepEqual(await buildSidecarDigest({ sessionToken: 'nb1.forged.invalid' }), {
    ok: false, error: 'forbidden', message: 'Access denied.'
  });
  const out = await buildSidecarDigest({
    sessionToken: mintSessionToken(USER),
    query: 'policycenter underwriting',
    tree: demoTree(),
    evidenceDeps: STUB_DEPS
  });
  assert.equal(out.ok, true);
  assert.equal(out.sources.brief, 'forbidden');
  assert.ok(out.digest.items.every(i => !String(i.id).startsWith('brief:')), 'no admin items for non-admins');
});

// --- 5. identity override impossible -----------------------------------------------
test('Phase 3.2.5: nanobot cannot override the authenticated identity', async () => {
  const userToken = mintSessionToken(USER);
  const base = await buildSidecarDigest({
    sessionToken: userToken, query: 'policycenter', tree: demoTree(), evidenceDeps: STUB_DEPS
  });
  // There is no `user` argument: smuggled identity fields are dropped by
  // destructuring and cannot change authorization (generatedAt excluded —
  // the clock legitimately differs between the two runs).
  const smuggled = await buildSidecarDigest({
    sessionToken: userToken, query: 'policycenter', tree: demoTree(), evidenceDeps: STUB_DEPS, user: { ...ADMIN }
  });
  const withoutClock = digest => ({ ...digest, generatedAt: null });
  assert.deepEqual(withoutClock(smuggled.digest), withoutClock(base.digest));
  assert.deepEqual(smuggled.sources, base.sources);
});

// --- 7. disabled sidecar has no side effects -----------------------------------------
test('Phase 3.2.7: disabled nanobot causes no side effects', async () => {
  const saved = process.env.NANOBOT_ENABLED;
  delete process.env.NANOBOT_ENABLED;
  let evidenceTouched = 0;
  try {
    const out = await buildSidecarDigest({
      sessionToken: mintSessionToken(ADMIN),
      query: 'policycenter',
      tree: demoTree(),
      evidenceDeps: { ...STUB_DEPS, metricsFn: async () => { evidenceTouched += 1; return {}; } }
    });
    assert.deepEqual(out, { ok: false, error: 'disabled', message: 'Nanobot sidecar is disabled.' });
    assert.equal(evidenceTouched, 0, 'no evidence getter runs while disabled');
  } finally {
    if (saved === undefined) delete process.env.NANOBOT_ENABLED;
    else process.env.NANOBOT_ENABLED = saved;
  }
  process.env.NANOBOT_ENABLED = 'true';
});

test('Phase 4.5: runner excludes question sources from supporting context, retains others', async () => {
  const out = await buildSidecarDigest({
    sessionToken: mintSessionToken(ADMIN),
    query: 'policycenter underwriting',
    tree: demoTree(),
    evidenceDeps: STUB_DEPS,
    excludedPaths: new Set(['guidewire/policycenter basics.txt'])
  });
  assert.equal(out.ok, true);
  assert.ok(out.digest.supportingEvidence.every(r => String(r.path).toLowerCase() !== 'guidewire/policycenter basics.txt'));
  assert.ok(out.digest.items.every(i => String(i.id).startsWith('brief:')));
});

// --- 8. no scheduler/delivery wiring -------------------------------------------------
test('Phase 3.2.8: no scheduler or delivery wiring was introduced', async () => {
  assert.deepEqual(digestRunnerTools(), MCP_TOOL_ALLOWLIST);
  assert.deepEqual(digestRunnerTools(), ['search_library', 'get_admin_brief']);
  const src = await readFile(new URL('../src/nanobot/digest-run.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./digest.js', './mcp-bridge.js', './session-tokens.js']);
  assert.doesNotMatch(src, /setInterval|setTimeout|cron|schedule|nodemailer|SMTP|mailer/i);
  assert.doesNotMatch(src, /from\s+['"]express['"]|app\.(get|post)\(/i);
  assert.doesNotMatch(src, /from\s+['"][^'"]*db\/pool['"]|pool\.query\s*\(|require\s*\(/i);
  assert.doesNotMatch(src, /from\s+['"]node:(fs|net|child_process)['"]/);
  assert.doesNotMatch(src, /INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
});
