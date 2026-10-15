import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

const USER_REGULAR = { id: 100, email: 'user@example.com', name: 'Regular User', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 100000).toISOString() };
const USER_ADMIN = { id: 101, email: 'admin@example.com', name: 'Admin User', status: 'active', app_role: 'ADMIN', access_expires_at: new Date(Date.now() + 100000).toISOString() };
const USER_OWNER = { id: 102, email: 'owner@example.com', name: 'Owner User', status: 'active', app_role: 'OWNER', access_expires_at: new Date(Date.now() + 100000).toISOString() };
const USER_PREMIUM = { id: 103, email: 'premium@example.com', name: 'Premium User', status: 'active', app_role: 'PREMIUM', access_expires_at: new Date(Date.now() + 100000).toISOString() };

const SID_REGULAR = 'sid-regular';
const SID_ADMIN = 'sid-admin';
const SID_OWNER = 'sid-owner';
const SID_PREMIUM = 'sid-premium';

const COOKIE_REGULAR = `connect.sid=s:${cookieSignature.sign(SID_REGULAR, process.env.SESSION_SECRET)}`;
const COOKIE_ADMIN = `connect.sid=s:${cookieSignature.sign(SID_ADMIN, process.env.SESSION_SECRET)}`;
const COOKIE_OWNER = `connect.sid=s:${cookieSignature.sign(SID_OWNER, process.env.SESSION_SECRET)}`;
const COOKIE_PREMIUM = `connect.sid=s:${cookieSignature.sign(SID_PREMIUM, process.env.SESSION_SECRET)}`;

const sessions = {
  [SID_REGULAR]: USER_REGULAR,
  [SID_ADMIN]: USER_ADMIN,
  [SID_OWNER]: USER_OWNER,
  [SID_PREMIUM]: USER_PREMIUM
};

const users = {
  100: USER_REGULAR,
  101: USER_ADMIN,
  102: USER_OWNER,
  103: USER_PREMIUM
};

let server = null;
let port = 0;

test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;

  // Install DB stub
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessions[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      const u = users[params[0]];
      return { rowCount: u ? 1 : 0, rows: u ? [u] : [] };
    }
    if (/SELECT .* FROM user_recently_viewed/i.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT COUNT\(.*\) FROM discussions/i.test(sql)) {
      return { rows: [{ count: '0' }] };
    }
    if (/SELECT .* FROM user_likes/i.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT COUNT\(.*\) FROM users/i.test(sql)) {
      return { rows: [{ count: '0' }] };
    }
    return { rowCount: 0, rows: [] };
  };
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
});

async function getPage(cookie, path = '/') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Cookie: cookie }
  });
  return { status: res.status, html: await res.text() };
}

test('Admin navigation link visibility by user role', async (t) => {
  await t.test('ADMIN user sees Admin navigation link', async () => {
    const { status, html } = await getPage(COOKIE_ADMIN, '/account');
    assert.equal(status, 200);
    assert.match(html, /data-testid="admin-nav-link"/);
    assert.match(html, /href="\/admin"/);
  });

  await t.test('OWNER user sees Admin navigation link', async () => {
    const { status, html } = await getPage(COOKIE_OWNER, '/account');
    assert.equal(status, 200);
    assert.match(html, /data-testid="admin-nav-link"/);
    assert.match(html, /href="\/admin"/);
  });

  await t.test('REGULAR user does NOT see Admin navigation link', async () => {
    const { status, html } = await getPage(COOKIE_REGULAR, '/account');
    assert.equal(status, 200);
    assert.doesNotMatch(html, /data-testid="admin-nav-link"/);
    assert.doesNotMatch(html, /href="\/admin"/);
  });

  await t.test('PREMIUM user does NOT see Admin navigation link', async () => {
    const { status, html } = await getPage(COOKIE_PREMIUM, '/account');
    assert.equal(status, 200);
    assert.doesNotMatch(html, /data-testid="admin-nav-link"/);
    assert.doesNotMatch(html, /href="\/admin"/);
  });
});
