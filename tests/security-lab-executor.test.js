import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURITY_LAB_EXECUTABLE_TOOLS,
  buildSecurityLabArgv,
  checkSecurityLabToolStatus,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import {
  isSecurityLabExecutionAllowed,
  getSecurityLabTool
} from '../src/security-lab/tool-registry.js';

test('Security Lab tool registry: 11 executable tools, nuclei and trufflehog blocked', () => {
  assert.equal(SECURITY_LAB_EXECUTABLE_TOOLS.length, 11);
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('gitleaks'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('trivy'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('httpx'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('binwalk'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('subfinder'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('theharvester'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('amass'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('testssl'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('wafw00f'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('gobuster'));
  assert.ok(SECURITY_LAB_EXECUTABLE_TOOLS.includes('dirsearch'));

  // Ensure blocked tools stay disabled in the registry
  assert.equal(isSecurityLabExecutionAllowed('nuclei'), false);
  assert.equal(isSecurityLabExecutionAllowed('trufflehog'), false);
  assert.equal(getSecurityLabTool('nuclei').executionAllowed, false);
  assert.equal(getSecurityLabTool('trufflehog').executionAllowed, false);
});

test('Amass v1 policy enforcement: MUST use passive enumeration', () => {
  const domain = 'example.com';
  const argv = buildSecurityLabArgv('amass', { domain });
  assert.deepEqual(argv, ['enum', '-passive', '-d', 'example.com']);
  assert.ok(argv.includes('-passive'), 'Amass argv must contain -passive');
  assert.ok(!argv.includes('-active'), 'Amass argv must not expose active mode');
  assert.ok(!argv.includes('-brute'), 'Amass argv must not expose brute force');
});

test('Security Lab tool adapters: buildSecurityLabArgv produces strictly bounded argv for all 11 tools', () => {
  assert.deepEqual(buildSecurityLabArgv('gitleaks', { scanPath: 'queries' }), ['dir', 'queries', '--no-banner', '--no-color', '--redact']);
  assert.deepEqual(buildSecurityLabArgv('trivy', { scanPath: 'queries' }), ['fs', '--quiet', '--no-progress', 'queries']);
  assert.deepEqual(buildSecurityLabArgv('httpx', { target: 'example.com' }), ['-u', 'example.com', '-silent', '-no-color', '-disable-update-check', '-timeout', '10']);
  assert.deepEqual(buildSecurityLabArgv('binwalk', { scanPath: 'queries' }), ['queries']);
  assert.deepEqual(buildSecurityLabArgv('subfinder', { domain: 'example.com' }), ['-d', 'example.com', '-silent', '-nc', '-duc']);
  assert.deepEqual(buildSecurityLabArgv('theharvester', { domain: 'example.com' }), ['-d', 'example.com', '-b', 'crtsh,certspotter']);
  assert.deepEqual(buildSecurityLabArgv('amass', { domain: 'example.com' }), ['enum', '-passive', '-d', 'example.com']);
  assert.deepEqual(buildSecurityLabArgv('testssl', { target: 'example.com' }), ['example.com']);
  assert.deepEqual(buildSecurityLabArgv('wafw00f', { target: 'example.com' }), ['example.com']);
  assert.deepEqual(buildSecurityLabArgv('gobuster', { targetUrl: 'http://example.com', wordlistPath: 'wordlists/common.txt' }), ['dir', '-u', 'http://example.com', '-w', 'wordlists/common.txt', '-t', '10', '-q', '--no-error', '--timeout', '10s']);
  assert.deepEqual(buildSecurityLabArgv('dirsearch', { targetUrl: 'http://example.com' }), ['-u', 'http://example.com', '-t', '20']);
});

test('Security Lab executor: rejects blocked and unknown tools via strict gate', async () => {
  const resultNuclei = await runSecurityLabTool({ toolId: 'nuclei', input: { target: 'example.com' } });
  assert.equal(resultNuclei.ok, false);
  assert.equal(resultNuclei.status, 'blocked');
  assert.equal(resultNuclei.reason, 'unknown-tool');

  const resultTruffle = await runSecurityLabTool({ toolId: 'trufflehog', input: { scanPath: 'queries' } });
  assert.equal(resultTruffle.ok, false);
  assert.equal(resultTruffle.status, 'blocked');
  assert.equal(resultTruffle.reason, 'unknown-tool');

  const resultUnknown = await runSecurityLabTool({ toolId: 'unknown-tool', input: {} });
  assert.equal(resultUnknown.ok, false);
  assert.equal(resultUnknown.status, 'blocked');
});

test('Security Lab executor: product path runSecurityLabTool verifies real system binary status for all 11 tools', async () => {
  const adminCtx = { user: { app_role: 'ADMIN' }, isAdmin: true };
  const deps = { root: process.cwd() };

  const inputs = {
    gitleaks: { path: 'queries' },
    trivy: { path: 'queries' },
    binwalk: { path: 'queries' },
    httpx: { target: 'example.com' },
    testssl: { target: 'example.com' },
    wafw00f: { target: 'example.com' },
    gobuster: { target: 'example.com' },
    dirsearch: { target: 'example.com' },
    subfinder: { domain: 'example.com' },
    theharvester: { domain: 'example.com' },
    amass: { domain: 'example.com' }
  };

  for (const toolId of SECURITY_LAB_EXECUTABLE_TOOLS) {
    const res = await runSecurityLabTool({ toolId, input: inputs[toolId] }, adminCtx, deps);
    // Real system execution without binary installation returns normalized not-installed response
    assert.equal(res.ok, false);
    assert.equal(res.status, 'not-installed');
    assert.equal(res.reason, 'not-installed');
    assert.equal(res.message, 'This tool is not installed on the server.');
  }
});
