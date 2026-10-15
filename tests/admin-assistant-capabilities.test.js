import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CAPABILITY_CAPS,
  CAPABILITY_CATEGORIES,
  listAdminCapabilities,
  getAdminCapability,
  searchAdminCapabilities,
  preflightAdminCapabilities
} from '../src/admin-assistant/capabilities.js';

test('registry: declares id/label/description/category with safe read-only shape', () => {
  const all = listAdminCapabilities();
  assert.equal(all.length, 6);
  const ids = new Set();
  for (const entry of all) {
    assert.ok(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= CAPABILITY_CAPS.MAX_ID_CHARS);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0 && entry.label.length <= CAPABILITY_CAPS.MAX_LABEL_CHARS);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0 && entry.description.length <= CAPABILITY_CAPS.MAX_DESCRIPTION_CHARS);
    assert.ok(CAPABILITY_CATEGORIES.includes(entry.category), entry.id);
    assert.deepEqual(entry.requires, { admin: true });
    assert.equal(entry.flags.readOnly, true);
    assert.equal(entry.flags.longRunning, false);
    assert.ok(typeof entry.evidenceSection === 'string' && entry.evidenceSection);
    assert.ok(typeof entry.adminUrl === 'string' && entry.adminUrl.startsWith('/admin'), entry.id);
    // No execution surface of any kind.
    assert.equal(Object.hasOwn(entry, 'runCommands'), false);
    assert.equal(Object.hasOwn(entry, 'installCommands'), false);
    assert.equal(Object.hasOwn(entry.flags, 'requiresSudo'), false);
    assert.equal(Object.hasOwn(entry.flags, 'privileged'), false);
  }
});

test('registry: list returns isolated clones in deterministic order', () => {
  const first = listAdminCapabilities();
  const second = listAdminCapabilities();
  assert.deepEqual(first, second);
  first[0].label = 'mutated';
  first[0].requires.admin = false;
  const third = listAdminCapabilities();
  assert.notEqual(third[0].label, 'mutated');
  assert.equal(third[0].requires.admin, true);
});

test('registry: get by exact id returns clone or null', () => {
  const found = getAdminCapability('integrity.diagnostics');
  assert.ok(found);
  assert.equal(found.category, 'integrity');
  found.label = 'mutated';
  assert.notEqual(getAdminCapability('integrity.diagnostics').label, 'mutated');
  for (const bad of [null, undefined, 123, '', 'INTEGRITY.DIAGNOSTICS', 'missing.id']) {
    assert.equal(getAdminCapability(bad), null);
  }
});

test('registry: search filters by q/category/flags with AND semantics and bounds', () => {
  const byQ = searchAdminCapabilities({ q: 'integrity' });
  assert.equal(byQ.count, 1);
  assert.equal(byQ.capabilities[0].id, 'integrity.diagnostics');

  const byCategory = searchAdminCapabilities({ category: 'usage' });
  assert.equal(byCategory.count, 1);
  assert.equal(byCategory.capabilities[0].id, 'usage.history');

  const combined = searchAdminCapabilities({ q: 'read-only', category: 'notes' });
  assert.equal(combined.count, 1);
  assert.equal(combined.capabilities[0].id, 'notes.summary');

  const miss = searchAdminCapabilities({ q: 'integrity', category: 'usage' });
  assert.equal(miss.count, 0);
  assert.deepEqual(miss.capabilities, []);

  const empty = searchAdminCapabilities({});
  assert.equal(empty.count, 6);

  // Case-insensitive, whitespace-tolerant, oversized q truncated without throwing.
  const noisy = searchAdminCapabilities({ q: '  RUNTIME  ' });
  assert.equal(noisy.count, 1);
  assert.equal(noisy.capabilities[0].id, 'health.runtime');
  const huge = searchAdminCapabilities({ q: `x${'y'.repeat(5000)}`, limit: 99 });
  assert.ok(huge.count <= CAPABILITY_CAPS.MAX_RESULTS);

  // Limit clamping: 1..MAX_RESULTS, non-numeric falls back to max.
  assert.equal(searchAdminCapabilities({ limit: 2 }).capabilities.length, 2);
  assert.equal(searchAdminCapabilities({ limit: 0 }).capabilities.length, 1);
  assert.equal(searchAdminCapabilities({ limit: 'nope' }).capabilities.length, 6);

  // Malformed options degrade safely.
  assert.equal(searchAdminCapabilities(null).count, 6);
  assert.equal(searchAdminCapabilities('q').count, 6);
});

test('registry: preflight reports ready|partial|blocked deterministically', () => {
  const ready = preflightAdminCapabilities({});
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.unavailable, []);
  assert.equal(ready.available.length, 6);
  assert.deepEqual(ready.recommendations, []);

  const partial = preflightAdminCapabilities({ unavailableSections: ['integrity', 'notes'] });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.unavailable, ['integrity', 'notes']);
  assert.equal(partial.recommendations.length, 1);
  assert.equal(partial.recommendations[0].priority, 'high');

  const blocked = preflightAdminCapabilities({ unavailableSections: [...CAPABILITY_CATEGORIES] });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.available, []);
  assert.equal(blocked.recommendations[0].priority, 'critical');

  // Unknown names ignored, duplicates collapsed, malformed input degrades to ready.
  const cleaned = preflightAdminCapabilities({ unavailableSections: ['integrity', 'sudo-exec', 'integrity', 123] });
  assert.deepEqual(cleaned.unavailable, ['integrity']);
  assert.equal(cleaned.status, 'partial');
  for (const bad of [null, 'x', 42, { unavailableSections: 'integrity' }]) {
    assert.equal(preflightAdminCapabilities(bad).status, 'ready');
  }

  // Deterministic across clones.
  assert.deepEqual(
    preflightAdminCapabilities({ unavailableSections: ['health'] }),
    preflightAdminCapabilities({ unavailableSections: ['health'] })
  );
});

test('registry: module is dependency-free with no execution surface (source boundary)', async () => {
  const source = await readFile(new URL('../src/admin-assistant/capabilities.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bfrom\s+['"]/);
  assert.doesNotMatch(code, /child_process|exec\(|execSync|spawn\(|execFile|fork\(|shell/i);
  assert.doesNotMatch(code, /\bsudo\b|docker|privileged|nmap|sqlmap|masscan|wireshark/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout|SELECT|INSERT|UPDATE|DELETE\b/i);
});
