import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const SID_USER = 'last-activity-user-sid';
const SID_ADMIN = 'last-activity-admin-sid';
const SID_OWNER = 'last-activity-owner-sid';

const COOKIE_USER = `connect.sid=s:${cookieSignature.sign(SID_USER, process.env.SESSION_SECRET)}`;
const COOKIE_ADMIN = `connect.sid=s:${cookieSignature.sign(SID_ADMIN, process.env.SESSION_SECRET)}`;
const COOKIE_OWNER = `connect.sid=s:${cookieSignature.sign(SID_OWNER, process.env.SESSION_SECRET)}`;

const USER = {
  id: 7001,
  google_user_id: 'google-last-activity-user',
  email: 'lastactivity@example.com',
  name: 'Last Activity User',
  status: 'active',
  app_role: 'USER',
  first_login_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
  last_login_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  last_activity_at: null,
  access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
};

const ADMIN = {
  id: 7002,
  google_user_id: 'google-last-activity-admin',
  email: 'admin-last@example.com',
  name: 'Admin Last',
  status: 'active',
  app_role: 'ADMIN',
  first_login_at: new Date(),
  last_login_at: new Date(),
  last_activity_at: null,
  access_expires_at: null,
  updated_at: new Date(),
  created_at: new Date(),
};

const OWNER = {
  id: 7003,
  google_user_id: 'google-last-activity-owner',
  email: 'owner-last@example.com',
  name: 'Owner Last',
  status: 'active',
  app_role: 'OWNER',
  first_login_at: new Date(),
  last_login_at: new Date(),
  last_activity_at: null,
  access_expires_at: null,
  updated_at: new Date(),
  created_at: new Date(),
};

const sessionToUserId = {
  [SID_USER]: USER.id,
  [SID_ADMIN]: ADMIN.id,
  [SID_OWNER]: OWNER.id,
};

let originalQuery, originalConnect;
let server, port;
let activityUpdateCount = 0;
let lastActivityUpdateParams = [];

// in-memory user store for mock deserialization
const userStore = new Map();
function resetUserStore() {
  userStore.set(USER.id, { ...USER });
  userStore.set(ADMIN.id, { ...ADMIN });
  userStore.set(OWNER.id, { ...OWNER });
  activityUpdateCount = 0;
  lastActivityUpdateParams = [];
}

