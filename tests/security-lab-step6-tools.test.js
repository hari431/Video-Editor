/**
 * Step 6 — Controlled execution for binwalk, subfinder, theharvester.
 *
 * Proves, with injected fakes unless noted:
 * - exact input schemas per tool (and cross-field rejection)
 * - exact fixed argv per tool (no user flags, no smuggling)
 * - strict domain scope (public hostnames only; no IPs, URLs, ports)
 * - scan-path confinement for binwalk (same roots as gitleaks/trivy)
 * - nuclei/trufflehog stay disabled (later steps enable other tools;
 *   this file's stays-off assertions cover only nuclei/trufflehog)
 * - timeout/output bounds, not-installed, and sanitization for new tools
 * - HTTP gates (auth already covered in Step 3; here: 422 disabled,
 *   400 invalid domain, exact-body contract holds for new schemas)
 */
import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  SECURITY_LAB_EXEC_CAPS,
  SECURITY_LAB_EXECUTABLE_TOOLS,
  validateSecurityLabDomain,
  buildSecurityLabArgv,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import { isSecurityLabExecutionAllowed } from '../src/security-lab/tool-registry.js';
import { resetSecurityLabRateLimits } from '../src/security-lab/router.js';

const FAKE_ROOT = path.resolve(process.cwd(), 'test-scan-root');
const KNOWN_PATHS = new Set([
  path.resolve(FAKE_ROOT, 'queries'),
  path.resolve(FAKE_ROOT, 'src', 'server.js')
]);
const fakeStat = async (p) => {
  if (KNOWN_PATHS.has(p)) return {};
  throw new Error('missing');
};
const fakeRealpath = async (p) => p;
const SUCCESS = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, notInstalled: false };
const ADMIN_CTX = { isAdmin: true };
const DEPS = (calls, result, extra = {}) => ({
  root: FAKE_ROOT,
  spawnFn: async (binary, argv, opts) => {
    calls.push({ binary, argv: [...argv], timeoutMs: opts?.timeoutMs });
    return { ...result };
  },
  statFn: fakeStat,
  realpathFn: fakeRealpath,
  timeoutMs: 5000,
  ...extra
});

// ---------------------------------------------------------------------------
// Registry: Step 6 tools stay enabled; Step 7/8 additions reflected.
// ---------------------------------------------------------------------------

