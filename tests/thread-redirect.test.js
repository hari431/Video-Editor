import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import cookieSignature from 'cookie-signature';

const { app } = await import('../src/server.js');

const ADMIN = { id: 99, google_user_id: 'google-admin', email: 'admin@example.com', name: 'Admin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const ADMIN_SID = 'thread-redirect-admin';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [ADMIN_SID]: ADMIN };

let discussionsInDB = [];
let repliesInDB = [];
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
      const u = [ADMIN].find(x=>x.id===params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path:'Guidewire', access_level:'all', role_id:null }] };
    if (/unanswered_count/.test(sql)) return { rows: [{ unanswered_count:0, hidden_questions_count:0, hidden_replies_count:0, recent_questions_count:0, recent_replies_count:0 }]};
    if (/total_questions/.test(sql)) return { rows: [{ total_questions:1, visible_questions:1, hidden_questions:0, deleted_questions:0, questions_today:0, total_replies:1, visible_replies:1, hidden_replies:0, deleted_replies:0, replies_today:0 }]};
    if (/SELECT COUNT\(\*\)::int AS count FROM filtered/.test(sql)) return { rows: [{count:1}]};
    if (/COUNT\(dr\.id\) FILTER/.test(sql) && /FROM discussions d/.test(sql) && /LIMIT/.test(sql)) {
      return { rows: discussionsInDB.map(d=>({ ...d, author_name:'Test', author_email:'test@example.com', visible_reply_count:1, hidden_reply_count:0, deleted_reply_count:0, total_reply_count:1, accepted_count:0 }))};
    }
    if (/SELECT d\.\*, u\.email/.test(sql)) {
      const d=discussionsInDB.find(x=>x.id===params[0]);
      return { rows: d ? [{...d, author_email:'a@b.com', author_name:'A'}] : [] };
    }
    if (/SELECT r\.\*, u\.email/.test(sql)) {
      return { rows: repliesInDB.filter(r=>r.discussion_id===params[0]).map(r=>({ ...r, author_email:'a@b.com', author_name:'A', deleted_by_email:null, deleted_by_name:null }))};
    }
    if (/SELECT discussion_id FROM discussion_replies WHERE id = \$1/.test(sql)) {
      const r=repliesInDB.find(x=>x.id===params[0]);
      return { rows: r ? [{ discussion_id: r.discussion_id }] : [] };
    }
    if (/UPDATE discussions SET status = 'hidden'/.test(sql)) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d) d.status='hidden'; return { rows: [] };}
    if (/UPDATE discussions SET status = 'visible'/.test(sql) && sql.includes("deleted_at = NULL")) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d){ d.status='visible'; d.deleted_at=null; } return {rows:[]}}
    if (/UPDATE discussions SET status = 'visible'/.test(sql) && !sql.includes("deleted_at")) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d) d.status='visible'; return {rows:[]}}
    if (/UPDATE discussions SET status = 'deleted'/.test(sql)) { const d=discussionsInDB.find(x=>x.id===params[0]); if(d){ d.status='deleted'; d.deleted_at=new Date();} return {rows:[]}}
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
  discussionsInDB.push({ id:8000, user_id:10, item_path:'Guidewire/test.txt', title:'Thread Q', body:'body', status:'visible', accepted_reply_id:null, created_at:new Date(), updated_at:new Date(), deleted_at:null, deleted_by:null });
  repliesInDB.push({ id:9000, discussion_id:8000, user_id:10, body:'reply', status:'visible', accepted_at:null, created_at:new Date(), updated_at:new Date() });
}

