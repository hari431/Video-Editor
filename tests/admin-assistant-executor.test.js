import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXECUTOR_CAPS, executePlannedAction } from '../src/admin-assistant/executor.js';

const STATUSES = new Set(['planned', 'blocked', 'unavailable', 'executed']);

function capabilityFor(id) {
  return {
    id,
    label: `${id} label`,
    description: `${id} description`,
    category: id.split('.')[0],
    requires: { admin: true },
    flags: { readOnly: true, needsLiveEvidence: true, longRunning: false },
    evidenceSection: id.split('.')[0],
    adminUrl: '/admin'
  };
}

function finding(id, title, section, url) {
  return {
    id,
    severity: 'attention',
    level: 'warning',
    title,
    detail: `${title} detail`,
    evidenceRefs: [{ section, label: `${title} evidence`, url }]
  };
}

function briefFixture() {
  return {
    meta: { generatedAt: '2026-10-07T00:00:00.000Z', readOnly: true, evidenceGeneratedAt: '2026-10-07T00:00:00.000Z' },
    overall: 'attention',
    headline: 'Attention needed: 2 pending access request(s)',
    sections: {
      access: { status: 'attention', summary: 'Access: 2 pending.', findings: [finding('access:pending', 'Pending queue', 'access', '/admin#users')] },
      attention: { status: 'healthy', summary: 'Discussions: 0 unanswered.', findings: [] },
      health: { status: 'healthy', summary: 'Runtime health overall: healthy.', findings: [] },
      integrity: { status: 'attention', summary: 'Integrity: warning across 2 checks.', findings: [finding('integrity:orphan', 'Orphan product', 'integrity', '/admin/paid-products')] },
      usage: { status: 'healthy', summary: 'Usage history: 3 day(s) available.', findings: [] },
      notes: { status: 'healthy', summary: 'Learner notes: 5 note(s).', findings: [] }
    },
    topRisks: [
      { id: 'access:pending', title: 'Pending queue', level: 'warning', evidenceRefs: [{ section: 'access', label: 'Admin users table', url: '/admin#users' }] }
    ],
    unavailableSections: []
  };
}

function ctxFor(capabilityId, unavailableSections = []) {
  return { isAdmin: true, capability: capabilityFor(capabilityId), unavailableSections };
}

test('executor: all 5 declared plans execute bounded read-only results', () => {
  const cases = [
    ['access.review-queue', 'access.overview', 'Access: 2 pending.'],
    ['attention.triage', 'attention.discussions', 'Discussions: 0 unanswered.'],
    ['health.snapshot', 'health.runtime', 'Runtime health overall: healthy.'],
    ['integrity.reconcile', 'integrity.diagnostics', 'Integrity: warning across 2 checks.'],
    ['brief.compose', 'access.overview', 'Attention needed: 2 pending access request(s)']
  ];
  for (const [actionId, capabilityId, summary] of cases) {
    const result = executePlannedAction({ actionId }, ctxFor(capabilityId), { brief: briefFixture() });
    assert.equal(result.ok, true, actionId);
    assert.equal(result.status, 'executed', actionId);
    assert.equal(result.actionId, actionId, actionId);
    assert.equal(result.summary, summary, actionId);
    assert.ok(Array.isArray(result.findings), actionId);
    assert.ok(Array.isArray(result.evidenceRefs), actionId);
    assert.deepEqual(result.checks, [
      { check: 'authorization', passed: true },
      { check: 'capability', passed: true },
      { check: 'evidence', passed: true }
    ], actionId);
    for (const ref of result.evidenceRefs) {
      assert.ok(!ref.url || ref.url.startsWith('/admin'), `${actionId} leaks non-admin url`);
    }
    assert.ok(JSON.stringify(result).length < 8000, `${actionId} unbounded`);
  }
});

test('executor: authorization fails closed and never reaches handlers', () => {
  const sources = { brief: briefFixture() };
  for (const context of [null, undefined, {}, { isAdmin: false }, { isAdmin: 'yes' }]) {
    const result = executePlannedAction({ actionId: 'health.snapshot' }, context, sources);
    assert.equal(result.status, 'blocked', JSON.stringify(context));
    assert.equal(result.reason, 'unauthorized', JSON.stringify(context));
    assert.equal(result.ok, false);
  }
});

