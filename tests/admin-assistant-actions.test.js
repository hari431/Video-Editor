import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTION_CAPS,
  ACTION_EVIDENCE_SECTIONS,
  listPlannedActions,
  getPlannedAction,
  validateActionRequest
} from '../src/admin-assistant/actions.js';

const STATUSES = new Set(['planned', 'blocked', 'unavailable']);

// Mirrors the Step 1 capability record shape (plain data, no imports).
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

function adminContext(capabilityId, unavailableSections = []) {
  return { isAdmin: true, capability: capabilityFor(capabilityId), unavailableSections };
}

test('contract: registry declares bounded read-only plans with evidence gates', () => {
  const all = listPlannedActions();
  assert.ok(all.length > 0 && all.length <= ACTION_CAPS.MAX_ACTIONS);
  const ids = new Set();
  for (const entry of all) {
    assert.ok(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= ACTION_CAPS.MAX_ID_CHARS);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0 && entry.label.length <= ACTION_CAPS.MAX_LABEL_CHARS);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0 && entry.description.length <= ACTION_CAPS.MAX_DESCRIPTION_CHARS);
    assert.ok(typeof entry.capabilityId === 'string' && entry.capabilityId.length > 0);
    assert.ok(Array.isArray(entry.requiredEvidenceSections) && entry.requiredEvidenceSections.length > 0);
    assert.ok(entry.requiredEvidenceSections.length <= ACTION_CAPS.MAX_EVIDENCE_SECTIONS);
    for (const section of entry.requiredEvidenceSections) {
      assert.ok(ACTION_EVIDENCE_SECTIONS.includes(section), `${entry.id} requires unknown section ${section}`);
    }
    // Plans declare no side effects and carry no execution surface.
    assert.equal(entry.sideEffects, false);
    for (const key of ['command', 'shell', 'script', 'exec', 'args', 'url', 'sudo', 'docker', 'runCommands']) {
      assert.equal(Object.hasOwn(entry, key), false, `${entry.id} exposes ${key}`);
    }
  }
});

test('contract: list/get return isolated clones in deterministic order', () => {
  const first = listPlannedActions();
  const second = listPlannedActions();
  assert.deepEqual(first, second);
  first[0].label = 'mutated';
  first[0].requiredEvidenceSections.push('notes');
  assert.notDeepEqual(listPlannedActions()[0], first[0]);

  const found = getPlannedAction('attention.triage');
  assert.ok(found);
  assert.equal(found.capabilityId, 'attention.discussions');
  found.label = 'mutated';
  assert.notEqual(getPlannedAction('attention.triage').label, 'mutated');
  for (const bad of [null, undefined, 42, '', 'missing.plan']) {
    assert.equal(getPlannedAction(bad), null);
  }
});

test('contract: valid admin request with available evidence yields planned (never executable)', () => {
  const result = validateActionRequest(
    { actionId: 'attention.triage' },
    adminContext('attention.discussions')
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'planned');
  assert.equal(result.action.id, 'attention.triage');
  assert.equal(result.action.sideEffects, false);
  assert.deepEqual(result.checks, [
    { check: 'authorization', passed: true },
    { check: 'capability', passed: true },
    { check: 'evidence', passed: true }
  ]);
  assert.ok(typeof result.note === 'string' && /no execution/i.test(result.note));
  assert.ok(JSON.stringify(result).length < 4000, 'contract result must stay bounded');
});

test('contract: authorization is checked before existence (no id oracle)', () => {
  for (const context of [null, undefined, {}, { isAdmin: false }, { isAdmin: 'yes' }, { isAdmin: 1 }]) {
    const known = validateActionRequest({ actionId: 'attention.triage' }, context);
    assert.equal(known.status, 'blocked', JSON.stringify(context));
    assert.equal(known.reason, 'unauthorized', JSON.stringify(context));
    // Unknown ids report the same gate to non-admins: existence is not disclosed.
    const unknown = validateActionRequest({ actionId: 'no.such-plan' }, context);
    assert.equal(unknown.status, 'blocked', JSON.stringify(context));
    assert.equal(unknown.reason, 'unauthorized', JSON.stringify(context));
  }
  // Admins do learn about unknown ids — as unavailable, never blocked.
  const adminUnknown = validateActionRequest({ actionId: 'no.such-plan' }, adminContext('attention.discussions'));
  assert.equal(adminUnknown.status, 'unavailable');
  assert.equal(adminUnknown.reason, 'unknown-action');
});

