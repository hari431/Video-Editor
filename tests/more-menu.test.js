import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { clearFreeTvCache } from '../src/library/free-tv.js';

const { app } = await import('../src/server.js');

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const USERS = {
  active: { id: 341, email: 'more-active@example.com', name: 'Active', status: 'active', app_role: 'USER', access_expires_at: FUTURE, last_login_at: new Date(Date.now() - 3600000).toISOString() },
  expired: { id: 342, email: 'more-expired@example.com', name: 'Expired', status: 'expired', app_role: 'USER', access_expires_at: PAST },
  admin: { id: 343, email: 'more-admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN', access_expires_at: null }
};

const sessionToUser = {};
const cookies = {};
for (const [key, user] of Object.entries(USERS)) {
  const sid = `more-${key}-sid`;
  sessionToUser[sid] = user;
  cookies[key] = `connect.sid=s:${cookieSignature.sign(sid, process.env.SESSION_SECRET)}`;
}

let server;
let port;
let originalQuery;
let originalFetch;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/FROM ["']?users["']?/i.test(sql)) {
      const found = Object.values(USERS).find(u => Number(u.id) === Number(params[0]));
      if (found) return { rows: [{ ...found }] };
      return { rows: [] };
    }
    return { rows: [] };
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('raw.githubusercontent.com')) {
      return { ok: true, status: 200, text: async () => '#EXTM3U\n' };
    }
    return originalFetch(url, init);
  };
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  if (originalFetch) globalThis.fetch = originalFetch;
  delete process.env.FREE_TV_ENABLED;
  clearFreeTvCache();
});

