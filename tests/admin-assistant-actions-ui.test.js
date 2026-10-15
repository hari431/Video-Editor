import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import cookieSignature from 'cookie-signature';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { listPlannedActions } from '../src/admin-assistant/actions.js';

const { app } = await import('../src/server.js');

const ADMIN = { id: 601, google_user_id: 'google-admin-acts-ui', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 602, google_user_id: 'google-user-acts-ui', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), last_activity_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const ADMIN_SID = 'acts-ui-admin-sid';
const USER_SID = 'acts-ui-user-sid';
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
const scriptUrl = new URL('../src/public/admin-actions.js', import.meta.url);

// ── Minimal DOM stub harness (follows tests/more-menu.test.js vm pattern) ──

function stubEl(tag) {
  const node = {
    tag,
    children: [],
    listeners: {},
    style: {},
    dataset: {},
    className: '',
    disabled: false,
    type: '',
    href: '',
    appendChild(c) {
      node.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      return c;
    },
    addEventListener(t, f) {
      (node.listeners[t] = node.listeners[t] || []).push(f);
    }
  };
  // Mirror real DOM textContent semantics closely enough for assertions:
  // own text plus the concatenated text of descendants.
  let ownText = '';
  Object.defineProperty(node, 'textContent', {
    get: () => ownText + node.children.map(c => c.textContent).join(''),
    set: v => {
      ownText = v == null ? '' : String(v);
    },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  return node;
}

const ACTION_EL_IDS = [
  'actions-card', 'actions-status', 'actions-list', 'actions-confirm',
  'actions-confirm-label', 'actions-confirm-desc', 'actions-run',
  'actions-cancel', 'actions-result', 'actions-error'
];

function runActionsScript(fetchStub) {
  const els = {};
  for (const id of ACTION_EL_IDS) els[id] = stubEl('div');
  const created = [];
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: id => els[id] || null,
      createElement: tag => {
        const node = stubEl(tag);
        created.push(node);
        return node;
      },
      addEventListener: () => {}
    },
    fetch: fetchStub,
    console
  };
  vm.createContext(sandbox);
  return { els, created, sandbox };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function selectButtons(els) {
  return els['actions-list'].children
    .flatMap(li => li.children.filter(c => c.tag === 'button'))
    .filter(b => (b.listeners.click || []).length > 0);
}

function fakeResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

// ── Server-rendered skeleton ──

test('actions UI: /admin renders the confirmation panel skeleton for admins', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-testid="admin-actions"'), 'actions card present');
  for (const id of ['actions-card', 'actions-status', 'actions-list', 'actions-confirm', 'actions-confirm-label', 'actions-confirm-desc', 'actions-run', 'actions-cancel', 'actions-result', 'actions-error']) {
    assert.ok(html.includes(`id="${id}"`), `skeleton element ${id} present`);
  }
  assert.ok(html.includes('no changes will be made'), 'read-only confirmation notice present');
  assert.ok(html.includes('/admin-actions.js'), 'actions script included');
  // Skeleton only: no server-rendered action rows or results.
  assert.ok(!html.includes('access.review-queue'), 'no action data server-rendered');
});

test('actions UI: non-admin dashboard never exposes the panel', async () => {
  const res = await http('/admin/ai', { headers: { Cookie: USER_COOKIE }, redirect: 'manual' });
  assert.ok([302, 403].includes(res.status), `expected redirect or forbidden, got ${res.status}`);
  const html = await res.text().catch(() => '');
  assert.ok(!html.includes('data-testid="admin-actions"'), 'panel must not leak to non-admins');
});

