import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

const USER = { id: 100, email: 'user@example.com', name: 'User', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 100000).toISOString() };
const ADMIN = { id: 101, email: 'admin@example.com', name: 'Admin', status: 'active', app_role: 'ADMIN', access_expires_at: new Date(Date.now() + 100000).toISOString() };

const USER_SID = 'footer-user-sid';
const ADMIN_SID = 'footer-admin-sid';

const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;

const sessionToUser = {
  [USER_SID]: USER,
  [ADMIN_SID]: ADMIN
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
});

function installPoolStub() {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    try {
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        const u = sessionToUser[params[0]];
        if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
        return { rows: [] };
      }
      if (/FROM ["']?users["']?/i.test(sql)) {
        if (params && params[0]) {
          const targetId = Number(params[0]);
          if (targetId === USER.id) return { rows: [USER] };
          if (targetId === ADMIN.id) return { rows: [ADMIN] };
        }
        return { rows: [ADMIN, USER], count: 2 };
      }
      if (/FROM ["']?rbac_user_roles["']?/i.test(sql)) {
        const targetId = Number(params[0]);
        if (targetId === ADMIN.id) return { rows: [{ user_id: ADMIN.id, role_key: 'ADMIN' }] };
        return { rows: [] };
      }
      if (/FROM ["']?folder_permissions["']?/i.test(sql)) {
        return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
      }
      return { rows: [], count: 0 };
    } catch {
      return { rows: [], count: 0 };
    }
  };
}

function restorePool() {
  if (originalQuery) pool.query = originalQuery;
}

function http(path, opts = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, opts);
}

test('footer visibility: Home (/) displays full "Connect With Us" section and footer links', async () => {
  installPoolStub();
  try {
    const res = await http('/', { headers: { 'Cookie': USER_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('class="site-footer"'), 'Home page must contain site-footer');
    assert.ok(html.includes('Connect With Us'), 'Home page must contain Connect With Us section');
    assert.ok(html.includes('learnwithmegw@gmail.com'), 'Home page must contain contact email');
    assert.ok(html.includes('class="footer-legal"'), 'Home page must contain footer-legal links');
    assert.ok(html.includes('href="/about"'), 'Home page must contain About link');
    assert.ok(html.includes('href="/privacy"'), 'Home page must contain Privacy Policy link');
  } finally {
    restorePool();
  }
});

test('footer visibility: Login (/login) displays full "Connect With Us" section and footer links', async () => {
  installPoolStub();
  try {
    const res = await http('/login');
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('class="site-footer"'), 'Login page must contain site-footer');
    assert.ok(html.includes('Connect With Us'), 'Login page must contain Connect With Us section');
    assert.ok(html.includes('learnwithmegw@gmail.com'), 'Login page must contain contact email');
    assert.ok(html.includes('class="footer-legal"'), 'Login page must contain footer-legal links');
    assert.ok(html.includes('href="/terms"'), 'Login page must contain Terms of Service link');
  } finally {
    restorePool();
  }
});

test('footer visibility: public legal/info pages display footer and "Connect With Us"', async () => {
  installPoolStub();
  try {
    const publicRoutes = [
      '/about',
      '/privacy',
      '/terms',
      '/contact',
      '/pricing',
      '/content-policy',
      '/refund-policy'
    ];

    for (const path of publicRoutes) {
      const res = await http(path);
      assert.equal(res.status, 200, `Page ${path} must return 200`);
      const html = await res.text();

      assert.ok(html.includes('class="site-footer"'), `Page ${path} must render site-footer`);
      assert.ok(html.includes('Connect With Us'), `Page ${path} must render Connect With Us section`);
      assert.ok(html.includes('learnwithmegw@gmail.com'), `Page ${path} must contain contact email`);
      assert.ok(html.includes('class="footer-legal"'), `Page ${path} must render footer-legal links`);
      assert.ok(html.includes('href="/about"'), `Page ${path} must contain About link`);
      assert.ok(html.includes('href="/privacy"'), `Page ${path} must contain Privacy Policy link`);
    }
  } finally {
    restorePool();
  }
});

test('footer visibility: footer is hidden on private/authenticated customer and admin pages', async () => {
  installPoolStub();
  try {
    const routesToTest = [
      { path: '/my/likes', cookie: USER_COOKIE },
      { path: '/my/new-content', cookie: USER_COOKIE },
      { path: '/discussions?path=Guidewire%2FGosu%2FPC%2FConfig%2FUnlocking%20from%20quoting.txt', cookie: USER_COOKIE },
      { path: '/account', cookie: USER_COOKIE },
      { path: '/plans', cookie: USER_COOKIE },
      { path: '/premium', cookie: USER_COOKIE },
      { path: '/admin', cookie: ADMIN_COOKIE },
      { path: '/admin/analytics', cookie: ADMIN_COOKIE },
      { path: '/admin/audit-logs', cookie: ADMIN_COOKIE },
      { path: '/admin/expiring-users', cookie: ADMIN_COOKIE },
      { path: '/admin/folders', cookie: ADMIN_COOKIE },
      { path: '/admin/paid-products', cookie: ADMIN_COOKIE },
      { path: '/admin/recent-activity', cookie: ADMIN_COOKIE },
      { path: '/admin/system', cookie: ADMIN_COOKIE },
      { path: '/admin/user-activity', cookie: ADMIN_COOKIE }
    ];

    for (const route of routesToTest) {
      const headers = route.cookie ? { 'Cookie': route.cookie } : {};
      const res = await http(route.path, { headers });
      const html = await res.text();

      assert.ok(!html.includes('class="site-footer"'), `Page ${route.path} must NOT render site-footer`);
      assert.ok(!html.includes('Connect With Us'), `Page ${route.path} must NOT render Connect With Us section`);
    }
  } finally {
    restorePool();
  }
});
