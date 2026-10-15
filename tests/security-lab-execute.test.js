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
  resolveSecurityLabScanPath,
  validateSecurityLabTarget,
  buildSecurityLabArgv,
  defaultSecurityLabSpawn,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import { resetSecurityLabRateLimits } from '../src/security-lab/router.js';

const { app } = await import('../src/server.js');

// ---------------------------------------------------------------------------
// Unit fakes (no real processes, no real filesystem).
// ---------------------------------------------------------------------------

const FAKE_ROOT = path.resolve(process.cwd(), 'test-scan-root');
const KNOWN_PATHS = new Set([
  path.resolve(FAKE_ROOT, 'queries'),
  path.resolve(FAKE_ROOT, 'queries', 'Guidewire'),
  path.resolve(FAKE_ROOT, 'src', 'server.js')
]);

const fakeStat = async (p) => {
  if (KNOWN_PATHS.has(p)) return {};
  throw new Error('missing');
};
const fakeRealpath = async (p) => p;

function fakeSpawnFactory(calls, result) {
  return async (binary, argv, opts) => {
    calls.push({ binary, argv: [...argv], timeoutMs: opts?.timeoutMs });
    return { ...result };
  };
}

const ADMIN_CTX = { isAdmin: true };
const DEPS = (calls, result, extra = {}) => ({
  root: FAKE_ROOT,
  spawnFn: fakeSpawnFactory(calls, result),
  statFn: fakeStat,
  realpathFn: fakeRealpath,
  timeoutMs: 5000,
  ...extra
});
const SUCCESS = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, notInstalled: false };

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

test('paths: only repo-relative paths inside permitted scan roots resolve', () => {
  const good = ['queries', 'queries/Guidewire', 'src/server.js', 'src\\server.js'];
  for (const input of good) {
    const resolved = resolveSecurityLabScanPath(input, FAKE_ROOT);
    assert.equal(resolved.ok, true, input);
    assert.ok(resolved.resolved.startsWith(path.resolve(FAKE_ROOT) + path.sep), input);
  }
  const bad = [
    '',
    '   ',
    '.env',
    'package.json',
    'migrations/001.sql',
    'node_modules/x',
    '../outside',
    'queries/../../etc',
    'queries/../package.json',
    '/etc/passwd',
    'C:\\Windows\\x',
    '\\\\unc\\share',
    '~/x',
    'queries/\0/x',
    `${'q'.repeat(600)}`,
    null,
    undefined,
    123
  ];
  for (const input of bad) {
    assert.equal(resolveSecurityLabScanPath(input, FAKE_ROOT).ok, false, String(input));
  }
});

