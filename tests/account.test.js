import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

const USER = { id: 100, email: 'test@example.com', name: 'Test User', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 100000).toISOString() };
const USER_SID = 'account-test-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;

const sessionToUser = {
  [USER_SID]: USER
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

function installPoolStub(handler) {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (handler) {
      const custom = await handler(sql, params);
      if (custom !== undefined) return custom;
    }
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [USER] };
    }
    if (/SELECT g\.id, g\.valid_until/i.test(sql)) {
      return {
        rows: [
          {
            id: 1,
            valid_until: null,
            status: 'active',
            product_name: 'Test Product',
            product_code: 'TEST',
            plan_name: 'Test Plan',
            billing_type: 'one_time'
          },
          {
            id: 2,
            valid_until: new Date(Date.now() - 100000).toISOString(),
            status: 'expired',
            product_name: 'Old Product',
            product_code: 'OLD',
            plan_name: 'Old Plan',
            billing_type: 'recurring'
          }
        ]
      };
    }
    return { rowCount: 0, rows: [] };
  };
}

function restorePool() {
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
}

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('account page shows Active status and base account Access Until date in profile and topbar', async () => {
  process.env.PAID_PLANS_ENABLED = 'true';
  installPoolStub();
  const res = await http('/account', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); if (!html.includes('<strong>Status:</strong> Active')) console.log(html); assert.ok(html.includes('<strong>Status:</strong> Active'), 'Should show Active status');
  assert.ok(html.includes('<strong>Access Until:</strong>'), 'Should show Access Until label in profile');
  const expectedDate = new Date(USER.access_expires_at).toLocaleDateString();
  assert.ok(html.includes(expectedDate), `Should display base account access expiry date (${expectedDate})`);
  assert.ok(html.includes(`(Access Until: ${expectedDate})`), 'Should show Access Until date in top-right nav');
  assert.ok(!html.includes('Legacy Premium Access Until'), 'Should not show legacy premium access until');
  assert.ok(html.includes('Test Product'), 'Should show active grant');
  assert.ok(html.includes('ACTIVE'), 'Should mark active grant as ACTIVE');
  assert.ok(html.includes('Old Product'), 'Should show expired historical grant');
  assert.ok(html.includes('EXPIRED'), 'Should mark expired grant as EXPIRED');
  restorePool();
});

test('account page Access Until uses users.access_expires_at, NOT paid product grant dates', async () => {
  process.env.PAID_PLANS_ENABLED = 'true';
  const futureBaseDate = new Date('2027-05-20T00:00:00.000Z').toISOString();
  const grantExpiryDate = new Date('2028-12-31T00:00:00.000Z').toISOString();

  installPoolStub((sql, params) => {
    if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          id: USER.id,
          email: 'normal@example.com',
          name: 'Normal User',
          status: 'active',
          app_role: 'USER',
          access_expires_at: futureBaseDate
        }]
      };
    }
    if (/SELECT g\.id, g\.valid_until/i.test(sql)) {
      return {
        rows: [{
          id: 10,
          valid_until: grantExpiryDate,
          status: 'active',
          product_name: 'Java Pro',
          product_code: 'JAVA_PRO',
          plan_name: 'Annual Pass',
          billing_type: 'recurring'
        }]
      };
    }
    return undefined;
  });

  const res = await http('/account', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  const expectedBaseDateStr = new Date(futureBaseDate).toLocaleDateString();
  const expectedGrantDateStr = new Date(grantExpiryDate).toLocaleDateString();

  assert.ok(html.includes(`<strong>Access Until:</strong> ${expectedBaseDateStr}`), 'Base account Access Until in profile must match users.access_expires_at');
  assert.ok(html.includes(`(Access Until: ${expectedBaseDateStr})`), 'Base account Access Until in top-right nav must match users.access_expires_at');
  assert.ok(html.includes(`Until ${expectedGrantDateStr}`), 'Paid Product grant expiry date must remain separate in Paid Products section');
  assert.ok(!html.includes('Legacy Premium Access Until'), 'Legacy Premium Access Until must NOT be present');

  restorePool();
});

