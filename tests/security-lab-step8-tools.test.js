/**
 * Step 8 — Controlled execution for gobuster + dirsearch.
 * Nuclei and trufflehog stay disabled.
 *
 * Proves, with injected fakes unless noted:
 * 1. registry: 11-enabled / 2-disabled split (nuclei, trufflehog off)
 * 2. validation: bare public targets accepted; schemes/ports/paths/
 *    loopback/private/link-local/multicast/malformed rejected
 * 3. argv: exact fixed arrays; no user flags; no shell; injection and
 *    wordlist/path smuggling rejected; no user-controlled executable
 * 4. scope/resources: server-bundled wordlist only (existence-checked,
 *    missing fails closed); fixed threads/timeouts; no recursion flags;
 *    discovery URL built server-side (IPv6 bracketed)
 * 5. disabled: nuclei + trufflehog produce `blocked` with zero spawns
 * 6. outcomes: success / failure / timeout / not-installed, truncated +
 *    sanitized, for both tools
 * 7. HTTP: 401 / 403 / 400 / 422, rate-limit behavior preserved
 * 8. regressions: covered by the full focused run (no live binaries here,
 *    so no real execution is claimed)
 */
import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import cookieSignature from 'cookie-signature';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import {
  SECURITY_LAB_EXEC_CAPS,
  SECURITY_LAB_EXECUTABLE_TOOLS,
  buildSecurityLabArgv,
  getGobusterWordlistPath,
  toSecurityLabDiscoveryUrl,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import { isSecurityLabExecutionAllowed } from '../src/security-lab/tool-registry.js';
import { resetSecurityLabRateLimits } from '../src/security-lab/router.js';

const FAKE_ROOT = path.resolve(process.cwd(), 'test-scan-root');
const FAKE_WORDLIST = path.join(FAKE_ROOT, 'gobuster-common.txt');
const KNOWN_PATHS = new Set([path.resolve(FAKE_ROOT, 'queries'), FAKE_WORDLIST]);
const fakeStat = async (p) => {
  if (KNOWN_PATHS.has(p)) return {};
  throw new Error('missing');
};
const fakeRealpath = async (p) => p;
const SUCCESS = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, notInstalled: false };
const ADMIN_CTX = { isAdmin: true };
const DEPS = (calls, result, extra = {}) => ({
  root: FAKE_ROOT,
  wordlistPath: FAKE_WORDLIST,
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
// 1. Registry split.
// ---------------------------------------------------------------------------

test('step8 registry: gobuster/dirsearch enabled; nuclei/trufflehog stay disabled', () => {
  for (const id of ['gobuster', 'dirsearch']) {
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
// 2. Validation (adapter level: invalid targets never spawn).
// ---------------------------------------------------------------------------

test('step8 validation: bare public targets accepted; unsafe targets rejected', async () => {
  for (const [toolId, input] of [
    ['gobuster', { target: 'example.com' }],
    ['gobuster', { target: '8.8.8.8' }],
    ['dirsearch', { target: 'example.com' }],
    ['dirsearch', { target: '2001:4860:4860::8888' }]
  ]) {
    const calls = [];
    const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, true, `${toolId} ${JSON.stringify(input)}`);
    assert.equal(calls.length, 1, toolId);
  }
  const bad = [
    'http://example.com',
    'https://example.com/x',
    'example.com:8080',
    'example.com/path?q=1',
    'user@example.com',
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.9',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'ff02::1',
    'exam ple.com',
    'example.com -u evil',
    'example.com; rm -rf /',
    '',
    null,
    443
  ];
  for (const toolId of ['gobuster', 'dirsearch']) {
    for (const target of bad) {
      const calls = [];
      const result = await runSecurityLabTool({ toolId, input: { target } }, ADMIN_CTX, DEPS(calls, SUCCESS));
      assert.equal(result.ok, false, `${toolId} ${String(target)}`);
      assert.equal(result.status, 'unavailable', `${toolId} ${String(target)}`);
      assert.equal(calls.length, 0, `${toolId} ${String(target)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Command safety: exact argv, no user flags, no shell, no smuggling.
// ---------------------------------------------------------------------------

test('step8 argv: exact fixed arrays for gobuster/dirsearch', () => {
  assert.deepEqual(
    buildSecurityLabArgv('gobuster', { targetUrl: 'http://example.com', wordlistPath: '/srv/wl.txt' }),
    ['dir', '-u', 'http://example.com', '-w', '/srv/wl.txt', '-t', '10', '-q', '--no-error', '--timeout', '10s']
  );
  assert.deepEqual(
    buildSecurityLabArgv('dirsearch', { targetUrl: 'http://example.com' }),
    ['-u', 'http://example.com', '-t', '20']
  );
  assert.equal(buildSecurityLabArgv('gobuster', { targetUrl: 'http://example.com' }), null);
  assert.equal(buildSecurityLabArgv('gobuster', { target: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('dirsearch', { target: 'example.com' }), null);
  // Note: exact-key enforcement lives in runSecurityLabTool (proven in the
  // schemas test); the builder trusts validator-produced values only.
});

test('step8 live run: fixed argv reaches the allowlisted binary', async () => {
  const wordlist = FAKE_WORDLIST;
  const cases = [
    ['gobuster', { target: 'example.com' }, 'gobuster',
      ['dir', '-u', 'http://example.com', '-w', wordlist, '-t', '10', '-q', '--no-error', '--timeout', '10s']],
    ['gobuster', { target: '2001:4860:4860::8888' }, 'gobuster',
      ['dir', '-u', 'http://[2001:4860:4860::8888]', '-w', wordlist, '-t', '10', '-q', '--no-error', '--timeout', '10s']],
    ['dirsearch', { target: 'example.com' }, 'dirsearch',
      ['-u', 'http://example.com', '-t', '20']]
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

test('step8 schemas: exact keys only; wordlist/mode/flag smuggling rejected', async () => {
  const malformed = [
    { toolId: 'gobuster', input: { target: 'example.com', wordlist: '/etc/passwd' } },
    { toolId: 'gobuster', input: { target: 'example.com', mode: 'dns' } },
    { toolId: 'gobuster', input: { target: 'example.com', threads: '100' } },
    { toolId: 'gobuster', input: { domain: 'example.com' } },
    { toolId: 'gobuster', input: { path: 'queries' } },
    { toolId: 'dirsearch', input: { target: 'example.com', extensions: 'php' } },
    { toolId: 'dirsearch', input: { target: 'example.com', recursive: true } },
    { toolId: 'dirsearch', input: { target: 'example.com', wordlist: 'x' } },
    { toolId: 'dirsearch', input: { domain: 'example.com' } },
    { toolId: 'gobuster', input: { target: null } },
    { toolId: 'dirsearch', input: { target: ['example.com'] } }
  ];
  for (const request of malformed) {
    const calls = [];
    const result = await runSecurityLabTool(request, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.status, 'unavailable', JSON.stringify(request));
    assert.equal(calls.length, 0, JSON.stringify(request));
  }
});

// ---------------------------------------------------------------------------
// 4. Scope/resource safety.
// ---------------------------------------------------------------------------

test('step8 wordlist: server-bundled, bounded, pure entries, fail-closed when missing', async () => {
  const source = await readFile(new URL('../src/security-lab/wordlists/gobuster-common.txt', import.meta.url), 'utf8');
  const lines = source.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 24, 'fixed small entry count bounds every scan');
  for (const line of lines) {
    assert.match(line, /^[a-z0-9][a-z0-9._~-]*$/i, `unsafe wordlist entry: ${line}`);
    assert.ok(!line.includes('/') && !line.includes('\\') && !line.includes(' '), `path-like entry: ${line}`);
  }
  assert.equal(getGobusterWordlistPath({}).endsWith(path.join('wordlists', 'gobuster-common.txt')), true);
  assert.equal(getGobusterWordlistPath({ wordlistPath: '/x' }), '/x');

  const missing = await runSecurityLabTool({ toolId: 'gobuster', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], SUCCESS, {
    wordlistPath: path.join(FAKE_ROOT, 'does-not-exist.txt')
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'misconfigured');
});

test('step8 discovery URL: server-built http URL, IPv6 bracketed, no recursion flags', () => {
  assert.equal(toSecurityLabDiscoveryUrl('example.com'), 'http://example.com');
  assert.equal(toSecurityLabDiscoveryUrl('8.8.8.8'), 'http://8.8.8.8');
  assert.equal(toSecurityLabDiscoveryUrl('2001:4860:4860::8888'), 'http://[2001:4860:4860::8888]');
  const argv = buildSecurityLabArgv('gobuster', { targetUrl: 'http://example.com', wordlistPath: '/srv/wl.txt' });
  assert.ok(!argv.some((item) => /recurs/i.test(item)), 'no recursion flags');
  assert.ok(argv.includes('10s') && argv.includes('10'), 'bounded threads and tool timeout');
  const dsArgv = buildSecurityLabArgv('dirsearch', { targetUrl: 'http://example.com' });
  assert.ok(!dsArgv.includes('-r'), 'no recursion flag');
  assert.ok(dsArgv.includes('20'), 'bounded threads');
});

// ---------------------------------------------------------------------------
// 5. Disabled tools. 6. Outcomes.
// ---------------------------------------------------------------------------

test('step8 stays-off: nuclei/trufflehog produce blocked with zero spawns', async () => {
  for (const toolId of ['nuclei', 'trufflehog']) {
    for (const input of [{ target: 'example.com' }, { domain: 'example.com' }, { path: 'queries' }, {}]) {
      const calls = [];
      const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
      assert.equal(result.status, 'blocked', `${toolId} ${JSON.stringify(input)}`);
      assert.equal(calls.length, 0, toolId);
    }
  }
});

test('step8 outcomes: success/failure/timeout/not-installed normalize for both tools', async () => {
  const timeout = await runSecurityLabTool({ toolId: 'gobuster', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: 'partial', stderr: '', timedOut: true, notInstalled: false
  }));
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.message, 'Tool timed out before completing.');

  const missing = await runSecurityLabTool({ toolId: 'dirsearch', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true
  }));
  assert.equal(missing.status, 'not-installed');
  assert.equal(missing.message, 'This tool is not installed on the server.');

  const big = await runSecurityLabTool({ toolId: 'gobuster', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: 0, stdout: `x${'y'.repeat(20000)}`, stderr: `e${'f'.repeat(9000)}`, timedOut: false, notInstalled: false
  }));
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);
  assert.ok(big.stderr.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDERR_CHARS);

  const failed = await runSecurityLabTool({ toolId: 'dirsearch', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: 1, stdout: '', stderr: 'connection refused', timedOut: false, notInstalled: false
  }));
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failure');
  assert.equal(failed.exitCode, 1);
});

test('step8 sanitization: no root paths or command lines in discovery results', async () => {
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'dirsearch', input: { target: 'example.com' } }, ADMIN_CTX, DEPS(calls, {
    exitCode: 0, stdout: `found /admin (cfg ${FAKE_ROOT}${path.sep}f)`, stderr: '', timedOut: false, notInstalled: false
  }));
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(FAKE_ROOT), 'absolute root leaked');
  assert.ok(blob.includes('[scan-root]'), 'root placeholder present');
  for (const forbidden of ['argv', 'command', 'shell', 'env', 'sudo', 'docker', 'wordlist']) {
    assert.ok(!Object.hasOwn(result, forbidden), `forbidden key ${forbidden}`);
  }
  assert.ok(!blob.includes('gobuster dir') && !blob.includes('dirsearch -u'), 'no command line in payload');
});

test('step8 executor has no generic runner surface (source boundary)', async () => {
  const raw = await readFile(new URL('../src/security-lab/executor.js', import.meta.url), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.match(code, /execFile/);
  assert.doesNotMatch(code, /execSync|spawnSync|exec\s*\(\s*['"`]/);
  assert.doesNotMatch(code, /shell\s*:\s*true/);
  assert.doesNotMatch(code, /\bsudo\b|\bdocker\b/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout/i);
});

// ---------------------------------------------------------------------------
// 7. HTTP gates.
// ---------------------------------------------------------------------------

const { app } = await import('../src/server.js');

const ADMIN = { id: 1001, google_user_id: 'google-admin-seclab8', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 1002, google_user_id: 'google-user-seclab8', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'seclab8-admin-sid';
const USER_SID = 'seclab8-user-sid';
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

test('step8 HTTP: 401/403/400/422 hold for discovery schemas; rate limit preserved', async () => {
  resetSecurityLabRateLimits();
  const anon = await http('/api/admin/security-lab/execute', post({ toolId: 'gobuster', input: { target: 'example.com' } }, ''));
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/security-lab/execute', post({ toolId: 'gobuster', input: { target: 'example.com' } }, USER_COOKIE));
  assert.equal(user.status, 403);

  for (const body of [
    { toolId: 'nuclei', input: { target: 'example.com' } },
    { toolId: 'trufflehog', input: { path: 'queries' } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  for (const body of [
    { toolId: 'gobuster', input: { target: 'https://example.com/admin' } },
    { toolId: 'gobuster', input: { target: 'example.com', wordlist: 'big.txt' } },
    { toolId: 'dirsearch', input: { target: '127.0.0.1' } },
    { toolId: 'dirsearch', input: { target: 'example.com', r: true } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }

  resetSecurityLabRateLimits();
  let limited = 0;
  for (let i = 0; i < 11; i++) {
    const res = await http('/api/admin/security-lab/execute', post({ toolId: 'nope', input: {} }));
    if (res.status === 429) limited += 1;
    await res.text().catch(() => '');
  }
  assert.equal(limited, 1);
});

test('step8 UI: client exposes discovery specs; nuclei/trufflehog stay absent', async () => {
  const res = await http('/admin-security-lab.js');
  assert.equal(res.status, 200);
  const js = await res.text();
  assert.ok(js.includes('gobuster:'), 'gobuster spec present');
  assert.ok(js.includes('dirsearch:'), 'dirsearch spec present');
  assert.ok(!js.includes('nuclei'), 'nuclei absent from client');
  assert.ok(!js.includes('trufflehog'), 'trufflehog absent from client');
});