test.before(async () => {
  resetUserStore();
  originalQuery = pool.query;
  originalConnect = pool.connect;

  pool.query = async (sql, params = []) => {
    const s = String(sql);
    // session lookup
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(s)) {
      const sid = params[0];
      const uid = sessionToUserId[sid];
      if (uid) {
        return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: uid } }) }] };
      }
      return { rows: [] };
    }
    // deserializeUser SELECT * FROM users WHERE id = $1
    if (/SELECT \* FROM users WHERE id = \$1/i.test(s)) {
      const uid = Number(params[0]);
      const u = userStore.get(uid);
      if (u) return { rows: [{ ...u }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    // activity throttled update
    if (/UPDATE users SET last_activity_at = NOW\(\) WHERE id = \$1 AND \(last_activity_at IS NULL OR last_activity_at < NOW\(\) - INTERVAL '24 hours'\)/i.test(s)) {
      activityUpdateCount++;
      lastActivityUpdateParams.push([...params]);
      const uid = Number(params[0]);
      const u = userStore.get(uid);
      if (!u) return { rowCount: 0, rows: [] };
      const now = new Date();
      const last = u.last_activity_at ? new Date(u.last_activity_at) : null;
      const shouldUpdate = !last || (now.getTime() - last.getTime() >= 24 * 60 * 60 * 1000);
      if (shouldUpdate) {
        u.last_activity_at = new Date(now);
        userStore.set(uid, u);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
    // generic SELECT for folder permissions / ad settings
    if (/folder_permissions/.test(s)) return { rows: [] };
    if (/ad_settings/.test(s)) return { rows: [] };
    if (/user_roles/.test(s)) return { rows: [] };
    if (/paid_products/.test(s) || /user_product_grants/.test(s)) return { rows: [] };
    if (/recently_viewed/.test(s) || /content_seen/.test(s) || /video_views/.test(s) || /query_usage/.test(s)) return { rows: [] };
    // touchExistingUser / create etc. – capture but not needed for activity middleware test
    if (/UPDATE users\s+SET email/.test(s) && /last_login_at/.test(s)) {
      // For login tests, we want to simulate update – record and return row
      const uid = Number(params[0]);
      const u = userStore.get(uid);
      if (u) {
        // update fields if includes last_activity_at
        if (s.includes('last_activity_at')) {
          u.last_activity_at = new Date();
          u.last_login_at = new Date();
          u.updated_at = new Date();
          userStore.set(uid, u);
        } else {
          u.last_login_at = new Date();
          u.updated_at = new Date();
          userStore.set(uid, u);
        }
        return { rows: [{ ...u }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO users/.test(s)) {
      // createPending / createAdmin – just return mock row
      return { rows: [{ id: 9999, email: 'new@example.com', status: 'pending' }], rowCount: 1 };
    }
    // fallback
    return { rows: [], rowCount: 0 };
  };

  pool.connect = async () => ({
    query: pool.query,
    release: () => {},
  });

  const { app } = await import('../src/server.js');
  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  if (originalConnect) pool.connect = originalConnect;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);

// helpers to reset between tests
function resetCounts() {
  activityUpdateCount = 0;
  lastActivityUpdateParams = [];
}

test('unauthenticated requests do not update last_activity_at', async () => {
  resetCounts();
  const res = await http('/health');
  assert.equal(res.status, 200);
  // give middleware a chance to fire (fire-and-forget)
  await new Promise(r => setTimeout(r, 50));
  assert.equal(activityUpdateCount, 0, 'unauthenticated should not trigger activity update');
});

test('first authenticated activity updates last_activity_at', async () => {
  resetUserStore();
  resetCounts();
  // ensure user has null last_activity_at initially
  const u = userStore.get(USER.id);
  assert.equal(u.last_activity_at, null);
  const res = await http('/', { headers: { Cookie: COOKIE_USER } });
  // allow async update to complete
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activityUpdateCount, 1, 'first activity should trigger one UPDATE');
  assert.equal(lastActivityUpdateParams[0][0], USER.id);
  const updated = userStore.get(USER.id);
  assert.ok(updated.last_activity_at instanceof Date, 'last_activity_at should be set');
});

test('repeated requests within 24 hours do NOT cause another DB update', async () => {
  resetCounts();
  // user now has recent last_activity_at from previous test
  const before = activityUpdateCount;
  const res1 = await http('/', { headers: { Cookie: COOKIE_USER } });
  await new Promise(r => setTimeout(r, 50));
  const res2 = await http('/', { headers: { Cookie: COOKIE_USER } });
  await new Promise(r => setTimeout(r, 50));
  const res3 = await http('/health', { headers: { Cookie: COOKIE_USER } }); // health is unauth? but we send cookie
  await new Promise(r => setTimeout(r, 50));
  assert.equal(activityUpdateCount, before, 'within 24h should not update');
});

test('activity after 24 hours updates again', async () => {
  resetCounts();
  // manually set last_activity_at to 25 hours ago
  const u = userStore.get(USER.id);
  u.last_activity_at = new Date(Date.now() - 25 * 60 * 60 * 1000);
  userStore.set(USER.id, u);
  const res = await http('/', { headers: { Cookie: COOKIE_USER } });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activityUpdateCount, 1, 'after 24h should update');
  const updated = userStore.get(USER.id);
  assert.ok(Date.now() - new Date(updated.last_activity_at).getTime() < 5000, 'should be recent');
});

test('admin activity is also tracked (but excluded from deletion later)', async () => {
  resetCounts();
  const adminU = userStore.get(ADMIN.id);
  adminU.last_activity_at = null;
  userStore.set(ADMIN.id, adminU);
  const res = await http('/', { headers: { Cookie: COOKIE_ADMIN } });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activityUpdateCount, 1);
  assert.equal(lastActivityUpdateParams[0][0], ADMIN.id);
});

test('owner activity is also tracked', async () => {
  resetCounts();
  const ownerU = userStore.get(OWNER.id);
  ownerU.last_activity_at = null;
  userStore.set(OWNER.id, ownerU);
  const res = await http('/', { headers: { Cookie: COOKIE_OWNER } });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activityUpdateCount, 1);
  assert.equal(lastActivityUpdateParams[0][0], OWNER.id);
});

test('successful login updates last_activity_at (touchExistingUser)', async () => {
  // directly test the DB function
  const { touchExistingUser } = await import('../src/auth/users.js');
  resetCounts();
  const u = userStore.get(USER.id);
  u.last_activity_at = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  u.last_login_at = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  userStore.set(USER.id, u);
  const profile = { id: USER.google_user_id, emails: [{ value: USER.email }], displayName: USER.name };
  const updated = await touchExistingUser(USER.id, profile);
  assert.ok(updated.last_activity_at, 'touchExistingUser should set last_activity_at');
  assert.ok(updated.last_login_at, 'last_login_at still set');
  // verify last_activity_at is recent (within few seconds)
  assert.ok(Date.now() - new Date(updated.last_activity_at).getTime() < 5000);
  // ensure last_login_at semantics unchanged – still NOW
  assert.ok(Date.now() - new Date(updated.last_login_at).getTime() < 5000);
});

test('createPendingUser sets last_activity_at', async () => {
  const { createPendingUser } = await import('../src/auth/users.js');
  const profile = { id: 'google-new-123', emails: [{ value: 'newuser@example.com' }], displayName: 'New User' };
  // mock will return row with pending – we just check that query was attempted with last_activity_at
  // Our mock above handles INSERT – we need to capture SQL
  let capturedSql = null;
  const prevQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO users/.test(sql)) capturedSql = sql;
    return prevQuery(sql, params);
  };
  const user = await createPendingUser(profile);
  assert.ok(capturedSql && capturedSql.includes('last_activity_at'), 'INSERT should include last_activity_at');
  pool.query = prevQuery;
});

test('existing login/session behavior unchanged – last_login_at still updates on login', async () => {
  const { touchExistingUser } = await import('../src/auth/users.js');
  const before = new Date(userStore.get(USER.id).last_login_at);
  await new Promise(r => setTimeout(r, 10));
  const profile = { id: USER.google_user_id, emails: [{ value: USER.email }], displayName: USER.name };
  await touchExistingUser(USER.id, profile);
  const after = new Date(userStore.get(USER.id).last_login_at);
  assert.ok(after.getTime() > before.getTime(), 'last_login_at should still be updated');
});

test('activity update is non-blocking – request returns quickly without waiting for DB', async () => {
  resetCounts();
  const u = userStore.get(USER.id);
  u.last_activity_at = null;
  userStore.set(USER.id, u);
  const start = Date.now();
  const res = await http('/', { headers: { Cookie: COOKIE_USER } });
  const duration = Date.now() - start;
  assert.ok(duration < 1000, `request should not be slowed by activity update, took ${duration}ms`);
  assert.equal(res.status, 200);
  // update happens async after response
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activityUpdateCount, 1);
});