test('contract: capability gate fails closed on mismatch or weakened capability', () => {
  const ctx = adminContext('attention.discussions');
  const good = validateActionRequest({ actionId: 'attention.triage' }, ctx);
  assert.equal(good.status, 'planned');

  const cases = [
    ['missing capability', { ...ctx, capability: null }],
    ['non-object capability', { ...ctx, capability: 'attention.discussions' }],
    ['wrong capability id', { ...ctx, capability: capabilityFor('health.runtime') }],
    ['non-admin capability', { ...ctx, capability: { ...capabilityFor('attention.discussions'), requires: { admin: false } } }],
    ['writable capability', { ...ctx, capability: { ...capabilityFor('attention.discussions'), flags: { readOnly: false, needsLiveEvidence: true, longRunning: false } } }]
  ];
  for (const [name, context] of cases) {
    const result = validateActionRequest({ actionId: 'attention.triage' }, context);
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.reason, 'capability-mismatch', name);
    assert.deepEqual(result.checks, [
      { check: 'authorization', passed: true },
      { check: 'capability', passed: false },
      { check: 'evidence', passed: false }
    ], name);
  }
});

test('contract: unavailable evidence blocks, including multi-section plans', () => {
  const single = validateActionRequest(
    { actionId: 'integrity.reconcile' },
    adminContext('integrity.diagnostics', ['integrity'])
  );
  assert.equal(single.status, 'blocked');
  assert.equal(single.reason, 'evidence-unavailable');

  // brief.compose requires every section: one missing section blocks the plan.
  const multi = validateActionRequest(
    { actionId: 'brief.compose' },
    adminContext('access.overview', ['notes'])
  );
  assert.equal(multi.status, 'blocked');
  assert.equal(multi.reason, 'evidence-unavailable');

  // Unknown section names are ignored, not treated as unavailable.
  const unknownSections = validateActionRequest(
    { actionId: 'health.snapshot' },
    adminContext('health.runtime', ['sudo-exec', 42, null])
  );
  assert.equal(unknownSections.status, 'planned');

  // Non-array unavailableSections degrades to "all available", never throws.
  const malformedSections = validateActionRequest(
    { actionId: 'health.snapshot' },
    { isAdmin: true, capability: capabilityFor('health.runtime'), unavailableSections: 'health' }
  );
  assert.equal(malformedSections.status, 'planned');
});

test('contract: untrusted request shapes fail closed without throwing', () => {
  const ctx = adminContext('attention.discussions');
  const hostile = [
    null,
    undefined,
    'attention.triage',
    42,
    true,
    [],
    {},
    { actionId: null },
    { actionId: 42 },
    { actionId: '' },
    { actionId: '   ' },
    { actionId: 'x'.repeat(ACTION_CAPS.MAX_ID_CHARS + 1) },
    { actionId: 'attention.triage', command: 'nmap -sV x' },
    { actionId: 'attention.triage', shell: 'bash -lc x' },
    { actionId: 'attention.triage', url: 'https://evil.example' },
    { actionId: 'attention.triage', sudo: true },
    { actionId: 'attention.triage', docker: 'kalilinux/kali-rolling' },
    { actionId: 'attention.triage', args: ['--batch'] },
    { actionId: 'attention.triage', note: 'benign but unexpected' },
    { wrongKey: 'attention.triage' }
  ];
  for (const request of hostile) {
    let result;
    assert.doesNotThrow(() => {
      result = validateActionRequest(request, ctx);
    }, JSON.stringify(request)?.slice(0, 80));
    assert.ok(result && typeof result === 'object', JSON.stringify(request)?.slice(0, 80));
    assert.equal(result.ok, false, JSON.stringify(request)?.slice(0, 80));
    assert.equal(result.status, 'unavailable', JSON.stringify(request)?.slice(0, 80));
    assert.ok(['invalid-request', 'unknown-action'].includes(result.reason), result.reason);
    assert.ok(STATUSES.has(result.status));
  }
  // Whitespace-padded ids normalize; inputs are never mutated.
  const padded = { actionId: '  attention.triage  ' };
  const snapshot = JSON.stringify(padded);
  assert.equal(validateActionRequest(padded, ctx).status, 'planned');
  assert.equal(JSON.stringify(padded), snapshot);
});

test('contract: results are deterministic, bounded, and carry no executable content', () => {
  const ctx = adminContext('access.overview', ['notes']);
  const first = validateActionRequest({ actionId: 'brief.compose' }, ctx);
  const second = validateActionRequest(
    { actionId: 'brief.compose' },
    { isAdmin: true, capability: capabilityFor('access.overview'), unavailableSections: ['notes'] }
  );
  assert.deepEqual(first, second);
  assert.equal(first.status, 'blocked');
  const serialized = JSON.stringify(first);
  assert.ok(serialized.length < 4000, `contract too large: ${serialized.length}`);
  assert.doesNotMatch(serialized, /child_process|execSync|spawn|sudo|docker|bash -lc|SELECT|INSERT/i);
});

test('contract: module is dependency-free with no execution surface (source boundary)', async () => {
  const source = await readFile(new URL('../src/admin-assistant/actions.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bfrom\s+['"]/);
  assert.doesNotMatch(code, /child_process|execSync|\bexec\(|\bspawn\(|execFile|fork\(|shell/i);
  assert.doesNotMatch(code, /\bsudo\b|docker|privileged|nmap|sqlmap|masscan|wireshark/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout|SELECT|INSERT|UPDATE|DELETE\b/i);
  assert.doesNotMatch(code, /\beval\(|new Function\(/);
});
