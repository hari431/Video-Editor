import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN_SID = 'admin-premium-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const ADMIN = {
  id: 2, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'ADMIN', premium_source: null
};

// Control fixtures
let fixtures = {
  users: [
    { id: 10, email: 'sub@example.com', name: 'Sub User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'PREMIUM', premium_source: 'subscription', created_at: new Date(), subscription_status: 'active' },
    { id: 11, email: 'onetime@example.com', name: 'Onetime User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'PREMIUM', premium_source: 'one_time', created_at: new Date() },
    { id: 12, email: 'manual@example.com', name: 'Manual User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'PREMIUM', premium_source: 'manual', created_at: new Date() }
  ],
  stats: { total_users: 3, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 },
  popular: [], likedItems: [], auditLog: [], roleAuditLog: [], expiring: [], needs: { counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 } }
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === ADMIN_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: ADMIN.id }})}]};
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === ADMIN.id) return { rows: [ADMIN] };
      return { rows: [] };
    }
    if (/SELECT count\(\*\) FROM users/i.test(sql)) {
      if (sql.includes("status = 'pending'")) return { rows: [{ count: fixtures.stats.pending_users }] };
      if (sql.includes("access_expires_at <")) return { rows: [{ count: fixtures.expiring.length }] };
      return { rows: [{ count: fixtures.stats.total_users }] };
    }
    if (/total_users/i.test(sql) && /active_today/i.test(sql)) {
      return { rows: [fixtures.stats] };
    }
    if (/FROM users u/i.test(sql) || /SELECT \* FROM users ORDER BY/i.test(sql)) {
      return { rows: fixtures.users };
    }
    if (/SELECT \* FROM users WHERE status = 'pending'/i.test(sql)) return { rows: [] };
    if (/SELECT COUNT\(\*\) FROM discussions/i.test(sql)) return { rows: [{ count: fixtures.stats.total_discussions }] };
    if (/SELECT COUNT\(\*\) FROM replies/i.test(sql)) return { rows: [{ count: fixtures.stats.total_replies }] };
    if (sql.includes('SELECT count(distinct id) FROM discussions')) return { rows: [{count:0}] };
    if (sql.includes('SELECT count(id) FROM discussions WHERE')) return { rows: [{count:0}] };
    if (sql.includes('SELECT count(id) FROM replies WHERE')) return { rows: [{count:0}] };
    if (sql.includes('COUNT(*) as total')) return { rows: [{total:0}] };
    if (sql.includes('SELECT COUNT(*) as count FROM users WHERE access_expires_at')) return { rows: [{count: 0}] };
    console.log("Unmatched query: ", sql);
    return { rows: [], rowCount: 0 };
  };

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(() => {
  pool.query = originalQuery;
  if (server) server.close();
});

async function http(path, options = {}) {
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await fetch(url, { redirect: options.redirect || 'manual', ...options });
  const html = await res.text();
  return { status: res.status, headers: res.headers, html };
}

test('Admin UI displays One-Time Pass distinct from Subscription and Manual', async () => {
  const { status, html } = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  
  if (status !== 200) {
    console.error('HTML Response:', html);
  }
  assert.equal(status, 200, 'Admin page should load');
  
  // Verify Subscription User
  assert.match(html, /Sub:\s*active/);
  
  // Verify One-Time User
  assert.match(html, /One-Time Pass/);
  
  // Verify Manual User
  assert.match(html, /Manual \(Admin\)/);
  
  // The One-Time Pass badge should not be incorrectly labeled as Manual
  const oneTimeMatches = html.match(/One-Time Pass/g);
  assert.equal(oneTimeMatches.length, 1, 'Should find exactly one One-Time Pass label');
});
