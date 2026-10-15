import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');

const ADMIN = {
  id: 100, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin',
  status: 'active', first_login_at: new Date(), last_login_at: new Date(),
  access_expires_at: null, app_role: 'ADMIN'
};

const ADMIN_SID = 'admin-org-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let fixtures = {
  users: [
    { id: 101, email: 'alice@example.com', name: 'Alice', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 10*86400000), app_role: 'USER', created_at: new Date() },
  ],
  stats: { total_users: 1, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 },
  popular: [
    { query_path: 'Guidewire/PolicyCenter.txt', views: 10, copies: 3 },
    { query_path: 'Guidewire/BillingCenter.txt', views: 5, copies: 1 }
  ],
  likedItems: [
    { item_path: 'Guidewire/PolicyCenter.txt', like_count: 2, likers: [{ name: 'Alice', email: 'alice@example.com', liked_at: new Date('2024-01-01T00:00:00Z') }, { name: 'Bob', email: 'bob@example.com', liked_at: new Date('2024-01-02T00:00:00Z') }] }
  ]
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      return { rows: params[0] === ADMIN.id ? [ADMIN] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [fixtures.stats] };
    }
    // popular queries - GROUP BY query_path with views/copies
    if (/FROM query_usage/.test(sql) && /GROUP BY query_path/.test(sql)) {
      return { rows: fixtures.popular };
    }
    // likedItems aggregated
    if (/FROM item_likes/.test(sql) && /array_agg/.test(sql) && /JSON_BUILD_OBJECT/.test(sql)) {
      return { rows: fixtures.likedItems };
    }
    // generic item_likes for user-activity enrichment (should not match array_agg case above)
    if (/FROM item_likes/.test(sql)) return { rows: [] };
    if (/FROM recently_viewed/.test(sql)) return { rows: [] };
    if (/FROM content_seen/.test(sql)) return { rows: [] };
    if (/access_audit_log/.test(sql)) return { rows: [] };
    if (/role_audit_log/.test(sql)) return { rows: [] };
    if (/content_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /ORDER BY created_at DESC/.test(sql)) {
      // For getUsersForAdmin fallback or activity users raw
      return { rows: fixtures.users };
    }
    if (/SELECT COUNT\(\*\)::int AS count FROM users/i.test(sql)) {
      return { rows: [{ count: fixtures.users.length }] };
    }
    if (/SELECT id, name, email FROM users ORDER BY/.test(sql)) {
      return { rows: fixtures.users.map(u => ({ id: u.id, name: u.name, email: u.email })) };
    }
    if (/SELECT id, google_user_id, email, name, status/.test(sql)) {
      return { rows: fixtures.users };
    }
    if (/unanswered_count/.test(sql)) {
      return { rows: [{ unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 0, recent_replies_count: 0 }] };
    }
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    return { rows: [] };
  };
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) { pool.query = originalQuery; originalQuery = null; }
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('Admin overview does NOT contain Popular Queries or Liked Items', async () => {
  const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('<h2>Popular queries</h2>'), 'admin should not contain Popular queries header');
  // Ensure the popular table is not present
  // The Likes section on admin previously had "Liked items" header
  assert.ok(!html.includes('<h2>Liked items</h2>'), 'admin should not contain Liked items header');
  // Additionally ensure admin still has administrative information
  assert.match(html, /Users/);
  assert.match(html, /data-testid="needs-attention"/);
});

test('User Activity & Learning page DOES contain Popular Queries and Liked Items', async () => {
  const res = await http('/admin/user-activity', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Popular queries/);
  assert.match(html, /Liked items/);
  // Popular queries data rendered (reuse displayName logic)
  assert.ok(html.includes('PolicyCenter'), 'popular query PolicyCenter should be rendered');
  assert.ok(html.includes('BillingCenter'), 'popular query BillingCenter should be rendered');
  // Liked items data rendered
  assert.ok(html.includes('PolicyCenter.txt') || html.includes('PolicyCenter'), 'liked item path should be rendered');
  assert.ok(html.includes('alice@example.com'), 'liker email should be rendered');
  assert.ok(html.includes('<th>Query</th>'), 'popular table header present');
  assert.ok(html.includes('<th>Item</th>'), 'liked items table header present');
  // Verify styling preserved
  assert.ok(html.includes('class="admin-table"'), 'admin-table styling preserved');
});