test('executor: resolution is registry-only, never caller-defined', () => {
  const sources = { brief: briefFixture() };
  // Capability ids are not action ids and must not resolve.
  for (const actionId of ['access.overview', 'no.such-plan', '../actions', '', 'ACCESS.REVIEW-QUEUE']) {
    const result = executePlannedAction({ actionId }, ctxFor('access.overview'), sources);
    assert.equal(result.status, 'unavailable', actionId);
    assert.ok(['unknown-action', 'invalid-request'].includes(result.reason), result.reason);
    assert.equal(result.ok, false);
  }
  // There is no plan input: extra fields fail closed instead of executing.
  for (const request of [
    { actionId: 'health.snapshot', command: 'x' },
    { actionId: 'health.snapshot', plan: { status: 'planned' } },
    { actionId: 'health.snapshot', brief: briefFixture() }
  ]) {
    const result = executePlannedAction(request, ctxFor('health.runtime'), sources);
    assert.equal(result.status, 'unavailable', JSON.stringify(Object.keys(request)));
    assert.equal(result.reason, 'invalid-request');
  }
});

test('executor: evidence failures block, including data missing behind context claims', () => {
  // Contract-level: context reports the section unavailable.
  const declared = executePlannedAction(
    { actionId: 'integrity.reconcile' },
    ctxFor('integrity.diagnostics', ['integrity']),
    { brief: briefFixture() }
  );
  assert.equal(declared.status, 'blocked');
  assert.equal(declared.reason, 'evidence-unavailable');

  // Defense in depth: context claims available but the brief data is absent.
  const brief = briefFixture();
  delete brief.sections.integrity;
  const absent = executePlannedAction(
    { actionId: 'integrity.reconcile' },
    ctxFor('integrity.diagnostics'),
    { brief }
  );
  assert.equal(absent.status, 'blocked');
  assert.equal(absent.reason, 'evidence-unavailable');

  // Section present but marked unavailable in the brief itself.
  const marked = briefFixture();
  marked.sections.access = { status: 'unavailable', summary: 'Access overview unavailable.', findings: [] };
  marked.unavailableSections = ['access'];
  const flagged = executePlannedAction(
    { actionId: 'access.review-queue' },
    ctxFor('access.overview'),
    { brief: marked }
  );
  assert.equal(flagged.status, 'blocked');
  assert.equal(flagged.reason, 'evidence-unavailable');

  // Missing sources entirely fail closed without throwing.
  for (const sources of [null, undefined, {}, { brief: null }, 'brief']) {
    let result;
    assert.doesNotThrow(() => {
      result = executePlannedAction({ actionId: 'health.snapshot' }, ctxFor('health.runtime'), sources);
    });
    assert.equal(result.status, 'blocked', JSON.stringify(sources)?.slice(0, 40));
    assert.equal(result.reason, 'evidence-unavailable');
  }
});

test('executor: malformed requests fail closed without throwing or leaking', () => {
  const sources = { brief: briefFixture() };
  const ctx = ctxFor('health.runtime');
  const hostile = [null, undefined, 42, 'health.snapshot', [], {}, { actionId: null }, { actionId: '' }];
  for (const request of hostile) {
    let result;
    assert.doesNotThrow(() => {
      result = executePlannedAction(request, ctx, sources);
    });
    assert.ok(result && typeof result === 'object');
    assert.equal(result.ok, false);
    assert.ok(STATUSES.has(result.status));
    assert.ok(!('summary' in result) || typeof result.summary === 'string');
    assert.doesNotMatch(JSON.stringify(result), /at Object|at file|Error: |stack/i);
  }
});