test('account page with PAID_PLANS_ENABLED=false hides plans links and Paid Products section', async () => {
  process.env.PAID_PLANS_ENABLED = 'false';
  installPoolStub((sql, params) => {
    if (/SELECT g\.id, g\.valid_until/i.test(sql)) {
      return { rows: [] };
    }
    return undefined;
  });

  const res = await http('/account', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(!html.includes('Available Plans'), 'Header and page must not show Available Plans when PAID_PLANS_ENABLED=false');
  assert.ok(!html.includes('/plans'), 'No links to /plans must exist on /account when PAID_PLANS_ENABLED=false');
  assert.ok(html.includes('<strong>Status:</strong> Active'), 'Profile details must still show Status');
  assert.ok(html.includes('<strong>Access Until:</strong>'), 'Profile details must still show Access Until');
  assert.ok(html.includes('(Access Until:'), 'Top-right nav must show Access Until date beside user name');
  assert.ok(!html.includes('Paid Products & Grants'), 'Paid Products & Grants section must be hidden when PAID_PLANS_ENABLED=false');

  // Also verify direct /plans returns 403
  const plansRes = await http('/plans', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(plansRes.status, 403);

  restorePool();
});

test('account page with PAID_PLANS_ENABLED=true shows Paid Products section, plans navigation, and upgrade link', async () => {
  process.env.PAID_PLANS_ENABLED = 'true';
  installPoolStub((sql, params) => {
    if (/SELECT g\.id, g\.valid_until/i.test(sql)) {
      return { rows: [] };
    }
    return undefined;
  });

  const res = await http('/account', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('Available Plans'), 'Header must render Available Plans when PAID_PLANS_ENABLED=true');
  assert.ok(html.includes('Paid Products & Grants'), 'Paid Products & Grants section must be shown when PAID_PLANS_ENABLED=true');
  assert.ok(html.includes('View Available Plans'), 'Empty state must offer View Available Plans link when PAID_PLANS_ENABLED=true');
  assert.ok(html.includes('href="/plans"'), 'Link to /plans must be present');
  assert.ok(html.includes('(Access Until:'), 'Top-right nav must show Access Until date beside user name');

  restorePool();
});

test('topbar header shows Access Until on Home (/), /my/likes, /new-content regardless of PAID_PLANS_ENABLED', async () => {
  installPoolStub();
  const expectedDate = new Date(USER.access_expires_at).toLocaleDateString();

  // Test with PAID_PLANS_ENABLED=false
  process.env.PAID_PLANS_ENABLED = 'false';

  const homeRes = await http('/', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.ok(homeHtml.includes(`(Access Until: ${expectedDate})`), 'Home page header must show Access Until date when PAID_PLANS_ENABLED=false');

  const likesRes = await http('/my/likes', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(likesRes.status, 200);
  const likesHtml = await likesRes.text();
  assert.ok(likesHtml.includes(`(Access Until: ${expectedDate})`), 'My Likes header must show Access Until date when PAID_PLANS_ENABLED=false');

  const newRes = await http('/my/new-content', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(newRes.status, 200);
  const newHtml = await newRes.text();
  assert.ok(newHtml.includes(`(Access Until: ${expectedDate})`), 'New Content header must show Access Until date when PAID_PLANS_ENABLED=false');

  // Test with PAID_PLANS_ENABLED=true
  process.env.PAID_PLANS_ENABLED = 'true';

  const homeRes2 = await http('/', { headers: { 'Cookie': USER_COOKIE } });
  assert.equal(homeRes2.status, 200);
  const homeHtml2 = await homeRes2.text();
  assert.ok(homeHtml2.includes(`(Access Until: ${expectedDate})`), 'Home page header must show Access Until date when PAID_PLANS_ENABLED=true');

  restorePool();
});

test('public pages (unauthenticated) do not show Access Until or user header', async () => {
  installPoolStub();

  const privacyRes = await http('/privacy');
  assert.equal(privacyRes.status, 200);
  const privacyHtml = await privacyRes.text();
  assert.ok(!privacyHtml.includes('(Access Until:'), 'Public privacy page must not show Access Until');
  assert.ok(!privacyHtml.includes('class="user"'), 'Public privacy page must not show user block');

  const termsRes = await http('/terms');
  assert.equal(termsRes.status, 200);
  const termsHtml = await termsRes.text();
  assert.ok(!termsHtml.includes('(Access Until:'), 'Public terms page must not show Access Until');

  const loginRes = await http('/login');
  assert.equal(loginRes.status, 200);
  const loginHtml = await loginRes.text();
  assert.ok(!loginHtml.includes('(Access Until:'), 'Public login page must not show Access Until');

  restorePool();
});
Public login page must not show Access Until');

  restorePool();
});
