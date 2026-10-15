import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import {
  checkSecurityLabToolStatus,
  getSecurityLabStatus
} from '../src/security-lab/executor.js';
import { resetSecurityLabRateLimits } from '../src/security-lab/router.js';

// ---------------------------------------------------------------------------
// Unit: status probes reuse the single spawn path and leak nothing.
// ---------------------------------------------------------------------------

test('status unit: ready reports a truncated first-line version only', async () => {
  const calls = [];
  const result = await checkSecurityLabToolStatus('gitleaks', {
    spawnFn: async (binary, argv, opts) => {
      calls.push({ binary, argv });
      return { exitCode: 0, stdout: 'gitleaks version v8.28.0\nsecond line with secrets=xyz\n', stderr: 'ignored', timedOut: false, notInstalled: false };
    }
  });
  assert.deepEqual(result, { toolId: 'gitleaks', executionAllowed: true, installed: true, status: 'ready', version: 'gitleaks version v8.28.0' });
  assert.deepEqual(calls, [{ binary: 'gitleaks', argv: ['version'] }]);
  assert.ok(!JSON.stringify(result).includes('second line'));
});

test('status unit: long versions truncate and blank versions are omitted', async () => {
  const long = await checkSecurityLabToolStatus('trivy', {
    spawnFn: async () => ({ exitCode: 0, stdout: `v${'9'.repeat(500)}\n`, stderr: '', timedOut: false, notInstalled: false })
  });
  assert.equal(long.status, 'ready');
  assert.ok(long.version.length <= 120);

  const blank = await checkSecurityLabToolStatus('httpx', {
    spawnFn: async () => ({ exitCode: 0, stdout: '\n  \n', stderr: 'v1.7.2', timedOut: false, notInstalled: false })
  });
  assert.deepEqual(blank, { toolId: 'httpx', executionAllowed: true, installed: true, status: 'ready' });
});

test('status unit: not-installed, timeout, exit-error, and throws degrade safely', async () => {
  const missing = await checkSecurityLabToolStatus('httpx', {
    spawnFn: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true })
  });
  assert.deepEqual(missing, { toolId: 'httpx', executionAllowed: true, installed: false, status: 'not-installed' });

  for (const fake of [
    { exitCode: null, stdout: '', stderr: '', timedOut: true, notInstalled: false },
    { exitCode: 2, stdout: 'x', stderr: 'y', timedOut: false, notInstalled: false }
  ]) {
    const result = await checkSecurityLabToolStatus('trivy', { spawnFn: async () => ({ ...fake }) });
    assert.deepEqual(result, { toolId: 'trivy', executionAllowed: true, installed: false, status: 'unavailable' });
  }

  const throwing = await checkSecurityLabToolStatus('gitleaks', {
    spawnFn: async () => { throw new Error('nope'); }
  });
  assert.deepEqual(throwing, { toolId: 'gitleaks', executionAllowed: true, installed: false, status: 'unavailable' });
});

