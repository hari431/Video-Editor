import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import cookieSignature from 'cookie-signature';

const { app } = await import('../src/server.js');

const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const USER = { id: 10, google_user_id: 'google-user', email: 'user@example.com', name: 'User', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now()+86400000), app_role: 'USER' };
const ADMIN_SID = 'admin-redirect-sid';
const USER_SID = 'user-redirect-sid';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN, [USER_SID]: USER };

let discussionsInDB = [];
let repliesInDB = [];
let nextDiscId = 5000;
let nextReplyId = 6000;
let originalQuery = null;
let server, port;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params=[]) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const sid = params[0];
      const user = sessionToUser[sid];
      if (user) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{user:user.id}})}]};
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const u = [ADMIN, USER].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path:'Guidewire', access_level:'all', role_id:null }] };
    // For getNeedsAttention and counts, return minimal
    if (/unanswered_count/.test(sql)) return { rows: [{ unanswered_count:0, hidden_questions_count:0, hidden_replies_count:0, recent_questions_count:0, recent_replies_count:0 }]};
    if (/total_questions/.test(sql)) return { rows: [{ total_questions:1, visible_questions:1, hidden_questions:0, deleted_questions:0, questions_today:0, total_replies:1, visible_replies:1, hidden_replies:0, deleted_replies:0, replies_today:0 }]};
    if (/SELECT COUNT\(\*\)::int AS count FROM filtered/.test(sql)) return { rows: [{count:1}]};
    // Admin list
    if (/COUNT\(dr\.id\) FILTER/.test(sql) && /FROM discussions d/.test(sql) && /LIMIT/.test(sql)) {
      return { rows: discussionsInDB.map(d=>({ ...d, author_name:'Test', author_email:'test@example.com', visible_reply_count: repliesInDB.filter(r=>r.discussion_id===d.id).length, hidden_reply_count:0, deleted_reply_count:0, total_reply_count: repliesInDB.filter(r=>r.discussion_id===d.id).length }))};
    }
    if (/SELECT r\.\*, u\.email/.test(sql) && /FROM discussion_replies r/.test(sql)) {
      return { rows: repliesInDB.filter(r=>r.discussion_id===params[0]).map(r=>({ ...r, author_email:'a@b.com', author_name:'A', deleted_by_email:null, deleted_by_name:null }))};
    }
    if (/SELECT d\.\*, u\.email/.test(sql)) {
      const d=discussionsInDB.find(x=>x.id===params[0]);
      return { rows: d ? [{...d, author_email:'a@b.com', author_name:'A'}] : [] };
    }
    if (/SELECT r\.id, r\.user_id, r\.discussion_id/.test(sql)) {
      const r=repliesInDB.find(x=>x.id===params[0]);
      if(r){ const d=discussionsInDB.find(x=>x.id===r.discussion_id); return { rows: [{...r, item_path:d?d.item_path:'Guidewire/test.txt'}]}}
      return { rows: [] };
    }
    if (/UPDATE discussions SET status = 'hidden'/.test(sql)) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d) d.status='hidden'; return { rows: [] };}
    if (/UPDATE discussions SET status = 'visible'/.test(sql) && sql.includes("deleted_at = NULL")) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d){ d.status='visible'; d.deleted_at=null; d.deleted_by=null;} return {rows:[]}}
    if (/UPDATE discussions SET status = 'visible'/.test(sql) && !sql.includes("deleted_at")) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d) d.status='visible'; return {rows:[]}}
    if (/UPDATE discussions SET status = 'deleted'/.test(sql)) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d){ d.status='deleted'; d.deleted_at=new Date(); d.deleted_by=params[1];} return {rows:[]}}
    if (/UPDATE discussion_replies SET status = 'hidden'/.test(sql)) { const r=repliesInDB.find(x=>x.id===params[0]); if(r) r.status='hidden'; return {rows:[]}}
    if (/UPDATE discussion_replies SET status = 'visible'/.test(sql) && sql.includes("deleted_at = NULL")) { const r=repliesInDB.find(x=>x.id===params[0]); if(r){ r.status='visible'; r.deleted_at=null;} return {rows:[]}}
    if (/UPDATE discussion_replies SET status = 'visible'/.test(sql) && !sql.includes("deleted_at")) { const r=repliesInDB.find(x=>x.id===params[0]); if(r) r.status='visible'; return {rows:[]}}
    if (/UPDATE discussion_replies SET status = 'deleted'/.test(sql)) { const r=repliesInDB.find(x=>x.id===params[0]); if(r){ r.status='deleted'; r.deleted_at=new Date();} return {rows:[]}}
    if (/INSERT INTO discussion_moderation_actions/.test(sql)) return { rows: [] };
    if (/SELECT DISTINCT ON/.test(sql)) return { rows: [] };
    if (/information_schema/.test(sql)) return { rows: [{exists:true}] };
    if (/SELECT COUNT\(\*\) AS cnt FROM item_likes/.test(sql)) return { rows: [{cnt:'0'}]};
    if (/SELECT id FROM item_likes/.test(sql)) return { rows: []};
    if (/video_views/.test(sql)) return { rows: [{cnt:'0'}]};
    if (/INSERT INTO video_views/.test(sql)) return { rows: []};
    // For getNeedsAttention recent lists
    if (/GREATEST\(d\.updated_at/.test(sql)) return { rows: [] };
    if (/NOT EXISTS.*discussion_replies.*LIMIT 5/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  server = await new Promise(resolve=>{ const s=app.listen(0,()=>resolve(s));});
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r=>server.close(r));
  if (originalQuery) pool.query = originalQuery;
});

