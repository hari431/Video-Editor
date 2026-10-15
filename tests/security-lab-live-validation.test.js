/**
 * Step 4 — Controlled real-tool validation (no installs, no scope expansion).
 *
 * Strategy: probe for the three binaries with short timeouts and report
 * versions/status. Cases that need a binary run ONLY where it exists;
 * elsewhere they log a skip line and return. Nothing is installed, no new
 * tool is enabled, and input scope is unchanged (the product path gate is
 * never bypassed — tmpdir fixtures exercise the adapter argv white-box,
 * never `runSecurityLabTool`).
 *
 * Harmless by construction:
 * - Version checks are local-only (`gitleaks version`, `trivy version`,
 *   `httpx -version`).
 * - The gitleaks fixture uses a documented fake example key in an isolated
 *   temp dir, scanned with the exact product argv (which includes
 *   `--redact`), then deleted.
 * - Trivy filesystem validation uses `--offline-scan` so no vulnerability
 *   database is downloaded.
 * - httpx response probing is deliberately NOT exercised: there is no
 *   allowlisted target scope yet, and loopback is rejected by design.
 * - Timeout is proven with a local `node` sleep through the real spawn
 *   wrapper (test-only; `node` is not an executable tool).
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import {
  SECURITY_LAB_EXEC_CAPS,
  buildSecurityLabArgv,
  defaultSecurityLabSpawn,
  runSecurityLabTool
} from '../src/security-lab/executor.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_CTX = { isAdmin: true };

async function probe(binary, argv) {
  try {
    const result = await defaultSecurityLabSpawn(binary, argv, { timeoutMs: 15000, maxBytes: 65536 });
    if (result.notInstalled) return { installed: false };
    const firstLine = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').find((line) => line.trim()) || '';
    return { installed: true, exitCode: result.exitCode, version: firstLine.trim().slice(0, 120) };
  } catch {
    return { installed: false };
  }
}

const STATUS = {};

test.before(async () => {
  STATUS.gitleaks = await probe('gitleaks', ['version']);
  STATUS.trivy = await probe('trivy', ['version']);
  STATUS.httpx = await probe('httpx', ['-version']);
  STATUS.binwalk = await probe('binwalk', ['--help']);
  STATUS.subfinder = await probe('subfinder', ['-version']);
  STATUS.theharvester = await probe('theHarvester', ['-h']);
  STATUS.amass = await probe('amass', ['-h']);
  STATUS.testssl = await probe('testssl.sh', ['--help']);
  STATUS.wafw00f = await probe('wafw00f', ['--help']);
  STATUS.gobuster = await probe('gobuster', ['--version']);
  STATUS.dirsearch = await probe('dirsearch', ['--help']);
  console.log(`[security-lab-live] status=${JSON.stringify(STATUS)}`);
});

function skipIfMissing(name) {
  if (!STATUS[name]?.installed) {
    console.log(`[security-lab-live] skip ${name}: binary not installed (no installs per Step 4)`);
    return true;
  }
  return false;
}

test('live: absent binaries normalize to not-installed through the full product path', async () => {
  const cases = [
    ['gitleaks', { path: 'queries' }],
    ['trivy', { path: 'queries' }],
    ['httpx', { target: 'example.com' }],
    ['binwalk', { path: 'queries' }],
    ['subfinder', { domain: 'example.com' }],
    ['theharvester', { domain: 'example.com' }],
    ['amass', { domain: 'example.com' }],
    ['testssl', { target: 'example.com' }],
    ['wafw00f', { target: 'example.com' }],
    ['gobuster', { target: 'example.com' }],
    ['dirsearch', { target: 'example.com' }]
  ];
  for (const [toolId, input] of cases) {
    if (STATUS[toolId]?.installed) continue;
    const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, { root: PROJECT_ROOT, timeoutMs: 15000 });
    assert.equal(result.status, 'not-installed', toolId);
    assert.equal(result.ok, false, toolId);
    assert.equal(result.message, 'This tool is not installed on the server.', toolId);
    assert.equal(result.stdout, '', toolId);
    assert.equal(result.stderr, '', toolId);
  }
});

test('live: gitleaks exit codes handled (0 clean, 1 findings) with secrets redacted', async () => {
  if (skipIfMissing('gitleaks')) return;
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seclab-gitleaks-'));
  try {
    // Documented fake example key (matches the built-in AWS rule shape).
    const canary = 'AKIAIOSFODNN7EXAMPLE';
    await fs.writeFile(path.join(fixtureDir, 'leaky.txt'), `api_key = "${canary}"\n`);
    const argv = buildSecurityLabArgv('gitleaks', { scanPath: fixtureDir });
    assert.deepEqual(argv, ['dir', fixtureDir, '--no-banner', '--no-color', '--redact']);
    const leaky = await defaultSecurityLabSpawn('gitleaks', argv, { timeoutMs: 30000, maxBytes: 1_000_000 });
    assert.equal(leaky.timedOut, false);
    assert.equal(leaky.notInstalled, false);
    assert.equal(leaky.exitCode, 1, 'gitleaks exits 1 when leaks are found');
    assert.ok(!`${leaky.stdout}${leaky.stderr}`.includes(canary), 'raw secret must not appear in redacted output');

    await fs.writeFile(path.join(fixtureDir, 'leaky.txt'), 'nothing secret here\n');
    const clean = await defaultSecurityLabSpawn('gitleaks', argv, { timeoutMs: 30000, maxBytes: 1_000_000 });
    assert.equal(clean.exitCode, 0, 'gitleaks exits 0 when no leaks are present');
    assert.ok(clean.stdout.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS + 1_000_000);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('live: trivy version is local-only; offline fs scan normalizes without downloads', async () => {
  if (skipIfMissing('trivy')) return;
  const version = await defaultSecurityLabSpawn('trivy', ['version'], { timeoutMs: 15000, maxBytes: 65536 });
  assert.equal(version.notInstalled, false);
  assert.equal(version.exitCode, 0);
  assert.ok(version.stdout.length > 0 && version.stdout.length <= 65536);

  // Offline mode: no DB download; expects fast failure (no DB) or success (DB present).
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seclab-trivy-'));
  try {
    await fs.writeFile(path.join(fixtureDir, 'note.txt'), 'hello\n');
    const offline = await defaultSecurityLabSpawn(
      'trivy',
      ['fs', '--quiet', '--no-progress', '--offline-scan', fixtureDir],
      { timeoutMs: 60000, maxBytes: 1_000_000 }
    );
    assert.equal(offline.notInstalled, false);
    assert.equal(offline.timedOut, false);
    assert.ok(Number.isInteger(offline.exitCode), 'exit code must be an integer');
    assert.ok(offline.stdout.length + offline.stderr.length <= 2_000_000, 'output bounded by maxBuffer');
    console.log(`[security-lab-live] trivy offline fs exit=${offline.exitCode} out=${offline.stdout.length} err=${offline.stderr.length}`);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('live: httpx version is local-only; response probing stays out of scope', async () => {
  if (skipIfMissing('httpx')) return;
  const version = await defaultSecurityLabSpawn('httpx', ['-version'], { timeoutMs: 15000, maxBytes: 65536 });
  assert.equal(version.notInstalled, false);
  assert.equal(version.exitCode, 0);
  assert.ok(version.stdout.length + version.stderr.length > 0, 'version output present');
  assert.ok(version.stdout.length + version.stderr.length <= 65536, 'version output bounded');
  // No probe is sent: loopback is rejected by the validator and no external
  // target scope has been approved. Response handling is explicitly unverified.
  console.log('[security-lab-live] httpx response handling NOT exercised (no approved target scope)');
});

test('live: process timeout is enforced by the real spawn wrapper', async () => {
  const started = Date.now();
  const result = await defaultSecurityLabSpawn('node', ['-e', 'setTimeout(() => {}, 30000)'], {
    timeoutMs: 1000,
    maxBytes: 65536
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.notInstalled, false);
  assert.ok(Date.now() - started < 15000, 'kill must arrive well before the 30s sleep');
});