test('actions UI: client script is served and statically safe', async () => {
  const res = await http('/admin-actions.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const js = await res.text();
  assert.ok(!js.includes('innerHTML'), 'no innerHTML rendering');
  assert.ok(!js.includes('setInterval') && !js.includes('setTimeout'), 'no timers or polling');
  assert.ok(!js.includes('eval(') && !js.includes('new Function'), 'no dynamic code');
  assert.ok(js.includes('textContent'), 'text-only rendering');
  assert.ok(js.includes('/^\\/admin([#?/]|$)/'), 'evidence URL allowlist present');
  assert.ok(js.includes('/api/admin/assistant/execute'), 'execute endpoint wired');
  assert.equal((js.match(/fetch\(/g) || []).length, 1, 'exactly one fetch call site (run-after-confirm only)');
  // The read-only confirmation notice itself is server-rendered skeleton
  // (asserted in the skeleton test); the client must never auto-execute,
  // which the vm behavior tests below prove directly.
});

test('actions UI: client allowlist matches the server registry exactly', async () => {
  const js = await readFile(scriptUrl, 'utf8');
  const ids = [...js.matchAll(/\bid:\s*'([a-z]+\.[a-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(ids, listPlannedActions().map(a => a.id));
});

// ── Behavior in a stub DOM (no auto-execute, confirm gate, exact body) ──

test('actions UI: nothing executes on load; selection opens confirmation only', async () => {
  const js = await readFile(scriptUrl, 'utf8');
  const calls = [];
  const env = runActionsScript(async () => {
    calls.push(1);
    return fakeResponse(null, false, 500);
  });
  vm.runInContext(js, env.sandbox);
  await flush();
  assert.equal(calls.length, 0, 'init must not fetch (no auto-execution)');
  assert.equal(env.els['actions-list'].children.length, 5, 'all 5 plans listed');

  const buttons = selectButtons(env.els);
  assert.equal(buttons.length, 5, 'one select button per plan');
  buttons[0].listeners.click[0]();
  assert.equal(calls.length, 0, 'selection alone must not fetch');
  assert.notEqual(env.els['actions-confirm'].style.display, 'none', 'confirmation shown');
  assert.equal(env.els['actions-confirm-label'].textContent, 'Review pending access queue');
  assert.ok(env.els['actions-confirm-desc'].textContent.length > 0, 'confirmation describes the plan');

  // Cancel closes the confirmation without any request.
  env.els['actions-cancel'].listeners.click[0]();
  assert.equal(env.els['actions-confirm'].style.display, 'none', 'confirmation hidden after cancel');
  assert.equal(calls.length, 0, 'cancel must not fetch');
});

test('actions UI: run sends exactly {actionId} and renders executed results as text', async () => {
  const js = await readFile(scriptUrl, 'utf8');
  const calls = [];
  let resolveFetch;
  const env = runActionsScript((url, opts) => {
    calls.push({ url, opts });
    return new Promise(resolve => {
      resolveFetch = resolve;
    });
  });
  vm.runInContext(js, env.sandbox);
  await flush();
  selectButtons(env.els)[2].listeners.click[0]();
  env.els['actions-run'].listeners.click[0]();
  await flush();
  assert.equal(calls.length, 1, 'exactly one request per confirmation');
  assert.equal(calls[0].url, '/api/admin/assistant/execute');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { actionId: 'health.snapshot' });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].opts.body)), ['actionId']);

  // Double-click while running must not duplicate the request.
  env.els['actions-run'].listeners.click[0]();
  await flush();
  assert.equal(calls.length, 1, 'in-flight run is not duplicated');

  // Hostile HTML in server data must render as inert text, never markup.
  resolveFetch(fakeResponse({
    ok: true,
    status: 'executed',
    actionId: 'health.snapshot',
    label: 'Capture runtime health snapshot',
    summary: 'Runtime health overall: healthy.',
    findings: [{
      id: 'health:x',
      title: '<img src=x onerror=alert(1)>',
      level: 'warning',
      evidenceRefs: [{ section: 'health', label: 'Evil', url: 'javascript:alert(1)' }]
    }],
    evidenceRefs: [],
    checks: []
  }));
  await flush();
  const boxText = JSON.stringify(env.els['actions-result'].children.map(c => c.textContent));
  assert.ok(boxText.includes('<img src=x onerror=alert(1)>'), 'finding title rendered as text');
  const links = [];
  const walk = node => {
    if (node.tag === 'a') links.push(node.href);
    for (const child of node.children || []) walk(child);
  };
  walk(env.els['actions-result']);
  assert.deepEqual(links, [], 'unsafe evidence URL dropped, no anchors created');
});

test('actions UI: blocked and unavailable states render generically without internals', async () => {
  const js = await readFile(scriptUrl, 'utf8');
  const cases = [
    [{ ok: false, status: 'blocked', reason: 'evidence-unavailable', message: 'Required evidence is currently unavailable.', checks: [] }, 'Blocked'],
    [{ ok: false, status: 'unavailable', reason: 'unknown-action', message: 'Unknown action id.', checks: [] }, 'Unavailable']
  ];
  for (const [payload, badge] of cases) {
    const env = runActionsScript(async () => fakeResponse(payload, false, payload.status === 'blocked' ? 503 : 422));
    vm.runInContext(js, env.sandbox);
    await flush();
    selectButtons(env.els)[0].listeners.click[0]();
    env.els['actions-run'].listeners.click[0]();
    await flush(6);
    const text = JSON.stringify(env.els['actions-result'].children.map(c => c.textContent));
    assert.ok(text.includes(payload.message), `${badge} message shown`);
    assert.ok(text.includes(payload.reason), `${badge} reason shown`);
    assert.equal(env.els['actions-status'].textContent, badge);
    assert.doesNotMatch(text, /stack|at Object|Error: /i);
  }
});

test('actions UI: run with no selection sends nothing', async () => {
  const js = await readFile(scriptUrl, 'utf8');
  const calls = [];
  const env = runActionsScript(async () => {
    calls.push(1);
    return fakeResponse(null, false, 500);
  });
  vm.runInContext(js, env.sandbox);
  await flush();
  env.els['actions-run'].listeners.click[0]();
  await flush();
  assert.equal(calls.length, 0, 'run without selection must not fetch');
});
