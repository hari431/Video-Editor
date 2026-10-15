import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { getAccessExpiryReminder, formatExpiryIST } from '../src/auth/access-expiry.js';
import { requireAuth, requireApiAuth } from '../src/auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-04T00:00:00.000Z');

function userWithExpiry(offsetMs) {
  return { id: 1, email: 'user@example.com', name: 'User', access_expires_at: new Date(NOW.getTime() + offsetMs).toISOString() };
}

function reqFor(user) {
  return { isAuthenticated: () => !!user, user };
}
function resSpy() {
  const res = { statusCode: 200, redirected: null, body: null };
  res.redirect = to => { res.redirected = to; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}
const nextSpy = () => { const fn = () => { fn.called = true; }; fn.called = false; return fn; };

const partialPath = path.join(__dirname, '../src/views/partials/access-expiry.ejs');
const partialSrc = fs.readFileSync(partialPath, 'utf8');
function renderPartial(reminder) {
  return ejs.render(partialSrc, { accessExpiryReminder: reminder }, { filename: partialPath });
}

// --- Core logic ---

test('>7 days remaining → no reminder', () => {
  assert.equal(getAccessExpiryReminder(userWithExpiry(8 * DAY), NOW), null);
  assert.equal(getAccessExpiryReminder(userWithExpiry(30 * DAY), NOW), null);
  assert.equal(getAccessExpiryReminder(userWithExpiry(7 * DAY + 1000), NOW), null);
});

test('exactly 7 days remaining → warning', () => {
  const r = getAccessExpiryReminder(userWithExpiry(7 * DAY), NOW);
  assert.ok(r);
  assert.equal(r.level, 'warning');
  assert.equal(r.daysRemaining, 7);
});

test('1–7 days remaining → warning with remaining days', () => {
  const r3 = getAccessExpiryReminder(userWithExpiry(3 * DAY), NOW);
  assert.ok(r3);
  assert.equal(r3.level, 'warning');
  assert.equal(r3.daysRemaining, 3);

  const r1 = getAccessExpiryReminder(userWithExpiry(1 * DAY), NOW);
  assert.ok(r1);
  assert.equal(r1.level, 'warning');
  assert.equal(r1.daysRemaining, 1);
});

test('<1 day remaining → urgent warning', () => {
  const r12h = getAccessExpiryReminder(userWithExpiry(12 * 60 * 60 * 1000), NOW);
  assert.ok(r12h);
  assert.equal(r12h.level, 'urgent');

  const r1h = getAccessExpiryReminder(userWithExpiry(60 * 60 * 1000), NOW);
  assert.ok(r1h);
  assert.equal(r1h.level, 'urgent');
});

test('NULL / Never expires → no reminder', () => {
  assert.equal(getAccessExpiryReminder({ id: 1, email: 'a@b.c', access_expires_at: null }, NOW), null);
  assert.equal(getAccessExpiryReminder({ id: 1, email: 'a@b.c' }, NOW), null);
});

test('unauthenticated user → no reminder', () => {
  assert.equal(getAccessExpiryReminder(null, NOW), null);
  assert.equal(getAccessExpiryReminder(undefined, NOW), null);
});

test('already expired → no reminder (access control stays authoritative)', () => {
  assert.equal(getAccessExpiryReminder(userWithExpiry(-1000), NOW), null);
  assert.equal(getAccessExpiryReminder(userWithExpiry(0), NOW), null);
});

test('invalid expiry → no reminder', () => {
  assert.equal(getAccessExpiryReminder({ access_expires_at: 'not-a-date' }, NOW), null);
});

test('admin/owner → no reminder (Never expires)', () => {
  assert.equal(getAccessExpiryReminder({ access_expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(), app_role: 'ADMIN' }, NOW), null);
  assert.equal(getAccessExpiryReminder({ access_expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(), app_role: 'OWNER' }, NOW), null);
});

// --- IST display ---

test('expiry displayed in IST (Asia/Kolkata), consistent with Admin Users page', () => {
  const utc = '2026-10-01T10:00:00.000Z';
  const expected = new Date(utc).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
  assert.equal(formatExpiryIST(utc), expected);
  const reminder = getAccessExpiryReminder(
    { access_expires_at: utc },
    new Date(new Date(utc).getTime() - 3 * DAY)
  );
  assert.ok(reminder);
  assert.equal(reminder.expiryIST, expected);
  const helperSrc = fs.readFileSync(path.join(__dirname, '../src/auth/access-expiry.js'), 'utf8');
  assert.ok(helperSrc.includes('Asia/Kolkata'), 'helper must use Asia/Kolkata');
  assert.ok(partialSrc.includes('accessExpiryReminder.expiryIST'), 'partial must render precomputed IST date');
});

// --- Partial rendering ---

test('warning partial shows expiry date + remaining days, single banner, dismissible', () => {
  const html = renderPartial({ level: 'warning', expiresAt: new Date('2026-10-01T10:00:00Z'), daysRemaining: 7, expiryIST: '10/1/2026' });
  assert.ok(html.includes('data-testid="access-expiry-reminder"'));
  assert.ok(html.includes('10/1/2026'));
  assert.ok(html.includes('7 days'));
  assert.ok(html.includes('Your Learn with Me access expires on'));
  assert.ok(html.includes('access-expiry-dismiss'));
  assert.ok(html.includes('sessionStorage'), 'dismissal must use session-only storage (no DB)');
  assert.equal(html.match(/class="access-expiry-banner/g).length, 1, 'exactly one banner');
});

test('urgent partial shows expiry date without day count', () => {
  const html = renderPartial({ level: 'urgent', expiresAt: new Date('2026-10-01T10:00:00Z'), daysRemaining: null, expiryIST: '10/1/2026' });
  assert.ok(html.includes('10/1/2026'));
  assert.ok(html.includes('less than 1 day remaining'));
  assert.ok(html.includes('access-expiry-urgent'));
});

test('no reminder → partial renders nothing', () => {
  assert.equal(renderPartial(null).trim(), '');
  assert.equal(renderPartial(undefined).trim(), '');
});

// --- Placement: shared partial used once per authenticated template ---

test('authenticated templates include shared partial exactly once', () => {
  const templates = ['library.ejs', 'query.ejs', 'video.ejs', 'item.ejs', 'liked.ejs', 'discussions.ejs', 'discussion.ejs'];
  for (const name of templates) {
    const src = fs.readFileSync(path.join(__dirname, '../src/views', name), 'utf8');
    const count = (src.match(/partials\/access-expiry/g) || []).length;
    assert.equal(count, 1, `${name} must include the shared access-expiry partial exactly once`);
  }
});

// --- Server wiring: display-only, no auth/RBAC change, no public endpoint ---

test('server wires reminder via res.locals without touching authorization', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.ok(serverSrc.includes('getAccessExpiryReminder'), 'server must use the helper');
  assert.ok(serverSrc.includes('res.locals.accessExpiryReminder'), 'reminder must be exposed via res.locals');
  assert.ok(!/app\.get\(['"]\/api\/access-expir/.test(serverSrc), 'no public expiry endpoint allowed');
  assert.ok(!/app\.get\(['"]\/access-expir/.test(serverSrc.replace(/access-expired/g, '')), 'no public expiry endpoint allowed');
});

test('existing expired-user access behavior remains unchanged', () => {
  const expired = { id: 1, email: 'u@e.c', status: 'active', access_expires_at: new Date(Date.now() - 1000) };
  let res = resSpy();
  requireAuth(reqFor(expired), res, nextSpy());
  assert.equal(res.redirected, '/access-expired');

  res = resSpy();
  requireApiAuth(reqFor(expired), res, nextSpy());
  assert.equal(res.statusCode, 403);

  const active = { id: 1, email: 'u@e.c', status: 'active', access_expires_at: new Date(Date.now() + 30 * DAY) };
  res = resSpy();
  const next = nextSpy();
  requireAuth(reqFor(active), res, next);
  assert.equal(next.called, true);
});

test('banner CSS is present, professional and responsive', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/public/styles.css'), 'utf8');
  assert.ok(css.includes('.access-expiry-banner'), 'banner styles required');
  assert.ok(css.includes('.access-expiry-warning'), 'warning style required');
  assert.ok(css.includes('.access-expiry-urgent'), 'urgent style required');
  assert.ok(css.includes('@media'), 'responsive styles required');
});