test('targets: httpx accepts only public hostnames/IP literals, nothing else', () => {
  for (const target of ['example.com', 'Sub.Example.ORG', 'example.com.', '8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(validateSecurityLabTarget(target).ok, true, target);
  }
  const bad = [
    '',
    'localhost',
    'singlelabel',
    'http://example.com',
    'https://example.com/x',
    'example.com:8080',
    'example.com/path',
    'example.com?q=1',
    'example.com#frag',
    'user@example.com',
    'exam ple.com',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.9',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:8.8.8.8',
    'example.123',
    '-bad-.com',
    'bad_.com',
    null,
    123,
    `a${'b'.repeat(300)}.com`
  ];
  for (const target of bad) {
    assert.equal(validateSecurityLabTarget(target).ok, false, String(target));
  }
  assert.equal(validateSecurityLabTarget('Example.COM').target, 'example.com');
});

// ---------------------------------------------------------------------------
// Argv construction (exact, fixed, no user flags).
// ---------------------------------------------------------------------------

test('argv: per-tool argv arrays are fixed and exact', () => {
  const scanPath = path.resolve(FAKE_ROOT, 'queries');
  assert.deepEqual(buildSecurityLabArgv('gitleaks', { scanPath }), ['dir', scanPath, '--no-banner', '--no-color', '--redact']);
  assert.deepEqual(buildSecurityLabArgv('trivy', { scanPath }), ['fs', '--quiet', '--no-progress', scanPath]);
  assert.deepEqual(
    buildSecurityLabArgv('httpx', { target: 'example.com' }),
    ['-u', 'example.com', '-silent', '-no-color', '-disable-update-check', '-timeout', '10']
  );
  assert.equal(buildSecurityLabArgv('nuclei', { scanPath }), null);
  assert.equal(buildSecurityLabArgv('gitleaks', { target: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('httpx', { scanPath }), null);
  assert.equal(buildSecurityLabArgv('nope', {}), null);
});

test('argv: live run passes the fixed argv to the allowlisted binary', async () => {
  const cases = [
    ['gitleaks', { path: 'queries' }, 'gitleaks', ['dir', path.resolve(FAKE_ROOT, 'queries'), '--no-banner', '--no-color', '--redact']],
    ['trivy', { path: 'src/server.js' }, 'trivy', ['fs', '--quiet', '--no-progress', path.resolve(FAKE_ROOT, 'src', 'server.js')]],
    ['httpx', { target: 'example.com' }, 'httpx', ['-u', 'example.com', '-silent', '-no-color', '-disable-update-check', '-timeout', '10']]
  ];
  for (const [toolId, input, binary, argv] of cases) {
    const calls = [];
    const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, true, toolId);
    assert.equal(result.status, 'success', toolId);
    assert.equal(calls.length, 1, toolId);
    assert.equal(calls[0].binary, binary, toolId);
    assert.deepEqual(calls[0].argv, argv, toolId);
    assert.equal(calls[0].timeoutMs, 5000, toolId);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed gates (never spawn).
// ---------------------------------------------------------------------------

test('fail-closed: unknown, disabled, unauthorized, and malformed requests never spawn', async () => {
  const assistantLike = { isAdmin: true };
  const blocked = [
    [{ toolId: 'nuclei', input: { path: 'queries' } }, assistantLike],
    [{ toolId: 'trufflehog', input: { path: 'queries' } }, assistantLike],
    [{ toolId: 'sqlmap', input: {} }, assistantLike],
    [{ toolId: 123, input: {} }, assistantLike],
    [{ toolId: 'gitleaks', input: { path: 'queries' } }, { isAdmin: false }],
    [{ toolId: 'gitleaks', input: { path: 'queries' } }, {}]
  ];
  for (const [request, ctx] of blocked) {
    const calls = [];
    const result = await runSecurityLabTool(request, ctx, DEPS(calls, SUCCESS));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(calls.length, 0);
  }
  const malformed = [
    null,
    'x',
    [],
    {},
    { toolId: 'gitleaks' },
    { input: { path: 'queries' } },
    { toolId: 'gitleaks', input: { path: 'queries' }, extra: 1 },
    { toolId: 'gitleaks', input: { path: 'queries', target: 'example.com' } },
    { toolId: 'gitleaks', input: { target: 'example.com' } },
    { toolId: 'httpx', input: { path: 'queries' } },
    { toolId: 'httpx', input: { target: 'example.com', extra: true } },
    { toolId: 'gitleaks', input: { path: 123 } },
    { toolId: 'httpx', input: { target: null } },
    { toolId: 'gitleaks', input: ['queries'] },
    { toolId: 'gitleaks', input: {} },
    { toolId: 'subfinder', input: { target: 'example.com' } },
    { toolId: 'subfinder', input: { domain: 'example.com', extra: true } },
    { toolId: 'theharvester', input: { path: 'queries' } },
    { toolId: 'binwalk', input: { domain: 'example.com' } },
    { toolId: 'binwalk', input: { path: 123 } },
    { toolId: 'subfinder', input: { domain: null } }
  ];
  for (const request of malformed) {
    const calls = [];
    const result = await runSecurityLabTool(request, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.length, 0);
  }
});

test('fail-closed: traversal, missing, and symlink-escaping paths never spawn', async () => {
  for (const input of [{ path: '../outside' }, { path: '/etc/passwd' }, { path: 'package.json' }, { path: 'nope/missing' }]) {
    const calls = [];
    const result = await runSecurityLabTool({ toolId: 'gitleaks', input }, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.length, 0);
  }
  const calls = [];
  const escape = await runSecurityLabTool({ toolId: 'trivy', input: { path: 'queries' } }, ADMIN_CTX, {
    ...DEPS(calls, SUCCESS),
    realpathFn: async () => path.resolve(FAKE_ROOT, '..', 'escape')
  });
  assert.equal(escape.status, 'unavailable');
  assert.equal(calls.length, 0);
});

test('executable set: exactly the eleven adapters, matching the registry gate', async () => {
  assert.deepEqual(
    [...SECURITY_LAB_EXECUTABLE_TOOLS].sort(),
    ['amass', 'binwalk', 'dirsearch', 'gitleaks', 'gobuster', 'httpx', 'subfinder', 'testssl', 'theharvester', 'trivy', 'wafw00f']
  );
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'gitleaks', input: { path: 'queries' } }, ADMIN_CTX, {
    ...DEPS(calls, SUCCESS),
    root: null
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Normalization, bounds, sanitization.
// ---------------------------------------------------------------------------

test('normalization: gitleaks exit 1 is success-with-findings; other exits fail', async () => {
  const findings = await runSecurityLabTool(
    { toolId: 'gitleaks', input: { path: 'queries' } },
    ADMIN_CTX,
    DEPS([], { exitCode: 1, stdout: 'leak', stderr: '', timedOut: false, notInstalled: false })
  );
  assert.equal(findings.ok, true);
  assert.equal(findings.status, 'success');
  assert.equal(findings.exitCode, 1);
  assert.equal(findings.message, 'Scan completed with findings.');

  const failed = await runSecurityLabTool(
    { toolId: 'trivy', input: { path: 'queries' } },
    ADMIN_CTX,
    DEPS([], { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, notInstalled: false })
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failure');
  assert.equal(failed.message, 'Tool exited with an error.');
});

test('normalization: timeout and not-installed use fixed sanitized messages', async () => {
  const timeout = await runSecurityLabTool(
    { toolId: 'httpx', input: { target: 'example.com' } },
    ADMIN_CTX,
    DEPS([], { exitCode: null, stdout: 'partial', stderr: '', timedOut: true, notInstalled: false })
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.message, 'Tool timed out before completing.');

  const missing = await runSecurityLabTool(
    { toolId: 'httpx', input: { target: 'example.com' } },
    ADMIN_CTX,
    DEPS([], { exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true })
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'not-installed');
  assert.equal(missing.message, 'This tool is not installed on the server.');
});

test('bounds: stdout/stderr truncate to caps with a truncated flag', async () => {
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'httpx', input: { target: 'example.com' } }, ADMIN_CTX, DEPS(calls, {
    exitCode: 0,
    stdout: `x${'y'.repeat(20000)}`,
    stderr: `e${'f'.repeat(9000)}`,
    timedOut: false,
    notInstalled: false
  }));
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);
  assert.ok(result.stderr.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDERR_CHARS);
  assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
});

test('hardening: injected timeouts clamp into the supported window', async () => {
  const forwarded = [];
  for (const timeoutMs of [0, -5000, Number.NaN, 10_000_000]) {
    await runSecurityLabTool({ toolId: 'httpx', input: { target: 'example.com' } }, ADMIN_CTX, {
      root: FAKE_ROOT,
      spawnFn: async (binary, argv, opts) => {
        forwarded.push(opts?.timeoutMs);
        return { ...SUCCESS };
      },
      statFn: async () => ({}),
      realpathFn: async (p) => p,
      timeoutMs
    });
  }
  assert.equal(forwarded.length, 4);
  for (const value of forwarded) {
    assert.ok(
      value >= SECURITY_LAB_EXEC_CAPS.MIN_TIMEOUT_MS && value <= SECURITY_LAB_EXEC_CAPS.MAX_TIMEOUT_MS,
      `timeout not clamped: ${value}`
    );
  }
  assert.ok(forwarded.includes(SECURITY_LAB_EXEC_CAPS.MIN_TIMEOUT_MS), 'low values clamp to the minimum');
  assert.ok(forwarded.includes(SECURITY_LAB_EXEC_CAPS.MAX_TIMEOUT_MS), 'high values clamp to the maximum');
});

test('sanitization: absolute scan-root paths never appear in results', async () => {
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'gitleaks', input: { path: 'queries' } }, ADMIN_CTX, DEPS(calls, {
    exitCode: 0,
    stdout: `finding in ${FAKE_ROOT}${path.sep}queries${path.sep}file.txt`,
    stderr: `log ${FAKE_ROOT} done`,
    timedOut: false,
    notInstalled: false
  }));
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(FAKE_ROOT), 'absolute root leaked');
  assert.ok(blob.includes('[scan-root]'), 'root placeholder present');
  for (const forbidden of ['argv', 'command', 'shell', 'env', 'sudo', 'docker']) {
    assert.ok(!Object.hasOwn(result, forbidden), `forbidden key ${forbidden}`);
  }
});

test('determinism: identical inputs produce identical results', async () => {
  const first = await runSecurityLabTool({ toolId: 'httpx', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], SUCCESS));
  const second = await runSecurityLabTool({ toolId: 'httpx', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], SUCCESS));
  assert.deepEqual({ ...first, durationMs: 0 }, { ...second, durationMs: 0 });
});