test('status unit: unknown and non-enabled tools report unavailable without spawning', async () => {
  for (const toolId of ['nuclei', 'sqlmap', 'nope', null, 123]) {
    const calls = [];
    const result = await checkSecurityLabToolStatus(toolId, {
      spawnFn: async () => { calls.push(1); return {}; }
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.installed, false);
    assert.equal(result.executionAllowed, false);
    assert.equal(calls.length, 0);
  }
});

test('status unit: aggregate preserves adapter order and never rejects', async () => {
  const status = await getSecurityLabStatus({
    spawnFn: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false, notInstalled: true })
  });
  assert.equal(status.ok, true);
  assert.deepEqual(status.tools.map((tool) => tool.toolId), ['gitleaks', 'trivy', 'httpx', 'binwalk', 'subfinder', 'theharvester', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch']);
  assert.ok(status.tools.every((tool) => tool.status === 'not-installed'));
});

// ---------------------------------------------------------------------------
// HTTP endpoint.
// ---------------------------------------------------------------------------

const { app } = await import('../src/server.js');

const ADMIN = { id: 701, google_user_id: 'google-admin-seclabstatus', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 702, google_user_id: 'google-user-seclabstatus', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'seclabstatus-admin-sid';
const USER_SID = 'seclabstatus-user-sid';
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
const ALLOWED_KEYS = new Set(['toolId', 'executionAllowed', 'installed', 'status', 'version']);
const FORBIDDEN_KEYS = ['argv', 'command', 'shell', 'env', 'stderr', 'stdout', 'path', 'paths', 'sourceUrl', 'platforms', 'binary', 'error'];

test('status API: unauthenticated and non-admin access are rejected', async () => {
  const anon = await http('/api/admin/security-lab/status');
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/security-lab/status', { headers: { Cookie: USER_COOKIE } });
  assert.equal(user.status, 403);
});

test('status API: admin receives exactly the eleven enabled tools with safe shape', async () => {
  const res = await http('/api/admin/security-lab/status', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.tools.map((tool) => tool.toolId), ['gitleaks', 'trivy', 'httpx', 'binwalk', 'subfinder', 'theharvester', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch']);
  for (const tool of body.tools) {
    for (const key of Object.keys(tool)) {
      assert.ok(ALLOWED_KEYS.has(key), `unexpected key ${key}`);
      assert.ok(!FORBIDDEN_KEYS.includes(key), `forbidden key ${key}`);
    }
    assert.equal(tool.executionAllowed, true);
    assert.equal(typeof tool.installed, 'boolean');
    assert.ok(['ready', 'not-installed', 'unavailable'].includes(tool.status), tool.status);
    assert.equal(tool.installed, tool.status === 'ready');
    if (tool.version !== undefined) {
      assert.ok(typeof tool.version === 'string' && tool.version.length > 0 && tool.version.length <= 120);
      assert.ok(!tool.version.includes('\n'), 'version must be a single line');
    }
  }
  const blob = JSON.stringify(body);
  assert.ok(blob.length < 5000, 'status response must stay small');
  for (const forbidden of ['argv', 'stderr', 'stdout', 'ENOENT', 'scan-root', '/usr/bin', 'C:\\']) {
    assert.ok(!blob.includes(forbidden), `response leaks ${forbidden}`);
  }
});

test('status API: this host reports all eleven not-installed with no version', async () => {
  const res = await http('/api/admin/security-lab/status', { headers: { Cookie: ADMIN_COOKIE } });
  const body = await res.json();
  for (const tool of body.tools) {
    assert.equal(tool.installed, false, tool.toolId);
    assert.equal(tool.status, 'not-installed', tool.toolId);
    assert.equal('version' in tool, false, tool.toolId);
  }
});

test('status API: unknown query keys fail closed and POST is not routed', async () => {
  const evil = await http('/api/admin/security-lab/status?debug=1', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(evil.status, 400);
  const posted = await http('/api/admin/security-lab/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
    body: JSON.stringify({})
  });
  assert.ok([404, 405].includes(posted.status), `expected 404/405, got ${posted.status}`);
});

test('status API: process-spawning status path shares the per-user rate limit', async () => {
  resetSecurityLabRateLimits();
  let limited = 0;
  for (let i = 0; i < 11; i++) {
    const res = await http('/api/admin/security-lab/status', { headers: { Cookie: ADMIN_COOKIE } });
    if (res.status === 429) limited += 1;
    await res.text().catch(() => '');
  }
  assert.equal(limited, 1);
});

// ---------------------------------------------------------------------------
// UI skeleton + client safety.
// ---------------------------------------------------------------------------

test('security lab UI: skeleton exposes enabled regions without server-rendered runs', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="security-lab"'), 'card present');
  assert.ok(html.includes('id="security-lab-enabled-list"'), 'enabled list region present');
  assert.ok(html.includes('id="security-lab-enabled-note"'), 'availability note present');
  assert.ok(html.includes('id="security-lab-list"'), 'read-only catalog region preserved');
  assert.ok(html.includes('/admin-security-lab.js'), 'client script included');
  assert.ok(!html.includes('Confirm run'), 'no server-rendered run controls');
});

test('security lab UI: client runs only on explicit confirm with exact contract', async () => {
  const res = await http('/admin-security-lab.js');
  assert.equal(res.status, 200);
  const js = await res.text();
  assert.ok(js.includes('/api/admin/security-lab/status'), 'status endpoint wired');
  assert.ok(js.includes('/api/admin/security-lab/execute'), 'execute endpoint wired');
  // Exact contract: POST body carries only toolId + input.
  assert.ok(js.includes('JSON.stringify({ toolId: toolId, input: input })'), 'exact request body');
  // Two-step explicit action: Run reveals Confirm; confirm executes.
  assert.ok(js.includes('Confirm run'), 'confirm step present');
  // Double-submit prevention: running flag disables controls around the fetch.
  assert.ok(js.includes('controls.running = true'), 'running flag set');
  assert.ok(js.includes('run.disabled = true'), 'run disabled while active');
  // Run controls only for ready, execution-allowed tools.
  assert.ok(js.includes("tool.executionAllowed !== true"), 'disabled tools filtered');
  assert.ok(js.includes("state.status !== 'ready'"), 'run gated on ready status');
  assert.ok(js.includes('Not installed on the server'), 'not-installed notice present');
  // Safe rendering: text-only, no timers, no polling, no eval.
  assert.ok(js.includes('textContent'), 'text-only rendering');
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('eval('), 'no eval');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
  assert.ok(!js.includes('EventSource') && !js.includes('WebSocket'), 'no streaming');
  // Never automatic: the only POST sits behind the confirm click handler.
  const posts = js.split('EXECUTE_ENDPOINT').length - 1;
  assert.ok(posts >= 1, 'execute referenced');
  assert.ok(js.includes("confirm.addEventListener('click'"), 'POST reachable only via confirm click');
});
