/**
 * Step 7 — Controlled execution for amass, testssl, wafw00f + dedicated
 * Admin page at /admin/security-lab.
 *
 * Proves, with injected fakes unless noted:
 * - registry 11-enabled / 2-disabled split (nuclei, trufflehog stay off)
 * - exact input schemas and fixed argv per new tool (no user flags)
 * - domain/target validation reuse and injection rejection
 * - stays-off tools never spawn under any input shape
 * - timeout/output bounds, not-installed, and sanitization for new tools
 * - version-probe argv is fixed per tool (probes reuse the single runner)
 * - HTTP gates for new schemas (422 stays-off, 400 invalid)
 * - /admin/security-lab auth (anon redirect, user forbidden, admin 200),
 *   skeleton, filters, nav presence, and no non-admin exposure
 * - UI: Run only via explicit confirm; filters only shape the catalog GET;
 *   disabled/not-installed tools expose no usable Run action
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
  buildSecurityLabArgv,
  checkSecurityLabToolStatus,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import { isSecurityLabExecutionAllowed } from '../src/security-lab/tool-registry.js';
import { resetSecurityLabRateLimits } from '../src/security-lab/router.js';

const FAKE_ROOT = path.resolve(process.cwd(), 'test-scan-root');
const KNOWN_PATHS = new Set([path.resolve(FAKE_ROOT, 'queries')]);
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
// Registry + adapters.
// ---------------------------------------------------------------------------

test('step7 registry: amass/testssl/wafw00f enabled (plus earlier steps); nuclei/trufflehog stay disabled', () => {
  for (const id of ['amass', 'testssl', 'wafw00f']) {
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

test('step7 argv: fixed arrays for amass/testssl/wafw00f, null for stays-off tools', () => {
  assert.deepEqual(buildSecurityLabArgv('amass', { domain: 'example.com' }), ['enum', '-d', 'example.com']);
  assert.deepEqual(buildSecurityLabArgv('testssl', { target: 'example.com' }), ['example.com']);
  assert.deepEqual(buildSecurityLabArgv('testssl', { target: '8.8.8.8' }), ['8.8.8.8']);
  assert.deepEqual(buildSecurityLabArgv('wafw00f', { target: 'example.com' }), ['example.com']);
  for (const toolId of ['nuclei', 'trufflehog', 'nope']) {
    assert.equal(buildSecurityLabArgv(toolId, { domain: 'example.com' }), null, toolId);
    assert.equal(buildSecurityLabArgv(toolId, { target: 'example.com' }), null, toolId);
    assert.equal(buildSecurityLabArgv(toolId, { scanPath: 'x' }), null, toolId);
  }
  assert.equal(buildSecurityLabArgv('amass', { target: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('testssl', { domain: 'example.com' }), null);
  assert.equal(buildSecurityLabArgv('wafw00f', { path: 'queries' }), null);
});

test('step7 live run: fixed argv reaches the allowlisted binary', async () => {
  const cases = [
    ['amass', { domain: 'Example.COM' }, 'amass', ['enum', '-d', 'example.com']],
    ['testssl', { target: 'example.com' }, 'testssl.sh', ['example.com']],
    ['wafw00f', { target: 'example.com' }, 'wafw00f', ['example.com']]
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

test('step7 schemas: exact keys; flag/scheme/port injection rejected without spawn', async () => {
  const malformed = [
    { toolId: 'amass', input: { target: 'example.com' } },
    { toolId: 'amass', input: { domain: 'example.com', extra: true } },
    { toolId: 'amass', input: { domain: 'example.com -brute' } },
    { toolId: 'amass', input: { domain: '8.8.8.8' } },
    { toolId: 'amass', input: { domain: 'http://example.com' } },
    { toolId: 'testssl', input: { domain: 'example.com' } },
    { toolId: 'testssl', input: { target: 'example.com:8443' } },
    { toolId: 'testssl', input: { target: 'https://example.com' } },
    { toolId: 'testssl', input: { target: 'example.com --fast' } },
    { toolId: 'testssl', input: { target: '127.0.0.1' } },
    { toolId: 'wafw00f', input: { domain: 'example.com' } },
    { toolId: 'wafw00f', input: { target: 'example.com/x' } },
    { toolId: 'wafw00f', input: { target: 'example.com -a' } },
    { toolId: 'wafw00f', input: { target: '10.0.0.5' } },
    { toolId: 'amass', input: { domain: null } },
    { toolId: 'testssl', input: { target: 443 } }
  ];
  for (const request of malformed) {
    const calls = [];
    const result = await runSecurityLabTool(request, ADMIN_CTX, DEPS(calls, SUCCESS));
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.status, 'unavailable', JSON.stringify(request));
    assert.equal(calls.length, 0, JSON.stringify(request));
  }
});

test('step7 stays-off: nuclei/trufflehog never spawn', async () => {
  for (const toolId of ['nuclei', 'trufflehog']) {
    for (const input of [{ domain: 'example.com' }, { target: 'example.com' }, { path: 'queries' }, {}]) {
      const calls = [];
      const result = await runSecurityLabTool({ toolId, input }, ADMIN_CTX, DEPS(calls, SUCCESS));
      assert.equal(result.status, 'blocked', `${toolId} ${JSON.stringify(input)}`);
      assert.equal(calls.length, 0, toolId);
    }
  }
});

test('step7 bounds: timeout, truncation, not-installed normalize for new tools', async () => {
  const timeout = await runSecurityLabTool({ toolId: 'amass', input: { domain: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: 'partial', stderr: '', timedOut: true, notInstalled: false
  }));
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.message, 'Tool timed out before completing.');

  const missing = await runSecurityLabTool({ toolId: 'testssl', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true
  }));
  assert.equal(missing.status, 'not-installed');
  assert.equal(missing.message, 'This tool is not installed on the server.');

  const big = await runSecurityLabTool({ toolId: 'wafw00f', input: { target: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: 0, stdout: `x${'y'.repeat(20000)}`, stderr: '', timedOut: false, notInstalled: false
  }));
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);

  const failed = await runSecurityLabTool({ toolId: 'amass', input: { domain: 'example.com' } }, ADMIN_CTX, DEPS([], {
    exitCode: 2, stdout: '', stderr: 'config error', timedOut: false, notInstalled: false
  }));
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failure');
  assert.equal(failed.exitCode, 2);
});

test('step7 sanitization: no root paths or command lines in new-tool results', async () => {
  const calls = [];
  const result = await runSecurityLabTool({ toolId: 'testssl', input: { target: 'example.com' } }, ADMIN_CTX, DEPS(calls, {
    exitCode: 0, stdout: `scan host (cfg ${FAKE_ROOT}${path.sep}f) done`, stderr: '', timedOut: false, notInstalled: false
  }));
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(FAKE_ROOT), 'absolute root leaked');
  assert.ok(blob.includes('[scan-root]'), 'root placeholder present');
  for (const forbidden of ['argv', 'command', 'shell', 'env', 'sudo', 'docker']) {
    assert.ok(!Object.hasOwn(result, forbidden), `forbidden key ${forbidden}`);
  }
});

test('step7 probes: version argv is fixed per tool and reuses the single runner', async () => {
  const expectations = [
    ['amass', 'amass', ['-h']],
    ['testssl', 'testssl.sh', ['--help']],
    ['wafw00f', 'wafw00f', ['--help']]
  ];
  for (const [toolId, binary, argv] of expectations) {
    const calls = [];
    const result = await checkSecurityLabToolStatus(toolId, {
      spawnFn: async (b, a) => {
        calls.push({ b, a });
        return { exitCode: 0, stdout: 'v1\n', stderr: '', timedOut: false, notInstalled: false };
      }
    });
    assert.equal(result.status, 'ready', toolId);
    assert.deepEqual(calls, [{ b: binary, a: argv }], toolId);
  }
});

// ---------------------------------------------------------------------------
// HTTP gates + dedicated page.
// ---------------------------------------------------------------------------

const { app } = await import('../src/server.js');

const ADMIN = { id: 901, google_user_id: 'google-admin-seclab7', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 902, google_user_id: 'google-user-seclab7', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'seclab7-admin-sid';
const USER_SID = 'seclab7-user-sid';
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
    if (/expiring_soon_users/.test(sql)) {
      return { rows: [{ total_users: 5, pending_users: 0, revoked_users: 0, active_users: 4, admin_users: 1, expiring_soon_users: 0 }] };
    }
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 1, recent_replies_count: 1 }] };
    }
    if (/FROM interview_question_notes/.test(sql)) {
      return { rows: [{ total_notes: 1, unique_learners: 1, unique_questions: 1 }] };
    }
    if (/active_today/.test(sql)) {
      return { rows: [{ total_users: 2, active_today: 1, active_month: 2, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
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

test('step7 HTTP: stays-off tools are 422, invalid new-tool input is 400', async () => {
  resetSecurityLabRateLimits();
  for (const body of [
    { toolId: 'nuclei', input: { target: 'example.com' } },
    { toolId: 'trufflehog', input: { path: 'queries' } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  for (const body of [
    { toolId: 'amass', input: { domain: 'http://example.com' } },
    { toolId: 'testssl', input: { target: 'example.com:443' } },
    { toolId: 'wafw00f', input: { target: 'https://example.com' } },
    { toolId: 'amass', input: { domain: 'example.com', mode: 'intel' } }
  ]) {
    const res = await http('/api/admin/security-lab/execute', post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('step7 page: /admin/security-lab is admin-only with skeleton, filters, and script', async () => {
  const anon = await http('/admin/security-lab', { redirect: 'manual' });
  assert.equal(anon.status, 302);

  const user = await http('/admin/security-lab', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.equal(user.status, 403);
  const userHtml = await user.text().catch(() => '');
  assert.ok(!userHtml.includes('security-lab-card'), 'no lab markup leaks to non-admins');

  const res = await http('/admin/security-lab', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="security-lab"'), 'lab card present');
  assert.ok(html.includes('id="security-lab-enabled-list"'), 'enabled list region present');
  assert.ok(html.includes('id="security-lab-list"'), 'catalog region preserved');
  assert.ok(html.includes('data-testid="security-lab-filters"'), 'filter form present');
  assert.ok(html.includes('id="security-lab-filter-q"'), 'search input present');
  assert.ok(html.includes('id="security-lab-filter-category"'), 'category filter present');
  assert.ok(html.includes('id="security-lab-filter-risk"'), 'risk filter present');
  assert.ok(html.includes('/admin-security-lab.js'), 'client script included');
  assert.ok(!html.includes('Confirm run'), 'no server-rendered run controls');
  assert.ok(!html.includes('onload='), 'no inline handlers');
});

test('step7 nav: Security Lab entry is discoverable from Admin pages', async () => {
  const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('href="/admin/security-lab"'), 'nav entry present on Admin home');

  const page = await http('/admin/security-lab', { headers: { Cookie: ADMIN_COOKIE } });
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes('href="/admin/security-lab"'), 'nav entry present on the lab page');
  assert.ok(pageHtml.includes('href="/admin"'), 'navigation back to Admin Home present');
});

test('step7 UI: client supports filters and runnable specs for the new tools only', async () => {
  const res = await http('/admin-security-lab.js');
  assert.equal(res.status, 200);
  const js = await res.text();
  for (const id of ['amass:', 'testssl:', 'wafw00f:', 'gobuster:', 'dirsearch:']) {
    assert.ok(js.includes(id), `runnable spec present: ${id}`);
  }
  for (const id of ['nuclei', 'trufflehog']) {
    assert.ok(!js.includes(id), `stays-off tool absent from client: ${id}`);
  }
  assert.ok(js.includes('security-lab-filter-q'), 'filter query wired');
  assert.ok(js.includes('security-lab-filters'), 'filter submit wired');
  assert.ok(js.includes('encodeURIComponent'), 'filter values encoded');
  assert.ok(js.includes("confirm.addEventListener('click'"), 'POST still behind confirm click only');
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
});