test('step6 registry: binwalk/subfinder/theharvester enabled (plus earlier/later steps); stays-off set unchanged', () => {
  for (const id of ['binwalk', 'subfinder', 'theharvester', 'gitleaks', 'trivy', 'httpx', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch']) {
    assert.equal(isSecurityLabExecutionAllowed(id), true, id);
  }
  for (const id of ['nuclei', 'trufflehog']) {
    assert.equal(isSecurityLabExecutionAllowed(id), false, id);
  }
  assert.deepEqual(
    [...SECURITY_LAB_EXECUTABLE_TOOLS].sort(),
    ['amass', 'binwalk', 'dirsearch', 'gitleaks', 'gobuster', 'httpx', 'subfinder', 'testssl', 'theharvester', 'trivy', 'wafw00f']
  );
});

// ---------------------------------------------------------------------------
// Domain scope.
// ---------------------------------------------------------------------------

test('step6 domains: public hostnames only, normalized', () => {
  for (const domain of ['example.com', 'Sub.Example.ORG', 'example.com.', 'a-b.c-example.co']) {
    assert.equal(validateSecurityLabDomain(domain).ok, true, domain);
  }
  assert.equal(validateSecurityLabDomain('Example.COM').domain, 'example.com');
  const bad = [
    '',
    'localhost',
    'singlelabel',
    '8.8.8.8',
    '127.0.0.1',
    '::1',
    'http://example.com',
    'example.com:8080',
    'example.com/path',
    'example.com?q=1',
    'user@example.com',
    'exam ple.com',
    'example.123',
    '-bad.com',
    'bad_.com',
    'https://x',
    'example.com; rm -rf /',
    'example.com -o evil',
    '$(id).example.com',
    'example.com\ninjected',
    null,
    123,
    `a${'b'.repeat(300)}.com`
  ];
  for (const domain of bad) {
    assert.equal(validateSecurityLabDomain(domain).ok, false, String(domain));
  }
});

// ---------------------------------------------------------------------------
// Schemas + argv.
// ---------------------------------------------------------------------------

test('step6 argv: fixed arrays for the three new adapters, null otherwise', () => {
  const scanPath = path.resolve(FAKE_ROOT, 'queries');
  assert.deepEqual(buildSecurityLabArgv('binwalk', { scanPath }), [scanPath]);
  assert.deepEqual(buildSecurityLabArgv('subfinder', { domain: 'example.com' }), ['-d', 'example.com', '-silent', '-nc', '-duc']);
  assert.deepEqual(
    buildSecurityLabArgv('theharvester', { domain: 'example.com' }),
    ['-d', 'example.com', '-b', 'crtsh,certspotter']
  );
  for (const toolId of ['nuclei', 'trufflehog', 'nope']) {
    assert.equal(buildSecurityLabArgv(toolId, { domain: 'example.com' }), null, toolId);
    assert.equal(buildSecurityLabArgv(toolId, { scanPath }), null, toolId);
  }
  assert.equal(buildSecurityLabArgv('binwalk', { domain: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('subfinder', { scanPath }), null);
  assert.equal(buildSecurityLabArgv('subfinder', { target: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('theharvester', { target: 'example.com' }), null);
});

test('step6 live run: fixed argv reaches the allowlisted binary', async () => {
  const cases = [
    ['binwalk', { path: 'queries' }, 'binwalk', [path.resolve(FAKE_ROOT, 'queries')]],
    ['subfinder', { domain: 'Example.COM' }, 'subfinder', ['-d', 'example.com', '-silent', '-nc', '-duc']],
    ['theharvester', { domain: 'example.com' }, 'theHarvester', ['-d', 'example.com', '-b', 'crtsh,certspotter']]
  ];
  for (const [toolId, input, binary, argv] of cases) {
    const calls = [];
    const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, true, toolId);
    assert.equal(result.status, 'success', toolId);
    assert.equal(calls.length, 1, toolId);
    assert.equal(calls[0].binary, binary, toolId);
    assert.deepEqual(calls[0].argv, argv, toolId);
  }
});

test('step6 schemas: exact keys per tool; cross-field and smuggled input rejected', async () => {
  const malformed = [
    { toolId: 'binwalk', input: { domain: 'example.com' } },
    { toolId: 'binwalk', input: { path: 'queries', domain: 'example.com' } },
    { toolId: 'subfinder', input: { target: 'example.com' } },
    { toolId: 'subfinder', input: { domain: 'example.com', flags: ['-o', 'x'] } },
    { toolId: 'theharvester', input: { path: 'queries' } },
    { toolId: 'theharvester', input: { domain: 'example.com', source: 'all' } },
    { toolId: 'binwalk', input: { path: 'queries; rm -rf /' } },
    { toolId: 'subfinder', input: { domain: 'example.com; rm -rf /' } },
    { toolId: 'subfinder', input: { domain: '8.8.8.8' } },
    { toolId: 'theharvester', input: { domain: 'http://example.com' } },
    { toolId: 'binwalk', input: { path: null } },
    { toolId: 'subfinder', input: { domain: 123 } }
  ];
  for (const request of malformed) {
    const calls = [];
    const result = await runSecurityLabTool(request, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.status, 'unavailable', JSON.stringify(request));
    assert.equal(calls.length, 0, JSON.stringify(request));
  }
});

test('step6 disabled tools: nuclei/trufflehog never spawn', async () => {
  for (const toolId of ['nuclei', 'trufflehog']) {
    for (const input of [{ domain: 'example.com' }, { path: 'queries' }, { target: 'example.com' }, {}]) {
      const calls = [];
      const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
      assert.equal(result.status, 'blocked', `${toolId} ${JSON.stringify(input)}`);
      assert.equal(calls.length, 0, toolId);
    }
  }
});

// ---------------------------------------------------------------------------
// Bounds, normalization, sanitization for the new tools.
// ---------------------------------------------------------------------------

test('step6 bounds: timeout, truncation, and not-installed normalize for new tools', async () => {
  const timeout = await runSecurityLabTool({ toolId: 'subfinder', input: { domain: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: 'partial', stderr: '', timedOut: true, notInstalled: false
  }));
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.message, 'Tool timed out before completing.');

  const missing = await runSecurityLabTool({ toolId: 'binwalk', input: { path: 'queries' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true
  }));
  assert.equal(missing.status, 'not-installed');
  assert.equal(missing.message, 'This tool is not installed on the server.');

  const big = await runSecurityLabTool({ toolId: 'theharvester', input: { domain: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: 0, stdout: `x${'y'.repeat(20000)}`, stderr: '', timedOut: false, notInstalled: false
  }));
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);

  const failed = await runSecurityLabTool({ toolId: 'binwalk', input: { path: 'queries' } }, ADMIN_CTX, DEPS([], {
    exitCode: 3, stdout: '', stderr: 'bad firmware', timedOut: false, notInstalled: false
  }));
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failure');
  assert.equal(failed.exitCode, 3);
});

test('step6 sanitization: no root paths, argv, or runner internals in new-tool results', async () => {
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'subfinder', input: { domain: 'example.com' } }, ADMIN_CTX, DEPS(calls, {
    exitCode: 0, stdout: `subdomains of example.com (config ${FAKE_ROOT}${path.sep}x)`, stderr: '', timedOut: false, notInstalled: false
  }));
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(FAKE_ROOT), 'absolute root leaked');
  assert.ok(blob.includes('[scan-root]'), 'root placeholder present');
  for (const forbidden of ['argv', 'command', 'shell', 'env', 'sudo', 'docker', '-d', 'crtsh']) {
    assert.ok(!Object.hasOwn(result, forbidden), `forbidden key ${forbidden}`);
  }
  assert.ok(!blob.includes('subfinder -d'), 'no command line in payload');
});