test('Popular and Liked sections are not duplicated on Admin overview', async () => {
  const adminRes = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
  const adminHtml = await adminRes.text();
  const activityRes = await http('/admin/user-activity', { headers: { Cookie: ADMIN_COOKIE } });
  const activityHtml = await activityRes.text();
  const adminPopularCount = (adminHtml.match(/Popular queries/g) || []).length;
  const activityPopularCount = (activityHtml.match(/Popular queries/g) || []).length;
  assert.equal(adminPopularCount, 0, 'admin should have 0 Popular queries sections');
  assert.equal(activityPopularCount, 1, 'user-activity should have exactly 1 Popular queries section');
  const adminLikedCount = (adminHtml.match(/Liked items/g) || []).length;
  const activityLikedCount = (activityHtml.match(/Liked items/g) || []).length;
  assert.equal(adminLikedCount, 0, 'admin should have 0 Liked items sections');
  assert.equal(activityLikedCount, 1, 'user-activity should have exactly 1 Liked items section');
});

test('Server reuses same query logic for Popular/Liked (no calculation change)', async () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // Popular query logic must exist and be in user-activity route
  assert.ok(src.includes("GROUP BY query_path"), 'popular GROUP BY present');
  assert.ok(src.includes("COUNT(*) FILTER (WHERE action = 'view')"), 'popular views calculation preserved');
  assert.ok(src.includes("COUNT(*) FILTER (WHERE action = 'copy')"), 'popular copies calculation preserved');
  assert.ok(src.includes("ORDER BY views DESC, copies DESC, query_path"), 'popular ordering preserved');
  // Liked items logic
  assert.ok(src.includes("array_agg(JSON_BUILD_OBJECT('name', u.name, 'email', u.email, 'liked_at'"), 'liked items aggregation preserved');
  assert.ok(src.includes("GROUP BY i.item_path"), 'liked items GROUP BY preserved');
  assert.ok(src.includes("ORDER BY like_count DESC, i.item_path"), 'liked items ordering preserved');
  // Ensure admin route no longer contains popular/liked query strings directly before auditLog
  // Check that admin.ejs no longer contains those sections
  const adminView = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin.ejs'), 'utf8');
  assert.ok(!adminView.includes('Popular queries'), 'admin.ejs should not contain Popular queries');
  assert.ok(!adminView.includes('Liked items'), 'admin.ejs should not contain Liked items');
  const activityView = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-user-activity.ejs'), 'utf8');
  assert.ok(activityView.includes('Popular queries'), 'admin-user-activity.ejs should contain Popular queries');
  assert.ok(activityView.includes('Liked items'), 'admin-user-activity.ejs should contain Liked items');
  // Verify admin route render does not pass popular/likedItems
  const adminRouteSnippet = src.split("app.get('/admin',")[1]?.split("app.get('/admin/premium'")[0] || '';
  assert.ok(!adminRouteSnippet.includes('popular:'), 'admin route should not pass popular');
  assert.ok(!adminRouteSnippet.includes('likedItems:'), 'admin route should not pass likedItems');
  const userActivitySnippet = src.split("app.get('/admin/user-activity'")[1]?.split("app.get('/admin/analytics'")[0] || '';
  assert.ok(userActivitySnippet.includes('popular'), 'user-activity route should pass popular');
  assert.ok(userActivitySnippet.includes('likedItems'), 'user-activity route should pass likedItems');
});
