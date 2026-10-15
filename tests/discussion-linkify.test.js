import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const SID = 'linkify-test-sid';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
const USER = {
  id: 6001,
  google_user_id: 'google-linkify',
  email: 'linkify@example.com',
  name: 'Linkify User',
  status: 'active',
  app_role: 'USER',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 86400000),
};

let originalQuery, server, port;

test.before(async () => {
  originalQuery = pool.query;
  // Mock to make hasNotes true for USER (so forms visible, but we test linkify regardless)
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/SELECT 1 FROM roles WHERE id = ANY/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all', role_id: null }] };
    if (/SELECT path, ad_state FROM ad_settings/.test(sql)) return { rows: [] };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    // For linkify tests, we need to handle discussion queries
    if (/FROM discussions d/.test(sql) && /GROUP BY/.test(sql)) return { rows: [] };
    if (/SELECT d\.\*, u\.email/.test(sql)) return { rows: [] };
    if (/SELECT r\.\*, u\.email/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const { app } = await import('../src/server.js');
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  pool.query = originalQuery;
});

const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);

// Direct linkifyBody tests via app.locals
test('linkifyBody - URL in question title → clickable external link', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  assert.ok(typeof fn === 'function', 'linkifyBody should be exposed');
  const out = fn('Check https://youtube.com/watch?v=123 here');
  assert.match(out, /<a href="https:\/\/youtube\.com\/watch\?v=123" target="_blank" rel="noopener noreferrer">https:\/\/youtube\.com\/watch\?v=123<\/a>/);
});

test('linkifyBody - URL in discussion body → clickable', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  const out = fn('See https://example.com/page?a=1&b=2 for details');
  assert.match(out, /<a href="https:\/\/example\.com\/page\?a=1&amp;b=2"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer"/);
});

test('linkifyBody - URL in reply → clickable', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  const out = fn('Reply with http://example.org');
  assert.match(out, /<a href="http:\/\/example\.org"/);
});

test('linkifyBody - normal text → unchanged (no extra anchor)', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  const out = fn('Hello world, no link here');
  assert.equal(out, 'Hello world, no link here');
  assert.doesNotMatch(out, /<a /);
});

test('linkifyBody - malicious HTML/script → escaped (no XSS)', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  const out = fn('<script>alert(1)</script> https://example.com');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // URL still linkified safely
  assert.match(out, /<a href="https:\/\/example\.com"/);
  // Ensure href is escaped
  const out2 = fn('"><img src=x onerror=alert(1)> https://example.com');
  assert.doesNotMatch(out2, /<img/);
  assert.match(out2, /&quot;&gt;&lt;img/);
});

test('linkifyBody - http and https both work, internal links unchanged', async () => {
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  assert.match(fn('http://example.com'), /<a href="http:\/\/example\.com"/);
  assert.match(fn('https://example.com'), /<a href="https:\/\/example\.com"/);
  // Internal path should not be converted (no http)
  const internal = fn('/discussions/123');
  assert.equal(internal, '/discussions/123');
  assert.doesNotMatch(internal, /<a /);
});

test('GET /discussions/:id – title with URL renders clickable external link', async () => {
  // Setup mock to return a discussion with URL in title
  const orig = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all' }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/SELECT d\.\*, u\.email/.test(sql) && /FROM discussions d/.test(sql)) {
      return { rows: [{ id: 9001, user_id: USER.id, item_path: 'Guidewire/test.txt', title: 'Check https://youtube.com/watch?v=abc123 here', body: 'Body with https://example.com/page', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: USER.email, author_name: USER.name, like_count: 0, user_liked: false }] };
    }
    if (/SELECT r\.\*, u\.email/.test(sql)) {
      return { rows: [{ id: 8001, discussion_id: 9001, user_id: USER.id, body: 'Reply https://example.org', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: USER.email, author_name: USER.name, author_app_role: 'USER', like_count: 0, user_liked: false }] };
    }
    if (/SELECT COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/SELECT id FROM item_likes/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/discussions/9001', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Title URL should be linkified with target blank
  assert.match(html, /<a href="https:\/\/youtube\.com\/watch\?v=abc123" target="_blank" rel="noopener noreferrer">/);
  // Body URL
  assert.match(html, /<a href="https:\/\/example\.com\/page"/);
  // Reply URL
  assert.match(html, /<a href="https:\/\/example\.org"/);
  // Internal discussion link still present (view all)
  assert.match(html, /\/discussions\?path=Guidewire/);
  pool.query = orig;
});

test('GET /discussions/:id – malicious title is escaped', async () => {
  const orig = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: 'Guidewire', access_level: 'all' }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/SELECT d\.\*, u\.email/.test(sql)) {
      return { rows: [{ id: 9002, user_id: USER.id, item_path: 'Guidewire/test.txt', title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: USER.email, author_name: USER.name, like_count: 0, user_liked: false }] };
    }
    if (/SELECT r\.\*, u\.email/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const res = await http('/discussions/9002', { headers: { Cookie: COOKIE } });
  const html = await res.text();
  // Title and body must be escaped – raw script/img from user must not appear
  assert.match(html, /<h1>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.doesNotMatch(html, /<h1><script>alert\(1\)<\/script><\/h1>/);
  assert.match(html, /<div class="discussion-body">&lt;img src=x onerror=alert\(1\)&gt;<\/div>/);
  assert.doesNotMatch(html, /<div class="discussion-body"><img src=x/);
  // Still should contain escaped versions
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  pool.query = orig;
});
