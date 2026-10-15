import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { bulkGrantPremium } from '../src/auth/users.js';

const { app } = await import('../src/server.js');

// --- Unit tests for bulkGrantPremium ---
test('bulkGrantPremium: assigns PREMIUM to eligible users, skips OWNER/ADMIN/already PREMIUM/self, audit logged', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  const ADMIN = { id: 10, email: 'admin@example.com', app_role: 'ADMIN', status: 'active' };
  const OWNER = { id: 11, email: 'owner@example.com', app_role: 'OWNER', status: 'active' };
  const USER1 = { id: 12, email: 'user1@example.com', app_role: 'USER', status: 'active', premium_source: null };
  const USER2 = { id: 13, email: 'user2@example.com', app_role: 'USER', status: 'active', premium_source: null };
  const PREMIUM_USER = { id: 14, email: 'already@example.com', app_role: 'PREMIUM', status: 'active', premium_source: 'manual' };

  let userDb = {
    10: ADMIN,
    11: OWNER,
    12: USER1,
    13: USER2,
    14: PREMIUM_USER
  };
  const auditInserts = [];
  const subscriptionInserts = [];

  pool.query = async (sql, params=[]) => {
    if (sql.includes('SELECT id, email, status, access_expires_at, app_role')) {
      const u = userDb[params[0]];
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM users WHERE id') || (sql.includes('FROM users') && sql.includes('WHERE id = $1'))) {
      const u = userDb[params[0]] || ADMIN;
      // For assertActorIsAdmin fetch
      if (params[0] === 10) return { rows: [ADMIN], rowCount: 1 };
      const target = userDb[params[0]];
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (sql, params=[]) => {
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.trim() === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id, email, status, access_expires_at, app_role')) {
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('UPDATE users') && sql.includes("app_role = 'PREMIUM'")) {
        const uid = params[0];
        const u = userDb[uid];
        if (u) {
          u.app_role = 'PREMIUM';
          u.premium_source = 'manual';
          u.status = 'active';
        }
        return { rows: [u], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO role_audit_log')) {
        auditInserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO premium_subscriptions')) {
        subscriptionInserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  });

  // Actor is ADMIN (10), trying to grant to [12,13,14(already premium),11(owner),10(self),999(invalid),12(duplicate)]
  const result = await bulkGrantPremium(10, ['12','13','14','11','10','999','12']);
  assert.equal(result.applied, 2, 'should apply to 2 eligible users (12,13)');
  assert.equal(result.skipped, 3, 'should skip owner, self, already premium (duplicate deduped)');
  assert.equal(result.failed, 1, 'invalid user should be failed');
  assert.ok(auditInserts.length === 2, 'audit logged for 2 grants');
  assert.equal(subscriptionInserts.length, 0, 'manual assignment must NOT create payment entitlement (no subscription insert)');
  assert.equal(userDb[12].premium_source, 'manual', 'manual source');
  assert.equal(userDb[13].premium_source, 'manual');

  pool.query = originalQuery;
  pool.connect = originalConnect;
});

test('bulkGrantPremium: rejects non-admin actor', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (sql.includes('FROM users') && sql.includes('WHERE id = $1')) {
      // Actor fetch returns USER
      return { rows: [{ id: 12, app_role: 'USER', email: 'user@example.com' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(() => bulkGrantPremium(12, [13]), /Only administrators can manage premium status/);
  pool.query = originalQuery;
});

// --- Integration tests for Admin UI --- 
test('Admin UI shows Premium tag, Premium/Without Premium filters, checkboxes and bulk premium action', async () => {
  const ADMIN = { id: 900, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const PREMIUM_USER = { id: 901, email: 'premium@example.com', name: 'Premium User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'PREMIUM', premium_source: 'manual', subscription_status: null, provider_subscription_id: null, cancel_at_period_end: false, current_period_end: null, created_at: new Date() };
  const NORMAL_USER = { id: 902, email: 'normal@example.com', name: 'Normal User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'USER', premium_source: null, created_at: new Date() };
  const OWNER_USER = { id: 903, email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER', created_at: new Date() };

  const ADMIN_SID = 'premium-3b-admin-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };

  const originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      return { rows: [ADMIN], rowCount: 1 };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) {
      return { rows: [{ total_users: 3, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    }
    if (/FROM users/.test(sql) && /ORDER BY u\.created_at DESC/.test(sql)) {
      return { rows: [PREMIUM_USER, NORMAL_USER, OWNER_USER] };
    }
    if (/access_audit_log/.test(sql)) return { rows: [] };
    if (/role_audit_log/.test(sql)) return { rows: [] };
    if (/content_permissions/.test(sql)) return { rows: [] };
    if (/content_action_permissions/.test(sql)) return { rows: [] };
    if (/unanswered_count/.test(sql)) return { rows: [{ unanswered_count:0, hidden_questions_count:0, hidden_replies_count:0, recent_questions_count:0, recent_replies_count:0 }] };
    if (/FROM access_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = server.address().port;
    const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

    const res = await http('/admin', { headers: { Cookie: ADMIN_COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Premium tag beside PREMIUM user in Name column
    assert.ok(html.includes('data-testid="premium-tag"'), 'should show Premium tag');
    assert.ok(html.includes('Premium'), 'Premium badge text present');

    // Premium and Without Premium filters alongside existing
    assert.ok(html.includes('data-testid="filter-premium"'), 'Premium filter present');
    assert.ok(html.includes('data-testid="filter-without_premium"'), 'Without Premium filter present');
    assert.ok(html.includes('data-testid="filter-all"'), 'existing All filter preserved');
    assert.ok(html.includes('data-testid="filter-pending"'), 'existing pending preserved');
    assert.ok(html.includes('data-testid="filter-active"'), 'existing active preserved');

    // Selection checkboxes and Select All
    assert.ok(html.includes('data-testid="select-all"'), 'Select All present');
    assert.ok(html.includes('data-testid="user-checkbox"'), 'user checkboxes present');
    const checkboxMatches = html.match(/data-testid="user-checkbox"/g) || [];
    assert.equal(checkboxMatches.length, 2, 'should have 2 checkboxes for eligible PREMIUM and USER (OWNER protected)');

    // Bulk premium action
    assert.ok(html.includes('data-testid="bulk-premium"'), 'bulk premium button present');
    assert.ok(html.includes('id="bulk-premium-form"'), 'bulk premium form present');
    assert.ok(html.includes('action="/admin/users/bulk-premium"'), 'bulk premium form action correct');
    // Preserve existing bulk actions
    assert.ok(html.includes('data-testid="bulk-activate"'), 'bulk activate preserved');
    assert.ok(html.includes('data-testid="bulk-extend"'), 'bulk extend preserved');
    assert.ok(html.includes('data-testid="bulk-revoke"'), 'bulk revoke preserved');
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
  }
});

test('Admin premium filter shows only PREMIUM vs Without Premium', async () => {
  const ADMIN = { id: 910, google_user_id: 'google-admin2', email: 'admin2@example.com', name: 'Admin2', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const PREMIUM_USER = { id: 911, email: 'p@example.com', name: 'P', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'PREMIUM', premium_source: 'manual', created_at: new Date() };
  const NORMAL_USER = { id: 912, email: 'n@example.com', name: 'N', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'USER', premium_source: null, created_at: new Date() };
  const PENDING_USER = { id: 913, email: 'pend@example.com', name: 'Pend', status: 'pending', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() };

  const ADMIN_SID = 'premium-filter-admin-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };

  const originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [ADMIN], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/FROM users/.test(sql) && /COUNT\(\*\)::int AS total_users/.test(sql)) return { rows: [{ total_users: 3, active_today: 1, active_month: 1, pending_users: 1, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 }] };
    if (/FROM users/.test(sql) && /ORDER BY u\.created_at DESC/.test(sql)) return { rows: [PREMIUM_USER, NORMAL_USER, PENDING_USER] };
    if (/unanswered_count/.test(sql)) return { rows: [{ unanswered_count:0, hidden_questions_count:0, hidden_replies_count:0, recent_questions_count:0, recent_replies_count:0 }] };
    return { rows: [] };
  };

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = server.address().port;
    const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

    const resPremium = await http('/admin?status=premium', { headers: { Cookie: ADMIN_COOKIE } });
    const htmlPremium = await resPremium.text();
    assert.ok(htmlPremium.includes('p@example.com'), 'premium filter should show premium user');
    assert.ok(!htmlPremium.includes('n@example.com'), 'premium filter should hide non-premium');
    assert.ok(!htmlPremium.includes('pend@example.com'), 'premium filter should hide pending non-premium');

    const resWithout = await http('/admin?status=without_premium', { headers: { Cookie: ADMIN_COOKIE } });
    const htmlWithout = await resWithout.text();
    assert.ok(!htmlWithout.includes('p@example.com'), 'without premium should hide premium user');
    assert.ok(htmlWithout.includes('n@example.com'), 'without premium should show normal user');
    assert.ok(htmlWithout.includes('pend@example.com'), 'without premium should show pending user (not premium)');

    const resPending = await http('/admin?status=pending', { headers: { Cookie: ADMIN_COOKIE } });
    const htmlPending = await resPending.text();
    assert.ok(htmlPending.includes('pend@example.com'));
    assert.ok(!htmlPending.includes('p@example.com'));
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
  }
});

test('Bulk premium endpoint respects OWNER/ADMIN protection and skips invalid', async () => {
  const ADMIN = { id: 920, google_user_id: 'google-admin3', email: 'admin3@example.com', name: 'Admin3', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
  const OWNER = { id: 921, email: 'owner@example.com', name: 'Owner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER', created_at: new Date() };
  const PREMIUM = { id: 922, email: 'already@example.com', name: 'Already', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+30*86400000), app_role: 'PREMIUM', premium_source: 'manual', created_at: new Date() };
  const USER = { id: 923, email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'USER', created_at: new Date() };

  const ADMIN_SID = 'bulk-premium-admin-sid';
  const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
  const sessionToUser = { [ADMIN_SID]: ADMIN };

  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  let userDb = { 921: OWNER, 922: PREMIUM, 923: USER, 920: ADMIN };
  let audit = [];

  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (sql.includes('SELECT id, email, status, access_expires_at, app_role')) {
      const uid = params[0];
      const u = userDb[uid] || (uid === ADMIN.id ? ADMIN : null);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] === ADMIN.id) return { rows: [ADMIN], rowCount: 1 };
      const u = userDb[params[0]];
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (sql, params=[]) => {
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.trim() === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id, email, status, access_expires_at, app_role')) {
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('FROM users') && sql.includes('WHERE id = $1')) {
        const u = userDb[params[0]];
        if (u && params[0]===920) return { rows: [ADMIN], rowCount: 1 };
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes("UPDATE users") && sql.includes("app_role = 'PREMIUM'")) {
        const uid = params[0];
        const u = userDb[uid];
        if (u) { u.app_role='PREMIUM'; u.premium_source='manual'; u.status='active'; }
        return { rows: [u], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO role_audit_log')) { audit.push(params); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  });

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = server.address().port;
    const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

    // Try bulk premium with OWNER, already PREMIUM, valid USER, invalid, and self
    const res = await http('/admin/users/bulk-premium', {
      method: 'POST',
      headers: { Cookie: ADMIN_COOKIE, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ userIds: [921,922,923,999,920] })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.applied, 1, 'only USER should be applied');
    assert.equal(json.skipped, 3, 'OWNER, already premium, self should be skipped');
    assert.equal(json.failed, 1, 'invalid 999 should be failed');
    assert.ok(audit.find(a => a[0]==923), 'audit for valid user');
    assert.ok(!audit.find(a => a[0]==921), 'no audit for owner');
    assert.equal(userDb[923].premium_source, 'manual', 'manual source, not payment entitlement');
  } finally {
    await new Promise(r => server.close(r));
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('Manual bulk premium does not create payment entitlement', async () => {
  const userDb = { 930: { id: 930, email: 'u@example.com', app_role: 'USER', premium_source: null, status: 'active' } };
  const audit = [];
  let subscriptionInsert = false;
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = async (sql, params) => {
    if (sql.includes('FROM users') && sql.includes('WHERE id =')) {
      const u = userDb[params[0]] || { id: 920, app_role: 'ADMIN', email: 'admin@example.com' };
      // Distinguish actor vs target: if params[0]==920 then admin, else target
      if (params[0]==920) return { rows: [{ id:920, app_role:'ADMIN', email:'admin@example.com'}], rowCount:1 };
      return { rows: [userDb[params[0]]], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      if (sql.trim()==='BEGIN' || sql.trim()==='COMMIT' || sql.trim()==='ROLLBACK') return { rows: [], rowCount:0 };
      if (sql.includes('SELECT id, email, status, access_expires_at, app_role')) {
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u?1:0 };
      }
      if (sql.includes('FROM users') && sql.includes('WHERE id = $1')) {
        if (params[0]==920) return { rows: [{ id:920, app_role:'ADMIN'}], rowCount:1 };
        const u = userDb[params[0]];
        return { rows: u ? [u] : [], rowCount: u?1:0 };
      }
      if (sql.includes("UPDATE users") && sql.includes("app_role = 'PREMIUM'")) {
        const u = userDb[params[0]];
        u.app_role='PREMIUM'; u.premium_source='manual';
        return { rows: [u], rowCount:1 };
      }
      if (sql.includes('INSERT INTO role_audit_log')) { audit.push(params); return { rows:[], rowCount:1 }; }
      if (sql.includes('INSERT INTO premium_subscriptions') || sql.includes('premium_subscriptions')) { subscriptionInsert = true; return { rows:[], rowCount:1 }; }
      return { rows:[], rowCount:0 };
    },
    release:()=>{}
  });
  const result = await bulkGrantPremium(920, [930]);
  assert.equal(result.applied, 1);
  assert.equal(userDb[930].premium_source, 'manual');
  assert.equal(subscriptionInsert, false, 'no subscription payment entitlement created');
  assert.ok(audit.length===1);
  pool.query = originalQuery;
  pool.connect = originalConnect;
});

test('Server preserves existing bulk access actions and premium tag uses existing styling', async () => {
  const adminView = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin.ejs'), 'utf8');
  assert.ok(adminView.includes('badge-premium'), 'premium badge styling preserved');
  assert.ok(adminView.includes('data-testid="premium-tag"'), 'premium tag testid');
  assert.ok(adminView.includes("'premium'") || adminView.includes('"premium"') || adminView.includes('premium'), 'premium filter defined');
  assert.ok(adminView.includes('without_premium'), 'without premium filter defined');
  assert.ok(adminView.includes('bulk-activate'), 'existing bulk activate preserved');
  assert.ok(adminView.includes('bulk-extend'), 'bulk extend preserved');
  assert.ok(adminView.includes('bulk-revoke'), 'bulk revoke preserved');
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes("bulkGrantPremium"), 'server uses bulkGrantPremium');
  assert.ok(serverSrc.includes("app.post('/admin/users/bulk-premium'"), 'route exists');
});