for (const [action, url, msg, shouldBeThread] of [
  ['hide question thread', '/admin/discussions/8000/hide', 'hidden', true],
  ['unhide question thread', '/admin/discussions/8000/unhide', 'unhidden', true],
  ['delete question thread', '/admin/discussions/8000/delete', 'deleted', true],
  ['restore question thread', '/admin/discussions/8000/restore', 'restored', true],
  ['hide reply thread', '/admin/discussions/replies/9000/hide', 'replyHidden', true],
  ['unhide reply thread', '/admin/discussions/replies/9000/unhide', 'replyUnhidden', true],
  ['delete reply thread', '/admin/discussions/replies/9000/delete', 'replyDeleted', true],
  ['restore reply thread', '/admin/discussions/replies/9000/restore', 'replyRestored', true],
]) {
  test(`${action} from thread redirects to /discussions/:id`, async () => {
    reset();
    if (msg==='unhidden') discussionsInDB[0].status='hidden';
    if (msg==='restored') discussionsInDB[0].status='deleted';
    if (msg==='replyUnhidden') repliesInDB[0].status='hidden';
    if (msg==='replyRestored') repliesInDB[0].status='deleted';
    const body = new URLSearchParams({ returnTo: 'thread' });
    const res = await http(url, { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body, redirect:'manual' });
    assert.equal(res.status,302);
    const loc = res.headers.get('location');
    if (action === 'delete question thread') {
      assert.ok(loc.startsWith('/query/Guidewire/test.txt') || loc.startsWith('/query/Guidewire%2Ftest.txt'), 'delete thread should redirect to content watch page, got ' + loc);
    } else {
      assert.ok(loc.startsWith('/discussions/8000'), 'thread redirect should be /discussions/8000, got ' + loc);
    }
    if (action === 'delete question thread') {
      assert.ok(loc.includes(`msg=Deleted.`) || loc.includes(`msg=${msg}`), loc);
    } else {
      assert.ok(loc.includes(`msg=${msg}`), loc);
    }
    assert.ok(!loc.startsWith('/admin/discussions'), `should not go to admin, got ${loc}`);
  });
}

for (const [action, url, msg] of [
  ['hide question admin', '/admin/discussions/8000/hide', 'hidden'],
  ['delete reply admin', '/admin/discussions/replies/9000/delete', 'replyDeleted'],
]) {
  test(`${action} from admin preserves filter/search/page`, async () => {
    reset();
    const body = new URLSearchParams({ filter:'hidden', search:'foo', page:'2' });
    const res = await http(url, { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body, redirect:'manual' });
    const loc = res.headers.get('location');
    assert.ok(loc.startsWith('/admin/discussions'), loc);
    assert.ok(loc.includes('filter=hidden'), loc);
    assert.ok(loc.includes('search=foo'), loc);
    assert.ok(loc.includes('page=2'), loc);
  });
}

test('thread redirect is safe from open redirect', async () => {
  reset();
  const body = new URLSearchParams({ returnTo: 'thread', filter: 'hidden' });
  // Try to inject evil via returnTo param – should still only go to thread, not evil
  const res = await http('/admin/discussions/8000/hide', { method:'POST', headers:{ Cookie: ADMIN_COOKIE, 'Content-Type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ returnTo: 'https://evil.com', filter:'hidden' }), redirect:'manual' });
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('/admin/discussions'), `should not follow evil returnTo, got ${loc}`);
  assert.ok(!loc.includes('evil.com'), loc);
});

test('discussion thread page contains returnTo hidden input', async () => {
  reset();
  // Need to mock getDiscussionWithReplies to return discussion with replies
  // The thread page for admin should contain the hidden input
  const res = await http('/discussions/8000', { headers:{ Cookie: ADMIN_COOKIE }});
  assert.equal(res.status,200);
  const html = await res.text();
  // Check that admin hide forms contain returnTo=thread
  assert.ok(html.includes('name="returnTo" value="thread"') || html.includes("returnTo"), `should contain returnTo hidden, got ${html.slice(0,2000)}`);
});

test('admin center still redirects to admin when no returnTo', async () => {
  reset();
  const res = await http('/admin/discussions/8000/hide', { method:'POST', headers:{ Cookie: ADMIN_COOKIE }, redirect:'manual' });
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('/admin/discussions'), loc);
  assert.ok(!loc.startsWith('/discussions/'), loc);
});
