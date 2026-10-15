import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = {
  id: 2,
  google_user_id: 'google-admin',
  email: 'admin@example.com',
  name: 'Admin',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: null,
  app_role: 'ADMIN'
};

const ADMIN_SID = 'admin-sid-default-test';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

test('DEFAULT_ACCESS_DAYS configures initial/default user approval access duration independently of PREMIUM_ACCESS_DAYS', async () => {
  process.env.DEFAULT_ACCESS_DAYS = '45';
  process.env.PREMIUM_ACCESS_DAYS = '15';

  const originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      return { rows: [ADMIN] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [{ total_users: 1, active_today: 1, active_month: 1, pending_users: 1, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    if (/FROM users/.test(sql) && /ORDER BY u.created_at DESC/.test(sql)) {
      return {
        rows: [
          {
            id: 10,
            google_user_id: 'pending-user',
            email: 'pending@example.com',
            name: 'Pending User',
            status: 'pending',
            first_login_at: new Date(),
            last_login_at: new Date(),
            access_expires_at: null,
            app_role: 'USER',
            created_at: new Date()
          }
        ]
      };
    }
    return { rows: [] };
  };

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/admin`, {
      headers: { Cookie: ADMIN_COOKIE }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify that DEFAULT_ACCESS_DAYS ('45') is used for pending user approval default option
    assert.ok(html.includes('45 days'), 'Admin page should render DEFAULT_ACCESS_DAYS (45 days) for pending user approval');
    // Verify PREMIUM_ACCESS_DAYS ('15') is NOT used for pending user approval default option
    assert.ok(!html.includes('15 days'), 'Admin approval default should not use PREMIUM_ACCESS_DAYS');
  } finally {
    server.close();
    pool.query = originalQuery;
    delete process.env.DEFAULT_ACCESS_DAYS;
    delete process.env.PREMIUM_ACCESS_DAYS;
  }
});