// ---------------------------------------------------------------------------
// HTTP: disabled stay 422, invalid new-tool input is 400.
// ---------------------------------------------------------------------------

const { app } = await import('../src/server.js');

const ADMIN = { id: 801, google_user_id: 'google-admin-seclab6', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 802, google_user_id: 'google-user-seclab6', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'seclab6-admin-sid';
const USER_SID = 'seclab6-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let originalQuery = null;
let server;
let port;

test.before(async () => {
  resetSecurityLabRateLimits();
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const user = sessionToUser[params[0]];
      if (user) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: user.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [ADMIN, USER].find(x => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);
const post = (body, cookie = ADMIN_COOKIE) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body)
});

test('step6 HTTP: gates hold for new schemas; named stays-off tools are 422', async () => {
  resetSecurityLabRateLimits();
  const anon = await http('/api/admin/security-lab/execute', post({ toolId: 'subfinder', input: { domain: 'example.com' } }, ''));
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/security-lab/execute', post({ toolId: 'subfinder', input: { domain: 'example.com' } }, USER_COOKIE));
  assert.equal(user.status, 403);

  for (const body of [
    { toolId: 'nuclei', input: { target: 'example.com' } },
    { toolId: 'trufflehog', input: { path: 'queries' } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  for (const body of [
    { toolId: 'subfinder', input: { domain: '8.8.8.8' } },
    { toolId: 'theharvester', input: { domain: 'http://example.com' } },
    { toolId: 'binwalk', input: { path: '../package.json' } },
    { toolId: 'subfinder', input: { domain: 'example.com', flags: [] } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});