test('executor: adversarial brief data stays bounded and admin-url-only', () => {
  const hostileRefs = Array.from({ length: 30 }, (_, i) => ({
    section: 'integrity',
    label: `Ref ${i} ` + 'L'.repeat(500),
    url: i % 3 === 0 ? 'https://evil.example/x' : i % 3 === 1 ? 'javascript:alert(1)' : '/admin/system#integrity',
    checkId: `check-${i}`
  }));
  const brief = briefFixture();
  brief.sections.integrity.findings = Array.from({ length: 40 }, (_, i) => ({
    id: `integrity:check-${i}`,
    severity: 'attention',
    level: i % 2 ? 'CRITICAL' : 'warning',
    title: `Finding ${i} ` + 'T'.repeat(2000),
    detail: 'D'.repeat(2000),
    evidenceRefs: hostileRefs
  }));
  const result = executePlannedAction(
    { actionId: 'integrity.reconcile' },
    ctxFor('integrity.diagnostics'),
    { brief }
  );
  assert.equal(result.status, 'executed');
  assert.ok(result.findings.length <= EXECUTOR_CAPS.MAX_FINDINGS, `findings: ${result.findings.length}`);
  assert.ok(result.evidenceRefs.length <= EXECUTOR_CAPS.MAX_EVIDENCE_REFS, `refs: ${result.evidenceRefs.length}`);
  const serialized = JSON.stringify(result);
  // Honest worst-case bound: 6 findings × (title/id + 12 refs × ~600 chars) +
  // 12 deduplicated top-level refs. Truncation (asserted below) keeps every
  // run bounded; this asserts the total cannot grow with input size.
  assert.ok(serialized.length < 60000, `executed too large: ${serialized.length}`);
  assert.doesNotMatch(serialized, /T{201,}|L{122,}|D{201,}/);
  assert.doesNotMatch(serialized, /evil\.example|javascript:/i);
  for (const ref of result.evidenceRefs) {
    assert.ok(!ref.url || ref.url.startsWith('/admin'));
  }
  for (const f of result.findings) {
    assert.ok(['critical', 'warning', 'info'].includes(f.level), f.level);
  }
  // Output size is independent of input size: 10× more findings changes nothing.
  const bigger = briefFixture();
  bigger.sections.integrity.findings = Array.from({ length: 400 }, (_, i) => ({
    id: `integrity:check-${i}`,
    severity: 'attention',
    level: i % 2 ? 'CRITICAL' : 'warning',
    title: `Finding ${i} ` + 'T'.repeat(2000),
    detail: 'D'.repeat(2000),
    evidenceRefs: hostileRefs
  }));
  const rerun = executePlannedAction(
    { actionId: 'integrity.reconcile' },
    ctxFor('integrity.diagnostics'),
    { brief: bigger }
  );
  assert.deepEqual(rerun, result);
});

test('executor: failure is isolated per action and inputs are never mutated', () => {
  // One broken section degrades only its own action; the rest still execute.
  const brief = briefFixture();
  brief.sections.attention = { status: 'healthy' };
  const snapshot = JSON.stringify(brief);
  const triage = executePlannedAction({ actionId: 'attention.triage' }, ctxFor('attention.discussions'), { brief });
  assert.equal(triage.status, 'blocked');
  assert.equal(triage.reason, 'evidence-unavailable');
  for (const [actionId, capabilityId] of [['health.snapshot', 'health.runtime'], ['access.review-queue', 'access.overview']]) {
    const result = executePlannedAction({ actionId }, ctxFor(capabilityId), { brief });
    assert.equal(result.status, 'executed', actionId);
  }
  assert.equal(JSON.stringify(brief), snapshot, 'executor mutated its input');

  // Hostile data that throws on access becomes a generic failure, not a leak.
  const throwing = briefFixture();
  Object.defineProperty(throwing, 'sections', {
    get() {
      throw new Error('store exploded: secret-stack');
    }
  });
  const failed = executePlannedAction({ actionId: 'health.snapshot' }, ctxFor('health.runtime'), { brief: throwing });
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.reason, 'execution-failed');
  assert.doesNotMatch(JSON.stringify(failed), /exploded|secret-stack|at Object/i);
});

test('executor: module imports only the trusted registry and exposes no execution surface (source boundary)', async () => {
  const source = await readFile(new URL('../src/admin-assistant/executor.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s.+?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./actions.js']);
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /child_process|execSync|\bexec\(|\bspawn\(|execFile|fork\(|shell/i);
  assert.doesNotMatch(code, /\bsudo\b|docker|privileged|nmap|sqlmap|masscan|wireshark/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout|SELECT|INSERT|UPDATE|DELETE\b/i);
  assert.doesNotMatch(code, /\beval\(|new Function\(|require\(/);
});