const http = (path, opts) => fetch(`http://127.0.0.1:${port}${path}`, opts);
function reset(){
  discussionsInDB.length=0; repliesInDB.length=0;
  discussionsInDB.push({ id:5000, user_id:10, item_path:'Guidewire/test.txt', title:'Test Q', body:'body', status:'visible', accepted_reply_id:null, created_at:new Date(), updated_at:new Date(), deleted_at:null, deleted_by:null, author_name:'Test', author_email:'test@example.com'});
  repliesInDB.push({ id:6000, discussion_id:5000, user_id:10, body:'reply', status:'visible', created_at:new Date(), updated_at:new Date(), author_name:'Test', author_email:'test@example.com'});
}

for (const [action, url, msg] of [
  ['hide question', '/admin/discussions/5000/hide', 'hidden'],
  ['unhide question', '/admin/discussions/5000/unhide', 'unhidden'],
  ['delete question', '/admin/discussions/5000/delete', 'deleted'],
  ['restore question', '/admin/discussions/5000/restore', 'restored'],
  ['hide reply', '/admin/discussions/replies/6000/hide', 'replyHidden'],
  ['unhide reply', '/admin/discussions/replies/6000/unhide', 'replyUnhidden'],
  ['delete reply', '/admin/discussions/replies/6000/delete', 'replyDeleted'],
  ['restore reply', '/admin/discussions/replies/6000/restore', 'replyRestored'],
]) {
  test(`${action} redirects to /admin/discussions not /discussions/:id`, async () => {
    reset();
    // For restore tests, need deleted status
    if (msg==='restored') discussionsInDB[0].status='deleted';
    if (msg==='replyRestored') repliesInDB[0].status='deleted';
    if (msg==='unhidden') discussionsInDB[0].status='hidden';
    if (msg==='replyUnhidden') repliesInDB[0].status='hidden';
    const res = await http(url, { method:'POST', headers:{ Cookie: ADMIN_COOKIE }, redirect:'manual' });
    assert.equal(res.status,302);
    const loc = res.headers.get('location');
    assert.ok(loc.startsWith('/admin/discussions'), `should redirect to /admin/discussions, got ${loc}`);
    assert.ok(!loc.startsWith('/discussions/'), `should not redirect to /discussions/:id, got ${loc}`);
    assert.ok(loc.includes(`msg=${msg}`), `should contain msg=${msg}, got ${loc}`);
  });

  test(`${action} preserves filter/search/page`, async () => {
    reset();
    if (msg==='restored') discussionsInDB[0].status='deleted';
    if (msg==='replyRestored') repliesInDB[0].status='deleted';
    if (msg==='unhidden') discussionsInDB[0].status='hidden';
    if (msg==='replyUnhidden') repliesInDB[0].status='hidden';
    const body = new URLSearchParams({ filter:'hidden', search:'foo', page:'2' });
    const res = await http(url, { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body, redirect:'manual' });
    assert.equal(res.status,302);
    const loc = res.headers.get('location');
    assert.ok(loc.includes('filter=hidden'), loc);
    assert.ok(loc.includes('search=foo'), loc);
    assert.ok(loc.includes('page=2'), loc);
    assert.ok(loc.includes(`msg=${msg}`), loc);
    assert.ok(loc.startsWith('/admin/discussions'), loc);
  });
}

test('open redirect is blocked - only /admin/discussions allowed', async () => {
  reset();
  const body = new URLSearchParams({ filter:'hidden', search:'//evil.com', page:'2' });
  // Even with evil search, redirect should still be to /admin/discussions with encoded search, not to evil.com
  const res = await http('/admin/discussions/5000/hide', { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body, redirect:'manual' });
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('/admin/discussions'), loc);
  assert.ok(!loc.includes('evil.com') || loc.includes('search=%2F%2Fevil.com'), `should encode not redirect, got ${loc}`);
  // Try injecting redirect param (should be ignored)
  const body2 = new URLSearchParams({ filter:'hidden', search:'foo', page:'2', redirect:'https://evil.com' });
  const res2 = await http('/admin/discussions/5000/hide', { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body: body2, redirect:'manual' });
  assert.ok(res2.headers.get('location').startsWith('/admin/discussions'), res2.headers.get('location'));
});

test('normal user cannot hide via admin endpoint', async () => {
  reset();
  const res = await http('/admin/discussions/5000/hide', { method:'POST', headers:{ Cookie: USER_COOKIE }, redirect:'manual' });
  assert.equal(res.status,403);
});

test('discussion thread admin actions still work (not changed)', async () => {
  // This is not admin center but same endpoint; should still redirect to admin center (existing behavior)
  reset();
  const res = await http('/admin/discussions/5000/hide', { method:'POST', headers:{ Cookie: ADMIN_COOKIE }, redirect:'manual' });
  assert.equal(res.status,302);
  assert.ok(res.headers.get('location').startsWith('/admin/discussions'));
});