test('spawn: a missing binary normalizes to not-installed via the real execFile path', async () => {
  const result = await defaultSecurityLabSpawn('__definitely_missing_security_lab_binary__', ['--version'], {
    timeoutMs: 5000,
    maxBytes: 65536
  });
  assert.equal(result.notInstalled, true);
  assert.equal(result.timedOut, false);
});

test('executor module has no generic runner surface (source boundary)', async () => {
  const raw = await readFile(new URL('../src/security-lab/executor.js', import.meta.url), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.match(code, /execFile/);
  assert.doesNotMatch(code, /execSync|spawnSync|exec\s*\(\s*['"`]/);
  assert.doesNotMatch(code, /shell\s*:\s*true/);
  assert.doesNotMatch(code, /\bsudo\b|\bdocker\b/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout/i);
});

// ---------------------------------------------------------------------------
// HTTP endpoint.
// ---------------------------------------------------------------------------

const ADMIN = { id: 601, google_user_id: 'google-admin-seclabexec', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 602, google_user_id: 'google-user-seclabexec', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const RATE_USER = { id: 603, google_user_id: 'google-user-seclabrate', email: 'rate@example.com', name: 'Rate', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'seclabexec-admin-sid';
const USER_SID = 'seclabexec-user-sid';
const RATE_SID = 'seclabexec-rate-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const RATE_COOKIE = `connect.sid=s:${cookieSignature.sign(RATE_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER, [RATE_SID]: RATE_USER };

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
      const u = [ADMIN, USER, RATE_USER].find(x => x.id === params[0]);
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

test('execute API: unauthenticated and non-admin access are rejected', async () => {
  const anon = await http('/api/admin/security-lab/execute', post({ toolId: 'httpx', input: { target: 'example.com' } }, ''));
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/security-lab/execute', post({ toolId: 'httpx', input: { target: 'example.com' } }, USER_COOKIE));
  assert.equal(user.status, 403);
});

test('execute API: exact body schemas enforced, unknown tools rejected', async () => {
  resetSecurityLabRateLimits();
  const badBodies = [
    { toolId: 'httpx' },
    { input: { target: 'example.com' } },
    { toolId: 'httpx', input: { target: 'example.com' }, extra: 1 },
    { toolId: 'httpx', input: { target: 'example.com', extra: true } },
    { toolId: 'httpx', input: ['example.com'] }
  ];
  for (const body of badBodies) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  for (const body of [{ toolId: 'nuclei', input: { path: 'queries' } }, { toolId: 'nope', input: {} }]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 422, JSON.stringify(body));
    const payload = await res.json();
    assert.ok(payload.reason === 'unknown-tool' || payload.reason === 'not-enabled', payload.reason);
  }
});

test('execute API: unsafe targets and paths rejected without execution', async () => {
  resetSecurityLabRateLimits();
  for (const input of [{ target: 'http://example.com' }, { target: '127.0.0.1' }, { target: 'localhost' }]) {
    const res = await http('/api/admin/security-lab/execute', post({ toolId: 'httpx', input }));
    assert.equal(res.status, 400, JSON.stringify(input));
  }
  for (const input of [{ path: '../package.json' }, { path: '/etc/passwd' }, { path: 'package.json' }]) {
    const res = await http('/api/admin/security-lab/execute', post({ toolId: 'gitleaks', input }));
    assert.equal(res.status, 400, JSON.stringify(input));
  }
});

test('execute API: per-user rate limit trips fail-closed', async () => {
  resetSecurityLabRateLimits();
  let limited = 0;
  for (let i = 0; i < 11; i++) {
    const res = await http('/api/admin/security-lab/execute', post({ toolId: 'nope', input: {} }, RATE_COOKIE));
    if (res.status === 429) limited += 1;
    await res.text().catch(() => '');
  }
  assert.equal(limited, 1);
});
