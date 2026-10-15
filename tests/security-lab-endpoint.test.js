import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 501, google_user_id: 'google-admin-seclab', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 502, google_user_id: 'google-user-seclab', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'seclab-admin-sid';
const USER_SID = 'seclab-user-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let originalQuery = null;
let server;
let port;

test.before(async () => {
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
const ALLOWED_KEYS = new Set(['id', 'name', 'category', 'description', 'sourceUrl', 'platforms', 'riskLevel', 'executionAllowed', 'readOnly']);

test('security lab API: unauthenticated and non-admin access are rejected', async () => {
  const anon = await http('/api/admin/security-lab/tools');
  assert.equal(anon.status, 401);
  const user = await http('/api/admin/security-lab/tools', { headers: { Cookie: USER_COOKIE } });
  assert.equal(user.status, 403);
});

test('security lab API: admin receives bounded catalog with Step 3 execution flags', async () => {
  const res = await http('/api/admin/security-lab/tools', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.count >= 10 && body.count <= 15);
  assert.equal(body.tools.length, body.count);
  const EXECUTION_ENABLED = new Set(['gitleaks', 'trivy', 'httpx', 'binwalk', 'subfinder', 'theharvester', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch']);
  for (const tool of body.tools) {
    for (const key of Object.keys(tool)) {
      assert.ok(ALLOWED_KEYS.has(key), `unexpected key ${key}`);
    }
    assert.ok(typeof tool.id === 'string' && tool.id.length > 0);
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
    assert.ok(typeof tool.sourceUrl === 'string' && tool.sourceUrl.startsWith('https://github.com/'));
    assert.ok(Array.isArray(tool.platforms) && tool.platforms.length > 0);
    assert.equal(tool.executionAllowed, EXECUTION_ENABLED.has(tool.id), tool.id);
    assert.equal(tool.readOnly, true);
    assert.equal('runCommands' in tool, false);
    assert.equal('command' in tool, false);
  }
  assert.ok(JSON.stringify(body).length < 20000, 'catalog response must stay bounded');
});

test('security lab API: filters are ANDed, bounded, and fail closed', async () => {
  const secret = await http('/api/admin/security-lab/tools?category=secret-scanning', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(secret.status, 200);
  assert.equal((await secret.json()).count, 2);

  const unknown = await http('/api/admin/security-lab/tools?category=exploit-framework', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).count, 0);

  const evil = await http('/api/admin/security-lab/tools?dropTable=1', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(evil.status, 400);

  const limited = await http('/api/admin/security-lab/tools?limit=2', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal((await limited.json()).tools.length, 2);
});

test('security lab API: no POST route exists (read-only)', async () => {
  const res = await http('/api/admin/security-lab/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
    body: JSON.stringify({ id: 'nuclei' })
  });
  assert.ok([404, 405].includes(res.status), `expected 404/405, got ${res.status}`);
});

test('security lab UI: /admin/ai renders the skeleton card for admins only', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="security-lab"'), 'security lab card present');
  assert.ok(html.includes('id="security-lab-status"'), 'status badge present');
  assert.ok(html.includes('id="security-lab-list"'), 'list region present');
  assert.ok(html.includes('never automatic'), 'admin-only notice present');
  assert.ok(html.includes('/admin-security-lab.js'), 'security lab script included');
  assert.ok(!html.includes('Gitleaks') || html.includes('security-lab-summary'), 'no server-rendered tool rows required');

  const user = await http('/admin/ai', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.ok([302, 403].includes(user.status));
  const userHtml = await user.text().catch(() => '');
  assert.ok(!userHtml.includes('data-testid="security-lab"'), 'card must not leak to non-admins');
});

test('security lab UI: client script is served and renders safely', async () => {
  const res = await http('/admin-security-lab.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const js = await res.text();
  assert.ok(js.includes('/api/admin/security-lab/tools'), 'tools endpoint wired');
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
  assert.ok(js.includes('textContent'), 'text-only rendering');
  assert.ok(js.includes('https:\\/\\/github\\.com\\/'), 'source URL allowlist present');
});

test('security lab router: source registers admin-only GET+POST with no execution surface', async () => {
  const raw = await readFile(new URL('../src/security-lab/router.js', import.meta.url), 'utf8');
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.match(source, /requireApiAuth,\s*requireAdmin/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /app\.get\('\/api\/admin\/security-lab\/tools'/);
  assert.match(source, /app\.post\('\/api\/admin\/security-lab\/execute'/);
  // Spawning lives only in `./executor.js`; the router must not spawn itself.
  assert.doesNotMatch(source, /child_process|execSync|spawn\(|execFile|fork\(/i);
  assert.doesNotMatch(source, /process\.env|fetch\(|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /\bsqlmap\b|\bhydra\b|\bmetasploit\b|\baircrack\b|\bwifite\b|\bbeef\b/i);
});