test.beforeEach(() => {
  clearFreeTvCache();
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const authed = (key, extra = {}) => ({ ...extra, headers: { Cookie: cookies[key] } });

test('more menu: Exchange Rates lives under More and stays accessible', async () => {
  delete process.env.FREE_TV_ENABLED;
  const res = await http('/', authed('active'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('More ▾'), 'More menu must render');
  assert.ok(html.includes('href="/exchange-rates"'), 'Exchange Rates link must remain with unchanged href');
  assert.ok(html.includes('nav-more-menu'), 'links must sit inside the More dropdown container');
});

test('more menu: Exchange Rates is nested inside More, not a top-level item', async () => {
  delete process.env.FREE_TV_ENABLED;
  const html = await (await http('/', authed('active'))).text();
  const menuOpen = html.indexOf('nav-more-menu');
  const menuClose = html.indexOf('</details>');
  assert.ok(menuOpen !== -1 && menuClose > menuOpen, 'More dropdown must render');
  const inside = html.slice(menuOpen, menuClose);
  assert.ok(inside.includes('href="/exchange-rates"'), 'Exchange Rates must live inside the More menu');
  const headerBefore = html.slice(html.indexOf('<header'), menuOpen);
  assert.ok(!headerBefore.includes('href="/exchange-rates"'), 'Exchange Rates must not appear before the More menu as a top-level item');
});

test('more menu: Entertainment hidden initially with bored prompt and persisted Yes wiring', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/', authed('active'));
    assert.equal(res.status, 200);
    const html = await res.text();
    // Present for permitted users but hidden until Yes.
    assert.ok(html.includes('id="ftvNavLink" hidden'), 'Entertainment link must render hidden initially');
    assert.ok(html.includes('Are you feeling bored?'), 'bored prompt must render for permitted users');
    assert.ok(html.includes('id="ftvBoredYes"'), 'Yes action must render');
    // Client-side reveal + persistence wiring (no-JS changes server state: none).
    assert.ok(html.includes('ftvBoredYes') && html.includes('localStorage'), 'Yes must persist via localStorage and reveal the link');
    // Unrelated nav untouched.
    assert.ok(html.includes('href="/knowledge"'), 'Knowledge Base link must remain');
    assert.ok(html.includes('id="notesLink"'), 'My Notes link must remain');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('more menu: kill switch OFF means no Entertainment markup at all', async () => {
  delete process.env.FREE_TV_ENABLED;
  const html = await (await http('/', authed('active'))).text();
  assert.ok(!html.includes('id="ftvNavLink"'), 'no Entertainment link markup when disabled');
  assert.ok(!html.includes('id="ftvBored"'), 'no bored prompt markup when disabled');
  assert.ok(html.includes('More ▾'), 'More menu itself must still render for Exchange Rates');
});

test('more menu: expired users get neither prompt nor link, even with EXPIRED public access ON', async () => {
  const prevFlag = process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
  const prevFtv = process.env.FREE_TV_ENABLED;
  // Pin flag-independence: even when the expired-public-access flag admits
  // expired users into the library, per-user Entertainment visibility must
  // still deny them (it uses only isFreeTvVisibleToUser/hasFreeTvAccess).
  process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const res = await http('/', { ...authed('expired'), redirect: 'manual' });
    assert.equal(res.status, 200, 'flag ON must admit expired users to the library render');
    const html = await res.text();
    assert.ok(!html.includes('id="ftvNavLink"'), 'expired user must not receive the link regardless of the flag');
    assert.ok(!html.includes('id="ftvBored"'), 'expired user must not receive the prompt regardless of the flag');
    assert.ok(!html.includes('id="ftvBoredYes"'), 'expired user must not receive the Yes action regardless of the flag');
  } finally {
    if (prevFlag === undefined) delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
    else process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = prevFlag;
    if (prevFtv === undefined) delete process.env.FREE_TV_ENABLED;
    else process.env.FREE_TV_ENABLED = prevFtv;
  }
});

test('more menu: sits at the end of nav, after Admin and before search', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const html = await (await http('/', authed('admin'))).text();
    const moreIdx = html.indexOf('More ▾');
    assert.ok(moreIdx !== -1, 'More menu must render');
    assert.ok(html.indexOf('admin-nav-link') !== -1 && html.indexOf('admin-nav-link') < moreIdx, 'More must come after Admin');
    assert.ok(html.indexOf('id="notesLink"') !== -1 && html.indexOf('id="notesLink"') < moreIdx, 'More must come after My Notes');
    assert.ok(html.indexOf('id="searchForm"') > moreIdx, 'More must come before the search area');
    assert.ok(html.indexOf('href="/knowledge"') < moreIdx, 'Knowledge Base must keep its primary position');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

// ---------- Bored-prompt persistence: run the shipped inline script ----------
// Extracts the ftv reveal script from the served HTML and executes it in a
// minimal DOM stub, proving the actual shipped behavior (not a re-write).
function ftvScriptFrom(html) {
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const found = blocks.find(b => b.includes('ftvBoredYes'));
  assert.ok(found, 'shipped page must contain the bored-prompt script');
  return found.replace(/^<script>/, '').replace(/<\/script>$/, '');
}

function ftvAttrsFrom(html) {
  const tag = html.match(/<span[^>]*id="ftvBored"[^>]*>/) || html.match(/<span[^>]*>/);
  assert.ok(tag, 'shipped page must contain the bored prompt element');
  const day = (tag[0].match(/data-ftv-day="([^"]*)"/) || [])[1];
  const login = (tag[0].match(/data-ftv-login="([^"]*)"/) || [])[1];
  assert.ok(typeof day === 'string' && typeof login === 'string', 'prompt must carry day+login fingerprint');
  return { day, login };
}

function runFtvScript(script, attrs, seed) {
  const store = { ...(seed || {}) };
  const listeners = {};
  const els = {
    ftvNavLink: { hidden: true },
    ftvBored: { hidden: false, getAttribute: (k) => (k === 'data-ftv-day' ? attrs.day : k === 'data-ftv-login' ? attrs.login : null) },
    ftvBoredYes: { addEventListener: (t, f) => { listeners[t] = f; } }
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = { document: { getElementById: (id) => els[id] || null }, window: { localStorage }, localStorage, console };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { els, store, clickYes: () => { assert.ok(listeners.click, 'Yes action must be wired'); listeners.click(); } };
}

const yesterdayOf = (isoDay) => new Date(new Date(isoDay + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);

test('ftv bored persistence: Yes reveals Entertainment and stamps session+day', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const html = await (await http('/', authed('active'))).text();
    const attrs = ftvAttrsFrom(html);
    assert.equal(attrs.day, new Date().toISOString().slice(0, 10), 'fingerprint day must be the current server day');
    assert.equal(attrs.login, USERS.active.last_login_at, 'fingerprint login must track the existing last_login_at');
    const env = runFtvScript(ftvScriptFrom(html), attrs, null);
    assert.equal(env.els.ftvNavLink.hidden, true, 'starts hidden before Yes');
    env.clickYes();
    const saved = JSON.parse(env.store.ftvBoredYes);
    assert.equal(saved.v, 1);
    assert.equal(saved.day, attrs.day);
    assert.equal(saved.login, attrs.login);
    assert.equal(env.els.ftvNavLink.hidden, false, 'Yes reveals Entertainment');
    assert.equal(env.els.ftvBored.hidden, true, 'Yes hides the prompt');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('ftv bored persistence: same session and same day keeps it revealed', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const html = await (await http('/', authed('active'))).text();
    const attrs = ftvAttrsFrom(html);
    const env = runFtvScript(ftvScriptFrom(html), attrs, {
      ftvBoredYes: JSON.stringify({ v: 1, day: attrs.day, login: attrs.login })
    });
    assert.equal(env.els.ftvNavLink.hidden, false, 'matching session+day stays revealed without another click');
    assert.equal(env.els.ftvBored.hidden, true);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('ftv bored persistence: new calendar day resets to the prompt', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const html = await (await http('/', authed('active'))).text();
    const attrs = ftvAttrsFrom(html);
    const env = runFtvScript(ftvScriptFrom(html), attrs, {
      ftvBoredYes: JSON.stringify({ v: 1, day: yesterdayOf(attrs.day), login: attrs.login })
    });
    assert.equal(env.els.ftvNavLink.hidden, true, 'stale day must not reveal Entertainment');
    assert.equal(env.els.ftvBored.hidden, false, 'prompt must show again on a new day');
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});

test('ftv bored persistence: new login/session resets to the prompt', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  const prevLogin = USERS.active.last_login_at;
  try {
    const first = await (await http('/', authed('active'))).text();
    const firstAttrs = ftvAttrsFrom(first);
    // Simulate the user starting a NEW login: the existing last_login_at moves.
    USERS.active.last_login_at = new Date(new Date(prevLogin).getTime() + 5000).toISOString();
    const second = await (await http('/', authed('active'))).text();
    const secondAttrs = ftvAttrsFrom(second);
    assert.notEqual(secondAttrs.login, firstAttrs.login, 'new login must move the fingerprint');
    const env = runFtvScript(ftvScriptFrom(second), secondAttrs, {
      ftvBoredYes: JSON.stringify({ v: 1, day: secondAttrs.day, login: firstAttrs.login })
    });
    assert.equal(env.els.ftvNavLink.hidden, true, 'previous-session choice must not carry over');
    assert.equal(env.els.ftvBored.hidden, false, 'prompt must show again after a new login');
  } finally {
    USERS.active.last_login_at = prevLogin;
    delete process.env.FREE_TV_ENABLED;
  }
});

test('ftv bored persistence: legacy permanent flag re-asks once instead of breaking', async () => {
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const html = await (await http('/', authed('active'))).text();
    const attrs = ftvAttrsFrom(html);
    const env = runFtvScript(ftvScriptFrom(html), attrs, { ftvBoredYes: '1' });
    assert.equal(env.els.ftvNavLink.hidden, true, 'legacy flag must not auto-reveal');
    env.clickYes();
    assert.equal(JSON.parse(env.store.ftvBoredYes).v, 1, 'Yes migrates to the stamped format');
    assert.equal(env.els.ftvNavLink.hidden, false);
  } finally {
    delete process.env.FREE_TV_ENABLED;
  }
});
