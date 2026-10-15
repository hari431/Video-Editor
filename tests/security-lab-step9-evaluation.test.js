/**
 * Step 9 — Evaluation record pinning: nuclei + trufflehog are intentionally
 * blocked, with documented reasons. No behavior change in this step.
 *
 * Proves the documentation is accurate and complete:
 * - the blocked record is frozen, well-shaped, and covers exactly the
 *   non-executable registry set (neither more nor fewer)
 * - both ids stay denied at every enforcement layer (registry flag, gate,
 *   adapter map, status probe, run entrypoint) with zero spawns
 * - neither id appears in the executable tool list
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURITY_LAB_BLOCKED_TOOLS,
  listSecurityLabTools,
  getSecurityLabTool,
  isSecurityLabExecutionAllowed,
  isSecurityLabToolAllowlisted
} from '../src/security-lab/tool-registry.js';
import {
  SECURITY_LAB_EXECUTABLE_TOOLS,
  buildSecurityLabArgv,
  checkSecurityLabToolStatus,
  runSecurityLabTool
} from '../src/security-lab/executor.js';

test('step9 record: frozen, well-shaped, and exactly the non-executable set', () => {
  assert.equal(Object.isFrozen(SECURITY_LAB_BLOCKED_TOOLS), true);
  assert.equal(SECURITY_LAB_BLOCKED_TOOLS.length, 2);
  const ids = [];
  for (const entry of SECURITY_LAB_BLOCKED_TOOLS) {
    assert.equal(Object.isFrozen(entry), true);
    assert.ok(typeof entry.id === 'string' && entry.id.length > 0, 'id present');
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 40, `${entry.id}: reason documents the decision`);
    assert.equal(Object.keys(entry).sort().join(','), 'id,reason', entry.id);
    assert.equal(isSecurityLabToolAllowlisted(entry.id), true, `${entry.id}: known registry id`);
    assert.equal(getSecurityLabTool(entry.id).executionAllowed, false, entry.id);
    assert.equal(isSecurityLabExecutionAllowed(entry.id), false, entry.id);
    assert.ok(!SECURITY_LAB_EXECUTABLE_TOOLS.includes(entry.id), `${entry.id}: no adapter`);
    ids.push(entry.id);
  }
  assert.deepEqual([...ids].sort(), ['nuclei', 'trufflehog']);
  const nonExecutable = listSecurityLabTools()
    .filter((tool) => tool.executionAllowed !== true)
    .map((tool) => tool.id)
    .sort();
  assert.deepEqual(nonExecutable, [...ids].sort(), 'blocked record covers exactly the non-executable set');
});

test('step9 enforcement: blocked ids denied at every layer with zero spawns', async () => {
  for (const toolId of ['nuclei', 'trufflehog']) {
    assert.equal(buildSecurityLabArgv(toolId, { target: 'example.com' }), null, toolId);
    assert.equal(buildSecurityLabArgv(toolId, { domain: 'example.com' }), null, toolId);
    assert.equal(buildSecurityLabArgv(toolId, { scanPath: 'x' }), null, toolId);

    const statusCalls = [];
    const status = await checkSecurityLabToolStatus(toolId, {
      spawnFn: async () => { statusCalls.push(1); return {}; }
    });
    assert.equal(status.status, 'unavailable', toolId);
    assert.equal(status.installed, false, toolId);
    assert.equal(status.executionAllowed, false, toolId);
    assert.equal(statusCalls.length, 0, toolId);

    for (const input of [{ target: 'example.com' }, { domain: 'example.com' }, { path: 'queries' }, {}]) {
      const calls = [];
      const result = await runSecurityLabTool({ toolId, input }, { isAdmin: true }, {
        root: process.cwd(),
        spawnFn: async () => { calls.push(1); return {}; },
        statFn: async () => ({}),
        realpathFn: async (p) => p
      });
      assert.equal(result.status, 'blocked', `${toolId} ${JSON.stringify(input)}`);
      assert.equal(result.ok, false, toolId);
      assert.equal(calls.length, 0, toolId);
    }
  }
});
