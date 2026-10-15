import './helpers/env.js';
process.env.ADMIN_EMAILS = 'admin@example.com';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import cookieSignature from 'cookie-signature';

const { app } = await import('../src/server.js');

const SID = 'discussions-harness-session';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;

const NORMAL_USER = {
  id: 10,
  google_user_id: 'google-disc-1',
  email: 'user@example.com',
  name: 'Discussion User',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000)
};

const ADMIN_USER = {
  id: 99,
  google_user_id: 'google-disc-admin',
  email: 'admin@example.com',
  name: 'Admin User',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: null
};

const OTHER_USER = {
  id: 20,
  google_user_id: 'google-disc-other',
  email: 'other@example.com',
  name: 'Other User',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000)
};

const ADMIN_SID = 'admin-discussions-session';
const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;

const OTHER_SID = 'other-discussions-session';
const OTHER_COOKIE = `connect.sid=s:${cookieSignature.sign(OTHER_SID, process.env.SESSION_SECRET)}`;

// Map session IDs to user IDs
const sessionToUser = {
  [SID]: NORMAL_USER,
  [ADMIN_SID]: ADMIN_USER,
  [OTHER_SID]: OTHER_USER
};

const discussionsInDB = [];
const repliesInDB = [];
const moderationActions = [];
let nextDiscussionId = 1;
let nextReplyId = 1;
let nextModerationId = 1;

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const enc = value => value.split('/').map(encodeURIComponent).join('/');

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    
    if (/SELECT id, discussion_id, status, accepted_at FROM discussion_replies WHERE id = \$1/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SELECT id FROM discussions WHERE id = \$1/.test(sql)) {
      const d = discussionsInDB.find(d => d.id === params[0]);
      return d ? { rows: [d], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NOW/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      if (r) { r.accepted_at = new Date(); }
      return { rowCount: r ? 1 : 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NULL.*WHERE id = \$1/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0] && r.discussion_id === params[1]);
      if (r) { r.accepted_at = null; }
      return { rowCount: r ? 1 : 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NULL.*WHERE discussion_id = \$1/.test(sql)) {
      const rs = repliesInDB.filter(r => r.discussion_id === params[0] && r.accepted_at != null);
      rs.forEach(r => r.accepted_at = null);
      return { rowCount: rs.length };
    }

    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };

    // Session lookup: SELECT sess FROM "user_sessions" WHERE sid = $1 AND ...
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const sid = params[0];
      const user = sessionToUser[sid];
      if (user) {
        return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: user.id } }) }] };
      }
      return { rows: [] };
    }

    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
      const userId = params[0];
      const user = [NORMAL_USER, ADMIN_USER, OTHER_USER].find(u => u.id === userId);
      return { rows: user ? [user] : [] };
    }
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) {
      const uid = Number(params[0]);
      if (uid === 10 || uid === 20) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT 1 FROM user_roles/.test(sql) && /notes_available/.test(sql)) {
      const uid = Number(params[0]);
      if (uid === 10 || uid === 20) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Guidewire', access_level: 'all', role_id: null },
          { folder_path: 'Videos', access_level: 'all', role_id: null }
        ]
      };
    }

    // Discussions queries
    if (/INSERT INTO discussions/.test(sql)) {
      const d = {
        id: nextDiscussionId++,
        user_id: params[0],
        item_path: params[1],
        title: params[2],
        body: params[3] || '',
        status: 'visible',
        created_at: new Date(),
        updated_at: new Date(),
        author_name: 'Test User',
        author_email: 'test@example.com'
      };
      discussionsInDB.push(d);
      return { rows: [d] };
    }

    // listDiscussions: has d.status = 'visible' AND d.item_path = $1
    if (/FROM discussions d/.test(sql) && /discussion_replies dr/.test(sql) && /GROUP BY/.test(sql) && /d\.item_path = \$1/.test(sql)) {
      const itemPath = params[0];
      const filtered = discussionsInDB.filter(d => d.status === 'visible' && d.item_path === itemPath);
      const rows = filtered.map(d => ({
        ...d,
        reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length,
        visible_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length,
        total_reply_count: repliesInDB.filter(r => r.discussion_id === d.id).length,
        author_email: 'test@example.com'
      }));
      return { rows };
    }

    // listAllDiscussionsForAdmin: no item_path filter, returns ALL discussions with pagination/search
    // listAllDiscussionsForAdmin with LIMIT/OFFSET pagination
    if (/COUNT\(dr\.id\) FILTER/.test(sql) && /FROM discussions d/.test(sql) && /LIMIT \$\d+ OFFSET \$\d+/.test(sql)) {
      let filtered = discussionsInDB.slice();
      // Apply search filtering (title, body, author, email, path, id, status) — params contain %search% patterns
      const searchPattern = params.find(p => typeof p === 'string' && p.startsWith('%') && p.endsWith('%'));
      if (searchPattern) {
        const term = searchPattern.slice(1, -1).toLowerCase();
        if (term) {
          filtered = filtered.filter(d => {
            const fields = [
              String(d.title || '').toLowerCase(),
              String(d.body || '').toLowerCase(),
              String(d.author_name || 'Test User').toLowerCase(),
              String(d.author_email || 'test@example.com').toLowerCase(),
              String(d.item_path || '').toLowerCase(),
              String(d.id).toLowerCase(),
              String(d.status || '').toLowerCase()
            ];
            return fields.some(f => f.includes(term));
          });
        }
      }
      // Apply status filter from SQL (hidden/deleted)
      if (/d\.status = 'hidden'/.test(sql)) filtered = filtered.filter(d => d.status === 'hidden');
      else if (/d\.status = 'deleted'/.test(sql)) filtered = filtered.filter(d => d.status === 'deleted');
      // Apply having filters
      if (/HAVING COUNT\(dr\.id\) FILTER/.test(sql) && / = 0/.test(sql)) {
        // unanswered / no-replies / oldest-unanswered
        if (/ORDER BY d\.created_at ASC/.test(sql)) {
          // oldest-unanswered: same as unanswered but sorted asc
          filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length === 0);
        } else {
          filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length === 0);
        }
      } else if (/HAVING COUNT\(dr\.id\) FILTER/.test(sql) && /> 0/.test(sql)) {
        filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length > 0);
      } else if (/HAVING COUNT\(dr\.id\) = 0/.test(sql)) {
        filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id).length === 0);
      }
      // Apply ordering
      if (/ORDER BY COUNT\(dr\.id\) DESC/.test(sql)) {
        filtered.sort((a,b) => repliesInDB.filter(r => r.discussion_id === b.id).length - repliesInDB.filter(r => r.discussion_id === a.id).length);
      } else if (/ORDER BY d\.created_at ASC/.test(sql)) {
        filtered.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      } else {
        filtered.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      }
      // Apply pagination (last two params are limit/offset)
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      if (Number.isFinite(limit) && Number.isFinite(offset)) {
        filtered = filtered.slice(offset, offset + limit);
      }
      const rows = filtered.map(d => ({
        ...d,
        author_name: d.author_name || 'Test User',
        author_email: d.author_email || 'test@example.com',
        deleted_at: d.deleted_at || null,
        deleted_by: d.deleted_by || null,
        deleted_by_name: d.deleted_by ? (d.deleted_by_name || 'Admin') : null,
        deleted_by_email: d.deleted_by ? (d.deleted_by_email || 'admin@example.com') : null,
        visible_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length,
        hidden_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'hidden').length,
        deleted_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'deleted').length,
        total_reply_count: repliesInDB.filter(r => r.discussion_id === d.id).length
      }));
      return { rows };
    }

    if (/FROM discussions d/.test(sql) && /discussion_replies dr/.test(sql) && /GROUP BY/.test(sql) && !/d\.item_path = \$1/.test(sql) && !/WITH filtered AS/.test(sql)) {
      // This handles both listing all and searching (legacy for non-LIMIT queries) — not count queries
      let filtered = discussionsInDB.slice();
      const searchPattern = params.find(p => typeof p === 'string' && p.startsWith('%') && p.endsWith('%'));
      if (searchPattern) {
        const term = searchPattern.slice(1, -1).toLowerCase();
        if (term) {
          filtered = filtered.filter(d => {
            const fields = [
              String(d.title || '').toLowerCase(),
              String(d.body || '').toLowerCase(),
              String(d.author_name || 'Test User').toLowerCase(),
              String(d.author_email || 'test@example.com').toLowerCase(),
              String(d.item_path || '').toLowerCase(),
              String(d.id).toLowerCase(),
              String(d.status || '').toLowerCase()
            ];
            return fields.some(f => f.includes(term));
          });
        }
      }
      if (/d\.status = 'hidden'/.test(sql)) filtered = filtered.filter(d => d.status === 'hidden');
      else if (/d\.status = 'deleted'/.test(sql)) filtered = filtered.filter(d => d.status === 'deleted');
      const rows = filtered.map(d => ({
        ...d,
        reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length,
        visible_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length,
        hidden_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'hidden').length,
        deleted_reply_count: repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'deleted').length,
        total_reply_count: repliesInDB.filter(r => r.discussion_id === d.id).length
      }));
      return { rows };
    }

    if (/SELECT d\.\*, u\.email AS author_email/.test(sql) && /FROM discussions d/.test(sql) && (!/COUNT/.test(sql) || /like_count/.test(sql))) {
      const d = discussionsInDB.find(d => d.id === params[0]);
      if (d) return { rows: [{ ...d, author_email: 'test@example.com', author_name: 'Test User' }] };
      return { rows: [] };
    }

    // adminListDiscussionRepliesBatch: returns ALL replies for multiple discussionIds (batched)
    if (/SELECT r\.\*, u\.email AS author_email/.test(sql) && /FROM discussion_replies r/.test(sql) && /ANY\(\$1/.test(sql)) {
      const ids = (params[0] || []).map(id => Number(id));
      const filtered = repliesInDB.filter(r => ids.includes(Number(r.discussion_id)));
      filtered.sort((a,b) => Number(a.discussion_id) - Number(b.discussion_id) || new Date(a.created_at) - new Date(b.created_at));
      return { rows: filtered.map(r => ({
        ...r,
        author_email: r.author_email || 'other@example.com',
        author_name: r.author_name || 'Other User',
        author_app_role: r.author_app_role || (r.user_id === 99 ? 'ADMIN' : r.user_id === 1 ? 'OWNER' : 'USER'),
        deleted_by_email: r.deleted_by ? 'admin@example.com' : null,
        deleted_by_name: r.deleted_by ? 'Admin' : null
      })) };
    }

    // adminListDiscussionReplies: returns ALL replies with deletion metadata
    if (/SELECT r\.\*, u\.email AS author_email/.test(sql) && /FROM discussion_replies r/.test(sql) && /WHERE r\.discussion_id = \$1/.test(sql) && !/status/i.test(sql)) {
      const filtered = repliesInDB.filter(r => r.discussion_id === params[0]);
      return { rows: filtered.map(r => ({ 
        ...r, 
        author_email: r.author_email || 'other@example.com', 
        author_name: r.author_name || 'Other User',
        author_app_role: r.author_app_role || (r.user_id === 99 ? 'ADMIN' : r.user_id === 1 ? 'OWNER' : 'USER'),
        deleted_by_email: r.deleted_by ? 'admin@example.com' : null,
        deleted_by_name: r.deleted_by ? 'Admin' : null
      })) };
    }

    if (/SELECT r\.\*, u\.email AS author_email/.test(sql) && /FROM discussion_replies r/.test(sql)) {
      const includeHidden = !(/status/i.test(sql));
      let filtered = repliesInDB.filter(r => r.discussion_id === params[0]);
      if (!includeHidden) {
        const currentUserId = params[1];
        if (currentUserId) {
          filtered = filtered.filter(r => r.status === 'visible' || r.status === 'approved' || (r.status === 'pending' && r.user_id === currentUserId));
        } else {
          filtered = filtered.filter(r => r.status === 'visible' || r.status === 'approved');
        }
      }
      return { rows: filtered.map(r => ({
        ...r,
        author_email: r.author_email || 'other@example.com',
        author_name: r.author_name || 'Other User',
        author_app_role: r.author_app_role || (r.user_id === 99 ? 'ADMIN' : r.user_id === 1 ? 'OWNER' : 'USER')
      })) };
    }

    if (/DELETE FROM discussions WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      // User soft-delete: mark as deleted
      const d = discussionsInDB.find(d => d.id === params[0] && d.user_id === params[1]);
      if (d) {
        d.status = 'deleted';
        d.deleted_at = new Date();
        d.deleted_by = params[1];
      }
      return { rows: [], rowCount: d ? 1 : 0 };
    }

    if (/DELETE FROM discussion_replies WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      // User soft-delete: mark as deleted
      const r = repliesInDB.find(r => r.id === params[0] && r.user_id === params[1]);
      if (r) {
        r.status = 'deleted';
        r.deleted_at = new Date();
        r.deleted_by = params[1];
      }
      return { rows: [], rowCount: r ? 1 : 0 };
    }

    if (/UPDATE discussions SET status/.test(sql)) {
      const d = discussionsInDB.find(d => d.id === params[0]);
      if (d) {
        if (sql.includes("'hidden'")) {
          d.status = 'hidden';
          d.updated_at = new Date();
        } else if (sql.includes("'deleted'")) {
          d.status = 'deleted';
          d.deleted_at = new Date();
          d.deleted_by = params[1] || null;
          d.deleted_by_name = 'Admin';
          d.deleted_by_email = 'admin@example.com';
          d.updated_at = new Date();
        } else if (sql.includes("'visible'")) {
          // Could be unhide or restore — check if clearing deleted fields
          if (sql.includes("deleted_at = NULL")) {
            d.status = 'visible';
            d.deleted_at = null;
            d.deleted_by = null;
            d.deleted_by_name = null;
            d.deleted_by_email = null;
            d.updated_at = new Date();
          } else {
            d.status = 'visible';
            d.updated_at = new Date();
          }
        }
      }
      return { rows: [] };
    }

    if (/UPDATE discussion_replies SET status/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      if (r) {
        if (sql.includes("'hidden'")) {
          r.status = 'hidden';
          r.updated_at = new Date();
        } else if (sql.includes("'deleted'")) {
          r.status = 'deleted';
          r.deleted_at = new Date();
          r.deleted_by = params[1] || null;
          r.deleted_by_name = 'Admin';
          r.deleted_by_email = 'admin@example.com';
          r.updated_at = new Date();
        } else if (sql.includes("'visible'")) {
          if (sql.includes("deleted_at = NULL")) {
            r.status = 'visible';
            r.deleted_at = null;
            r.deleted_by = null;
            r.deleted_by_name = null;
            r.deleted_by_email = null;
            r.updated_at = new Date();
          } else {
            r.status = 'visible';
            r.updated_at = new Date();
          }
        }
      }
      return { rows: [] };
    }

    // Moderation audit: INSERT INTO discussion_moderation_actions
    if (/INSERT INTO discussion_moderation_actions/.test(sql)) {
      const entry = {
        id: nextModerationId++,
        target_type: params[0],
        target_id: params[1],
        action: params[2],
        actor_user_id: params[3],
        created_at: new Date(),
        actor_name: params[3] === 99 ? 'Admin User' : (params[3] === 10 ? 'Test User' : 'Other User'),
        actor_email: params[3] === 99 ? 'admin@example.com' : (params[3] === 10 ? 'test@example.com' : 'other@example.com')
      };
      moderationActions.push(entry);
      return { rows: [entry] };
    }

    // Latest moderation per target: SELECT DISTINCT ON (target_id) ... FROM discussion_moderation_actions
    if (/SELECT DISTINCT ON \(target_id\)/.test(sql) && /FROM discussion_moderation_actions/.test(sql)) {
      const targetType = params[0];
      const targetIds = params[1] || [];
      const filtered = moderationActions.filter(m => m.target_type === targetType && targetIds.includes(m.target_id));
      // Group by target_id, pick latest (max created_at)
      const latestMap = new Map();
      for (const m of filtered) {
        const existing = latestMap.get(m.target_id);
        if (!existing || new Date(m.created_at) > new Date(existing.created_at)) {
          latestMap.set(m.target_id, m);
        }
      }
      const rows = Array.from(latestMap.values()).map(m => ({
        target_id: m.target_id,
        target_type: m.target_type,
        action: m.action,
        actor_user_id: m.actor_user_id,
        created_at: m.created_at,
        actor_name: m.actor_name,
        actor_email: m.actor_email
      }));
      return { rows };
    }

    // Full history: SELECT m.*, u.email ... FROM discussion_moderation_actions WHERE target_type=$1 AND target_id=$2
    if (/FROM discussion_moderation_actions m/.test(sql) && /WHERE m\.target_type/.test(sql)) {
      const targetType = params[0];
      const targetId = params[1];
      const filtered = moderationActions.filter(m => m.target_type === targetType && m.target_id === targetId).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      const rows = filtered.map(m => ({
        ...m,
        actor_name: m.actor_name,
        actor_email: m.actor_email
      }));
      return { rows };
    }

    if (/INSERT INTO discussion_replies/.test(sql)) {
      const r = {
        id: nextReplyId++,
        discussion_id: params[0],
        user_id: params[1],
        body: params[2],
        status: 'visible',
        created_at: new Date(),
        updated_at: new Date(),
        author_email: 'other@example.com',
        author_name: 'Other User'
      };
      repliesInDB.push(r);
      return { rows: [r] };
    }

    if (/SELECT r\.id, r\.user_id, r\.discussion_id/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      if (r) {
        const d = discussionsInDB.find(d => d.id === r.discussion_id);
        return { rows: [{ ...r, item_path: d ? d.item_path : 'Guidewire/test.txt' }] };
      }
      return { rows: [] };
    }

    if (/COUNT\(\*\)::int AS total_questions/.test(sql)) {
      return {
        rows: [{
          total_questions: discussionsInDB.length,
          visible_questions: discussionsInDB.filter(d => d.status === 'visible').length,
          hidden_questions: discussionsInDB.filter(d => d.status === 'hidden').length,
          deleted_questions: discussionsInDB.filter(d => d.status === 'deleted').length,
          questions_today: discussionsInDB.filter(d => d.created_at > new Date(Date.now() - 86400000)).length,
          total_replies: repliesInDB.length,
          visible_replies: repliesInDB.filter(r => r.status === 'visible').length,
          hidden_replies: repliesInDB.filter(r => r.status === 'hidden').length,
          deleted_replies: repliesInDB.filter(r => r.status === 'deleted').length,
          replies_today: repliesInDB.filter(r => r.created_at > new Date(Date.now() - 86400000)).length
        }]
      };
    }

    if (/WITH filtered AS/.test(sql) && /COUNT\(\*\)::int AS count/.test(sql)) {
      let filtered = discussionsInDB.slice();
      const searchPattern = params.find(p => typeof p === 'string' && p.startsWith('%') && p.endsWith('%'));
      if (searchPattern) {
        const term = searchPattern.slice(1, -1).toLowerCase();
        if (term) {
          filtered = filtered.filter(d => {
            const fields = [
              String(d.title || '').toLowerCase(),
              String(d.body || '').toLowerCase(),
              String(d.author_name || 'Test User').toLowerCase(),
              String(d.author_email || 'test@example.com').toLowerCase(),
              String(d.item_path || '').toLowerCase(),
              String(d.id).toLowerCase(),
              String(d.status || '').toLowerCase()
            ];
            return fields.some(f => f.includes(term));
          });
        }
      }
      if (/d\.status = 'hidden'/.test(sql)) filtered = filtered.filter(d => d.status === 'hidden');
      else if (/d\.status = 'deleted'/.test(sql)) filtered = filtered.filter(d => d.status === 'deleted');
      if (/HAVING COUNT\(dr\.id\) FILTER/.test(sql) && / = 0/.test(sql)) {
        filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length === 0);
      } else if (/HAVING COUNT\(dr\.id\) FILTER/.test(sql) && /> 0/.test(sql)) {
        filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id && r.status === 'visible').length > 0);
      } else if (/HAVING COUNT\(dr\.id\) = 0/.test(sql)) {
        filtered = filtered.filter(d => repliesInDB.filter(r => r.discussion_id === d.id).length === 0);
      }
      return { rows: [{ count: filtered.length }] };
    }

    // Like count queries (item_likes covers videos as well via item_path)
    if (/SELECT COUNT\(\*\) AS cnt FROM item_likes/.test(sql)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SELECT id FROM item_likes/.test(sql)) {
      return { rows: [] };
    }

    // Video view counts — /watch page uses video_views
    if (/video_views/.test(sql) && /COUNT/.test(sql)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/INSERT INTO video_views/.test(sql)) {
      return { rows: [] };
    }

    return { rows: [] };
  };

  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;

  const testVideo = path.join(QUERIES_DIR, 'Videos', 'Finding Rate table & Routine Usages.mp4');
  await mkdir(path.dirname(testVideo), { recursive: true });
  await writeFile(testVideo, 'mock mp4 content');
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) {
    pool.query = originalQuery;
    originalQuery = null;
  }
});

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

// --- Basic access control ---

test('unauthenticated discussions page redirects to /login', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('discussions page with invalid path returns 400', async () => {
  const res = await http('/discussions?path=..%2F..%2Fetc%2Fpasswd', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 400);
});

test('discussions page with restricted path returns 404', async () => {
  const res = await http('/discussions?path=Internal%2Fsecret.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 404);
});

// --- Creating discussions ---

test('authenticated user can create a discussion', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  nextDiscussionId = 1;

  const res = await http('/discussions', {
    method: 'POST',
    headers: {
      Cookie: COOKIE,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      item_path: 'Guidewire/test.txt',
      title: 'How does this work?',
      body: 'I need help understanding this.'
    }),
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(res.headers.get('location')).includes('msg=Question posted'));
  assert.equal(discussionsInDB.length, 1);
  assert.equal(discussionsInDB[0].title, 'How does this work?');
  assert.equal(discussionsInDB[0].user_id, 10);
});

// --- Listing discussions ---

test('discussions page lists questions for an item', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /How does this work\?/);
  assert.match(html, /Discussions for/);
});

test('discussion card links use /discussions/:id, not the item_path', async () => {
  const dId = discussionsInDB[0].id;
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // The link must be /discussions/<numeric-id> only — no extra path segments
  assert.match(html, new RegExp(`href="/discussions/${dId}"`));
  // Must NOT contain the old broken pattern /discussions/<id>/<path>
  assert.doesNotMatch(html, new RegExp(`href="/discussions/${dId}/Guidewire"`));
});

test('discussion list filter links use ?path= query param', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/discussions\?path=Guidewire/);
  assert.match(html, /filter=newest/);
});

test('discussion list form action is /discussions with hidden item_path', async () => {
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /action="\/discussions"/);
  assert.match(html, /name="item_path"/);
});

// --- Viewing a discussion ---

test('viewing a discussion shows the question and replies', async () => {
  const dId = discussionsInDB[0].id;
  const res = await http(`/discussions/${dId}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /How does this work\?/);
  assert.match(html, /I need help understanding this/);
});

test('discussion thread breadcrumb links to /discussions?path=, not path-style URL', async () => {
  const dId = discussionsInDB[0].id;
  const res = await http(`/discussions/${dId}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/discussions\?path=Guidewire/);
  // Must NOT contain the old broken pattern /discussions/Guidewire/...
  assert.doesNotMatch(html, /href="\/discussions\/Guidewire/);
});

test('discussion list "Back to content" uses /query/ for .txt files', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3000, user_id: 10, item_path: 'Guidewire/Gosu/PC/Config/Unlocking from quoting.txt', title: 'Config question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FConfig%2FUnlocking%20from%20quoting.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/query\/Guidewire/);
  assert.doesNotMatch(html, /\/browse\/Guidewire.*Unlocking/);
});

test('discussion list "Back to content" uses /item/ for .pdf files', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3010, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/manual.pdf', title: 'PDF question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FRating%2Fmanual.pdf', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/item\/Guidewire/);
  assert.doesNotMatch(html, /\/browse\/Guidewire.*manual\.pdf/);
  assert.doesNotMatch(html, /\/query\/Guidewire.*manual\.pdf/);
});

test('discussion list "Back to content" uses /item/ for .xlsx files', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3020, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/data.xlsx', title: 'Spreadsheet question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FRating%2Fdata.xlsx', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/item\/Guidewire/);
  assert.doesNotMatch(html, /\/browse\/Guidewire.*data\.xlsx/);
});

test('discussion thread navigation uses /query/ for .txt files', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3100, user_id: 10, item_path: 'Guidewire/Gosu/PC/Config/Unlocking from quoting.txt', title: 'Thread for .txt', body: 'Body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions/3100', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/query\/Guidewire/);
  assert.doesNotMatch(html, /\/browse\/Guidewire.*Unlocking/);
});

test('discussion thread navigation uses /item/ for .pdf files', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3110, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/manual.pdf', title: 'Thread for .pdf', body: 'Body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions/3110', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/item\/Guidewire/);
  assert.doesNotMatch(html, /\/browse\/Guidewire.*manual\.pdf/);
});

test('discussion list "Back to content" uses /browse/ for folders', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 3200, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating', title: 'Folder question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FRating', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/browse\/Guidewire/);
});

// --- Posting replies ---

test('authenticated user can post a reply', async () => {
  repliesInDB.length = 0;
  const dId = discussionsInDB[0].id;
  const res = await http(`/discussions/${dId}/reply`, {
    method: 'POST',
    headers: {
      Cookie: COOKIE,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ body: 'Here is my reply.' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(res.headers.get('location')).includes('msg=Reply posted'));
  assert.equal(repliesInDB.length, 1);
  assert.equal(repliesInDB[0].body, 'Here is my reply.');
});

// --- Identity masking ---

test('other users see "Anonymous" for other authors', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 50, user_id: 10, item_path: 'Guidewire/test.txt', title: 'How does this work?', body: 'I need help.', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const dId = discussionsInDB[0].id;
  const res = await http(`/discussions/${dId}`, { headers: { Cookie: OTHER_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Anonymous/);
  assert.match(html, /How does this work\?/);
});

// --- Deleting own content ---

test('user can delete their own discussion', async () => {
  const before = discussionsInDB.length;
  const dId = discussionsInDB[0].id;
  const res = await http(`/discussions/${dId}/delete`, {
    method: 'POST',
    headers: { Cookie: COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  // Soft-delete: status changes to 'deleted', count stays same
  assert.equal(discussionsInDB.length, before);
  const d = discussionsInDB.find(d => d.id === dId);
  assert.equal(d.status, 'deleted');
});

// --- Admin moderation ---

test('admin can view discussions management page', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;

  discussionsInDB.push({
    id: 100,
    user_id: 10,
    item_path: 'Guidewire/test.txt',
    title: 'Admin test question',
    body: 'Test body',
    status: 'visible',
    created_at: new Date(),
    updated_at: new Date(),
    author_name: 'Test User',
    author_email: 'test@example.com'
  });

  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Discussions Management/);
  assert.match(html, /Admin test question/);
});

test('admin can hide a discussion', async () => {
  const res = await http('/admin/discussions/100/hide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=hidden'));
  const d = discussionsInDB.find(d => d.id === 100);
  assert.equal(d.status, 'hidden');
});

test('admin can unhide a discussion', async () => {
  const res = await http('/admin/discussions/100/unhide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  const d = discussionsInDB.find(d => d.id === 100);
  assert.equal(d.status, 'visible');
});

test('admin can delete a discussion', async () => {
  const before = discussionsInDB.length;
  const res = await http('/admin/discussions/100/delete', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  // Soft-delete: status changes to 'deleted', count stays same
  assert.equal(discussionsInDB.length, before);
  const d = discussionsInDB.find(d => d.id === 100);
  assert.equal(d.status, 'deleted');
});

test('admin page shows full identity for question author', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 900, user_id: 20, item_path: 'Guidewire/test.txt', title: 'Identity test', body: 'Body text', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Other User/);
  assert.match(html, /other@example\.com/);
  assert.match(html, /Body text/);
});

test('admin page shows replies with full identity and content', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 910, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Question with replies', body: 'Q body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 800, discussion_id: 910, user_id: 20, body: 'Reply body here', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Replies \(1 visible/);
  assert.match(html, /Reply body here/);
  assert.match(html, /Other User/);
  assert.match(html, /other@example\.com/);
});

test('admin page shows hidden replies alongside visible ones', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 920, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Hidden reply test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 810, discussion_id: 920, user_id: 20, body: 'Visible reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' },
    { id: 811, discussion_id: 920, user_id: 20, body: 'Hidden reply', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Replies \(.*visible.*hidden/);
  assert.match(html, /Visible reply/);
  assert.match(html, /Hidden reply/);
});

test('admin page filter links use correct query params', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 930, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Filter link test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/admin\/discussions\?filter=unanswered/);
  assert.match(html, /\/admin\/discussions\?filter=answered/);
  assert.match(html, /\/admin\/discussions\?filter=most-replies/);
  assert.match(html, /\/admin\/discussions\?filter=no-replies/);
  assert.match(html, /\/admin\/discussions\?filter=hidden/);
  assert.match(html, /\/admin\/discussions\?filter=newest/);
});

test('admin page shows stats counts', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 940, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Stats test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' },
    { id: 941, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Hidden one', body: '', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Total questions/);
  assert.match(html, /Visible/);
  assert.match(html, /Hidden/);
  assert.match(html, /Total replies/);
});

test('admin can hide a reply from admin page', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 950, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Reply hide test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 820, discussion_id: 950, user_id: 20, body: 'To be hidden', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  const res = await http('/admin/discussions/replies/820/hide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=replyHidden'));
  const r = repliesInDB.find(r => r.id === 820);
  assert.equal(r.status, 'hidden');
});

test('admin can unhide a reply from admin page', async () => {
  const res = await http('/admin/discussions/replies/820/unhide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=replyUnhidden'));
  const r = repliesInDB.find(r => r.id === 820);
  assert.equal(r.status, 'visible');
});

test('admin can delete a reply from admin page', async () => {
  const before = repliesInDB.length;
  const res = await http('/admin/discussions/replies/820/delete', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=replyDeleted'));
  // Soft-delete: reply count stays same, but status changes to 'deleted'
  assert.equal(repliesInDB.length, before);
  const r = repliesInDB.find(r => r.id === 820);
  assert.equal(r.status, 'deleted');
});

test('admin page shows hidden discussions in list', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 960, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Visible one', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' },
    { id: 961, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Hidden one', body: '', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visible one/);
  assert.match(html, /Hidden one/);
});

// --- RBAC enforcement ---

test('non-admin cannot access admin discussions page', async () => {
  const res = await http('/admin/discussions', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403);
});

// --- Filter validation ---

test('invalid filter defaults to newest', async () => {
  discussionsInDB.length = 0;
  discussionsInDB.push({
    id: 200,
    user_id: 10,
    item_path: 'Guidewire/test.txt',
    title: 'Filter test',
    body: '',
    status: 'visible',
    created_at: new Date(),
    updated_at: new Date(),
    author_name: 'Test User',
    author_email: 'test@example.com'
  });
  const res = await http('/discussions?path=Guidewire%2Ftest.txt&filter=invalid', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Filter test/);
});

// --- Discussion link in item pages ---

test('discussions link is accessible via discussions route', async () => {
  discussionsInDB.length = 0;
  discussionsInDB.push({
    id: 300,
    user_id: 20,
    item_path: 'Guidewire/Gosu/PC/Rating/test.txt',
    title: 'Item discussion',
    body: 'About this item',
    status: 'visible',
    created_at: new Date(),
    updated_at: new Date(),
    author_name: 'Other User',
    author_email: 'other@example.com'
  });
  const res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FRating%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Item discussion/);
});

// --- Security: cross-item RBAC ---

test('discussions list only shows items for the requested path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 500, user_id: 10, item_path: 'Guidewire/test.txt', title: 'On test.txt', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' },
    { id: 501, user_id: 10, item_path: 'Guidewire/other.txt', title: 'On other.txt', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /On test\.txt/);
  assert.doesNotMatch(html, /On other\.txt/);
});

// --- Security: hidden replies not shown to normal users ---

test('hidden replies are not shown to normal users', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 600, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Hidden reply test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 700, discussion_id: 600, user_id: 20, body: 'Visible reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'other@example.com', author_name: 'Other' },
    { id: 701, discussion_id: 600, user_id: 20, body: 'Secret hidden reply', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_email: 'other@example.com', author_name: 'Other' }
  );
  const res = await http('/discussions/600', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visible reply/);
  assert.doesNotMatch(html, /Secret hidden reply/);
});

test('hidden replies are shown to admin users', async () => {
  const res = await http('/discussions/600', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visible reply/);
  assert.match(html, /Secret hidden reply/);
});

// --- Security: unauthorized delete returns 403 ---

test('non-owner non-admin cannot delete a discussion', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 800, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Not my question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions/800/delete', {
    method: 'POST',
    headers: { Cookie: OTHER_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Not authorized/);
  assert.equal(discussionsInDB.length, 1);
});

test('non-owner non-admin cannot delete a reply', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 900, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Thread', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 910, discussion_id: 900, user_id: 10, body: 'Owner reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'user@example.com', author_name: 'User' }
  );
  const res = await http('/discussions/replies/910/delete', {
    method: 'POST',
    headers: { Cookie: OTHER_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);
  assert.equal(repliesInDB.length, 1);
});

// --- Security: direct-ID RBAC bypass prevention ---

test('user cannot view discussion on inaccessible item via direct ID', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 1000, user_id: 20, item_path: 'Internal/secret.txt', title: 'Secret discussion', body: 'Hidden content', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'B', author_email: 'b@x.com' }
  );
  const res = await http('/discussions/1000', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 404);
});

test('user cannot reply to discussion on inaccessible item via direct ID', async () => {
  const res = await http('/discussions/1000/reply', {
    method: 'POST',
    headers: { Cookie: COOKIE, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: 'sneaky reply' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.equal(repliesInDB.length, 0);
});

test('user cannot delete discussion on inaccessible item via direct ID', async () => {
  const res = await http('/discussions/1000/delete', {
    method: 'POST',
    headers: { Cookie: COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);
  assert.equal(discussionsInDB.length, 1);
});

// --- Security: hidden discussions not shown in list ---

test('hidden discussions are excluded from list', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 1100, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Visible question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' },
    { id: 1101, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Hidden question', body: '', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visible question/);
  assert.doesNotMatch(html, /Hidden question/);
});

// --- Security: admin moderation endpoints ---

test('admin can hide and unhide replies', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 1200, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Mod test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 1210, discussion_id: 1200, user_id: 20, body: 'Moderate me', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'other@example.com', author_name: 'Other' }
  );

  let res = await http('/admin/discussions/replies/1210/hide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.equal(repliesInDB[0].status, 'hidden');

  res = await http('/admin/discussions/replies/1210/unhide', {
    method: 'POST',
    headers: { Cookie: ADMIN_COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.equal(repliesInDB[0].status, 'visible');
});

test('non-admin cannot access admin discussion endpoints', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 1300, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Normal', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );

  let res = await http('/admin/discussions/1300/hide', {
    method: 'POST',
    headers: { Cookie: COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);

  res = await http('/admin/discussions/1300/unhide', {
    method: 'POST',
    headers: { Cookie: COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);

  res = await http('/admin/discussions/1300/delete', {
    method: 'POST',
    headers: { Cookie: COOKIE },
    redirect: 'manual'
  });
  assert.equal(res.status, 403);
});

// --- Security: reply counts only visible replies ---

test('reply counts in list only count visible replies', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 1400, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Count test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 1410, discussion_id: 1400, user_id: 20, body: 'r1', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'o@x.com', author_name: 'O' },
    { id: 1411, discussion_id: 1400, user_id: 20, body: 'r2', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_email: 'o@x.com', author_name: 'O' },
    { id: 1412, discussion_id: 1400, user_id: 20, body: 'r3', status: 'visible', created_at: new Date(), updated_at: new Date(), author_email: 'o@x.com', author_name: 'O' }
  );
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /2 replies/);
});

// --- Detail-page integration: discussions section on query page ---

const EXISTING_QUERY = 'Guidewire/Gosu/PC/Rating/Rate table Usage in RR\'s.txt';

test('query detail page shows discussions section with post form', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const filePath = path.join(QUERIES_DIR, EXISTING_QUERY);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'dummy query content');
  try {
    const res = await http(`/query/${enc(EXISTING_QUERY)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /Post your question/);
    assert.match(html, /Anonymous/);
    assert.match(html, /detail-discussions/);
  } finally {
    await writeFile(filePath, "// Rate table Usage in RR's query\n");
  }
});

test('query detail page shows only discussions for this item_path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 2000, user_id: 10, item_path: EXISTING_QUERY, title: 'Matched question', body: 'Body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' },
    { id: 2001, user_id: 10, item_path: 'Guidewire/other.txt', title: 'Other question', body: 'Body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const filePath = path.join(QUERIES_DIR, EXISTING_QUERY);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'dummy query content');
  try {
    const res = await http(`/query/${enc(EXISTING_QUERY)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Matched question/);
    assert.doesNotMatch(html, /Other question/);
  } finally {
    await writeFile(filePath, "// Rate table Usage in RR's query\n");
  }
});

test('query detail page discussion form posts to /discussions with correct path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const filePath = path.join(QUERIES_DIR, EXISTING_QUERY);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'dummy query content');
  try {
    const res = await http(`/query/${enc(EXISTING_QUERY)}`, { headers: { Cookie: COOKIE } });
    const html = await res.text();
    assert.match(html, /action="\/discussions"/);
    // The path is HTML-escaped in the value attribute (&#39; for single quote)
    assert.match(html, /value="Guidewire\/Gosu\/PC\/Rating\/Rate table Usage in RR/);
  } finally {
    await writeFile(filePath, "// Rate table Usage in RR's query\n");
  }
});

// --- Detail-page integration: discussions section on item page ---

test('item detail page shows discussions section', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_item_test');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'note.pdf'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_item_test/note.pdf';
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /Post your question/);
    assert.match(html, /Anonymous/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('item detail page shows only discussions for this item_path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_item_test2');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'note.pdf'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_item_test2/note.pdf';
    discussionsInDB.push(
      { id: 2100, user_id: 10, item_path: p, title: 'Matched item question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' },
      { id: 2101, user_id: 10, item_path: 'Guidewire/other.txt', title: 'Other item question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
    );
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Matched item question/);
    assert.doesNotMatch(html, /Other item question/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('item detail page discussion form posts to /discussions with correct path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_item_test3');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'doc.pdf'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_item_test3/doc.pdf';
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    const html = await res.text();
    assert.match(html, /action="\/discussions"/);
    assert.match(html, new RegExp(`value="${p}"`));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- Regression: Discussion section available for every supported CONTENT ITEM type ---

test('regression: TXT detail page still shows discussions (query route)', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const filePath = path.join(QUERIES_DIR, EXISTING_QUERY);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'dummy query content');
  try {
    const res = await http(`/query/${enc(EXISTING_QUERY)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /detail-discussions/);
    assert.match(html, /name="item_path"/);
    assert.match(html, /value="Guidewire\/Gosu\/PC\/Rating\/Rate table Usage in RR/);
  } finally {
    await writeFile(filePath, "// Rate table Usage in RR's query\n");
  }
});

test('regression: PDF detail page shows discussions (item route)', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_regression_pdf');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'manual.pdf'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_regression_pdf/manual.pdf';
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /detail-discussions/);
    assert.match(html, new RegExp(`value="${p.replace(/\//g, '\\/')}"`));
    assert.match(html, /action="\/discussions"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regression: XLSX detail page shows discussions (item route, spreadsheet type)', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_regression_xlsx');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'data.xlsx'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_regression_xlsx/data.xlsx';
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /detail-discussions/);
    assert.match(html, new RegExp(`value="${p.replace(/\//g, '\\/')}"`));
    assert.match(html, /action="\/discussions"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regression: Video (MP4) detail page shows discussions below player', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  // Use existing video fixture so it is already in the library cache (new temp videos would miss cache)
  const p = 'Videos/Finding Rate table & Routine Usages.mp4';
  const res = await http(`/watch/${enc(p)}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Must be below video/player and engagement controls
  assert.match(html, /<video controls/);
  assert.match(html, /like-control/);
  assert.match(html, /Have a question\?/);
  assert.match(html, /detail-discussions/);
  assert.match(html, /Anonymous/);
  // form posts correct item_path (HTML-escaped)
  assert.match(html, /name="item_path"/);
  assert.match(html, /action="\/discussions"/);
  // Order check: video-meta before detail-discussions
  const metaIdx = html.indexOf('video-meta');
  const discIdx = html.indexOf('detail-discussions');
  assert.ok(metaIdx !== -1 && discIdx !== -1 && discIdx > metaIdx, 'discussions should be below engagement controls');
});

test('regression: Video detail page discussion form posts correct item_path and filters by path', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const p = 'Videos/Finding Rate table & Routine Usages.mp4';
  discussionsInDB.push(
    { id: 2200, user_id: 10, item_path: p, title: 'Matched video question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' },
    { id: 2201, user_id: 10, item_path: 'Guidewire/other.txt', title: 'Other video question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  const res = await http(`/watch/${enc(p)}`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Matched video question/);
  assert.doesNotMatch(html, /Other video question/);
  // item_path in hidden input should be the video path
  assert.match(html, /name="item_path"/);
  assert.match(html, new RegExp(`value="Videos\\/Finding Rate table`));
});

test('regression: Image detail page shows discussions (item route, image type)', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  const base = path.join(QUERIES_DIR, 'Guidewire', '__disc_regression_image');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'photo.png'), Buffer.alloc(256));
  try {
    const p = 'Guidewire/__disc_regression_image/photo.png';
    const res = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Have a question\?/);
    assert.match(html, /detail-discussions/);
    assert.match(html, new RegExp(`value="${p.replace(/\//g, '\\/')}"`));
    assert.match(html, /action="\/discussions"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regression: Folder path does NOT get a discussion section', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  // /browse is a folder view — it should not contain the detail-discussions section
  const res = await http('/browse/Guidewire%2FGosu%2FPC%2FRating', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /detail-discussions/);
  assert.doesNotMatch(html, /Have a question\?/);
});

// --- Regression: duplicate Delete buttons for Admin-owned content ---

test('admin-owned question does not render duplicate Delete controls on thread page', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5000, user_id: 99, item_path: 'Guidewire/test.txt', title: 'Admin owned question', body: 'Admin body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Admin User', author_email: 'admin@example.com' }
  );
  const res = await http('/discussions/5000', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Owner-level Delete question must NOT be rendered for Admin (would be duplicate)
  assert.doesNotMatch(html, /Delete question/);
  // Admin moderation controls must still be present: Hide + Delete (admin)
  assert.match(html, new RegExp(`action="/admin/discussions/5000/hide"`));
  assert.match(html, new RegExp(`action="/admin/discussions/5000/delete"`));
  // Exactly one admin Delete button, no owner Delete
  const ownerDeletes = (html.match(/Delete question/g) || []).length;
  assert.equal(ownerDeletes, 0);
  const adminDeletes = (html.match(/\/admin\/discussions\/5000\/delete/g) || []).length;
  assert.equal(adminDeletes, 1);
});

test('admin-owned reply does not render duplicate Delete controls on thread page', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5001, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Question for reply', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 6000, discussion_id: 5001, user_id: 99, body: 'Admin reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Admin User', author_email: 'admin@example.com' }
  );
  const res = await http('/discussions/5001', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Owner-level Delete (POST /discussions/replies/6000/delete) must NOT appear for Admin
  assert.doesNotMatch(html, new RegExp(`action="/discussions/replies/6000/delete"`));
  // Admin moderation controls must still be present for the reply
  assert.match(html, new RegExp(`action="/admin/discussions/replies/6000/hide"`));
  assert.match(html, new RegExp(`action="/admin/discussions/replies/6000/delete"`));
  const ownerReplyDeletes = (html.match(/action="\/discussions\/replies\/6000\/delete"/g) || []).length;
  assert.equal(ownerReplyDeletes, 0);
  const adminReplyDeletes = (html.match(/\/admin\/discussions\/replies\/6000\/delete/g) || []).length;
  assert.equal(adminReplyDeletes, 1);
});

test('admin-owned question does not render duplicate Delete on list page', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5002, user_id: 99, item_path: 'Guidewire/test.txt', title: 'Admin list question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Admin User', author_email: 'admin@example.com' }
  );
  const res = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Owner delete must not appear for admin on list page
  assert.doesNotMatch(html, new RegExp(`action="/discussions/5002/delete"`));
  // Admin controls must be present instead
  assert.match(html, new RegExp(`action="/admin/discussions/5002/hide"`));
  assert.match(html, new RegExp(`action="/admin/discussions/5002/delete"`));
});

test('admin can still Hide/Delete questions via moderation endpoints', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5003, user_id: 99, item_path: 'Guidewire/test.txt', title: 'Admin hide test', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Admin User', author_email: 'admin@example.com' }
  );
  let res = await http('/admin/discussions/5003/hide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(discussionsInDB.find(d => d.id === 5003).status, 'hidden');
  res = await http('/admin/discussions/5003/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(discussionsInDB.find(d => d.id === 5003).status, 'deleted');
});

test('admin can still Hide/Delete replies via moderation endpoints', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5004, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q for admin reply mod', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 6001, discussion_id: 5004, user_id: 99, body: 'Admin reply mod', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Admin User', author_email: 'admin@example.com' }
  );
  let res = await http('/admin/discussions/replies/6001/hide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(repliesInDB.find(r => r.id === 6001).status, 'hidden');
  res = await http('/admin/discussions/replies/6001/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(repliesInDB.find(r => r.id === 6001).status, 'deleted');
});

test('normal user retains Delete for own question and no admin controls', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5005, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Normal owned question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/discussions/5005', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Normal owner should see owner Delete question
  assert.match(html, new RegExp(`action="/discussions/5005/delete"`));
  // Must NOT see admin controls
  assert.doesNotMatch(html, /\/admin\/discussions\/5005\/hide/);
  assert.doesNotMatch(html, /\/admin\/discussions\/5005\/delete/);
});

test('normal user retains Delete for own reply and no admin controls', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5006, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q for normal reply', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 6002, discussion_id: 5006, user_id: 10, body: 'Normal reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/discussions/5006', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`action="/discussions/replies/6002/delete"`));
  assert.doesNotMatch(html, /\/admin\/discussions\/replies\/6002\/hide/);
  assert.doesNotMatch(html, /\/admin\/discussions\/replies\/6002\/delete/);
});

test('normal user does not see admin moderation controls on others content', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 5007, user_id: 20, item_path: 'Guidewire/test.txt', title: 'Other question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  repliesInDB.push(
    { id: 6003, discussion_id: 5007, user_id: 20, body: 'Other reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Other User', author_email: 'other@example.com' }
  );
  const resThread = await http('/discussions/5007', { headers: { Cookie: COOKIE } });
  assert.equal(resThread.status, 200);
  const htmlThread = await resThread.text();
  assert.doesNotMatch(htmlThread, /\/admin\/discussions\/5007\//);
  assert.doesNotMatch(htmlThread, /\/admin\/discussions\/replies\/6003\//);
  // No Delete for other user's question/reply
  assert.doesNotMatch(htmlThread, new RegExp(`action="/discussions/5007/delete"`));
  assert.doesNotMatch(htmlThread, new RegExp(`action="/discussions/replies/6003/delete"`));

  const resList = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  assert.equal(resList.status, 200);
  const htmlList = await resList.text();
  assert.doesNotMatch(htmlList, /\/admin\/discussions\/5007\//);
});

// ========================================================
// PHASE 1: Deleted restore, audit, search, pagination
// ========================================================

test('PHASE1: Admin can delete a question and it remains in DB under Deleted filter', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7000, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Delete me question', body: 'body here', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/admin/discussions/7000/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  const d = discussionsInDB.find(d => d.id === 7000);
  assert.equal(d.status, 'deleted');
  assert.ok(d.deleted_at);
  assert.equal(d.deleted_by, 99);
  // Deleted content appears in Admin Deleted filter
  const listRes = await http('/admin/discussions?filter=deleted', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(listRes.status, 200);
  const html = await listRes.text();
  assert.match(html, /Delete me question/);
  // But normal user cannot see deleted content
  const userRes = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  const userHtml = await userRes.text();
  assert.doesNotMatch(userHtml, /Delete me question/);
});

test('PHASE1: Admin can delete a reply and it remains in DB', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7001, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q for reply delete', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 7002, discussion_id: 7001, user_id: 10, body: 'Reply to delete', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  const res = await http('/admin/discussions/replies/7002/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  const r = repliesInDB.find(r => r.id === 7002);
  assert.equal(r.status, 'deleted');
  assert.ok(r.deleted_at);
  // Admin can see deleted reply in admin view
  const adminRes = await http('/admin/discussions?filter=deleted', { headers: { Cookie: ADMIN_COOKIE } });
  // Not directly checking deleted filter for replies, but admin thread shows deleted
  // Verify via admin discussion page with that question
  const adminHtml = await adminRes.text();
  // The question is not deleted, so deleted filter won't show it; check admin view for question still visible but reply deleted
  // Instead check that reply is still in DB and visible to admin via thread
  const threadRes = await http('/discussions/7001', { headers: { Cookie: ADMIN_COOKIE } });
  const threadHtml = await threadRes.text();
  assert.match(threadHtml, /Reply to delete/);
});

test('PHASE1: Admin can restore deleted question', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7100, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Restore me', body: 'content', status: 'deleted', created_at: new Date(Date.now()-86400000), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, deleted_by_name: 'Admin User', deleted_by_email: 'admin@example.com', author_name: 'Test User', author_email: 'test@example.com' }
  );
  moderationActions.push({ id: 9000, target_type: 'question', target_id: 7100, action: 'delete', actor_user_id: 99, created_at: new Date(Date.now()-3600000), actor_name: 'Admin User', actor_email: 'admin@example.com' });
  const res = await http('/admin/discussions/7100/restore', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=restored'));
  const d = discussionsInDB.find(d => d.id === 7100);
  assert.equal(d.status, 'visible');
  assert.equal(d.deleted_at, null);
  assert.equal(d.deleted_by, null);
  // Restored question becomes visible to normal user
  const userRes = await http('/discussions?path=Guidewire%2Ftest.txt', { headers: { Cookie: COOKIE } });
  const userHtml = await userRes.text();
  assert.match(userHtml, /Restore me/);
  // Restore creates audit event
  const audit = moderationActions.filter(m => m.target_type === 'question' && m.target_id === 7100 && m.action === 'restore');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, 99);
  // History remains: delete + restore
  const hist = moderationActions.filter(m => m.target_id === 7100);
  assert.ok(hist.some(h => h.action === 'delete'));
  assert.ok(hist.some(h => h.action === 'restore'));
});

test('PHASE1: Admin can restore deleted reply', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7101, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q for restore reply', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' }
  );
  repliesInDB.push(
    { id: 7102, discussion_id: 7101, user_id: 10, body: 'Deleted reply to restore', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, author_name: 'Test User', author_email: 'test@example.com' }
  );
  moderationActions.push({ id: 9001, target_type: 'reply', target_id: 7102, action: 'delete', actor_user_id: 99, created_at: new Date(Date.now()-3600000), actor_name: 'Admin User', actor_email: 'admin@example.com' });
  const res = await http('/admin/discussions/replies/7102/restore', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes('msg=replyRestored'));
  const r = repliesInDB.find(r => r.id === 7102);
  assert.equal(r.status, 'visible');
  assert.equal(r.deleted_at, null);
  // Restored reply visible to normal user
  const threadRes = await http('/discussions/7101', { headers: { Cookie: COOKIE } });
  const threadHtml = await threadRes.text();
  assert.match(threadHtml, /Deleted reply to restore/);
  // Audit
  const audit = moderationActions.filter(m => m.target_type === 'reply' && m.target_id === 7102 && m.action === 'restore');
  assert.equal(audit.length, 1);
});

test('PHASE1: Audit records actor + timestamp for delete/hide/unhide/restore', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7200, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Audit test question', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 7201, discussion_id: 7200, user_id: 10, body: 'Audit reply', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  await http('/admin/discussions/7200/hide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/7200/unhide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/7200/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/7200/restore', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/replies/7201/hide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/replies/7201/unhide', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/replies/7201/delete', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });
  await http('/admin/discussions/replies/7201/restore', { method: 'POST', headers: { Cookie: ADMIN_COOKIE }, redirect: 'manual' });

  const qActions = moderationActions.filter(m => m.target_type === 'question' && m.target_id === 7200);
  assert.ok(qActions.some(a => a.action === 'hide' && a.actor_user_id === 99));
  assert.ok(qActions.some(a => a.action === 'unhide' && a.actor_user_id === 99));
  assert.ok(qActions.some(a => a.action === 'delete' && a.actor_user_id === 99));
  assert.ok(qActions.some(a => a.action === 'restore' && a.actor_user_id === 99));
  for (const a of qActions) assert.ok(a.created_at instanceof Date);

  const rActions = moderationActions.filter(m => m.target_type === 'reply' && m.target_id === 7201);
  assert.ok(rActions.some(a => a.action === 'hide'));
  assert.ok(rActions.some(a => a.action === 'unhide'));
  assert.ok(rActions.some(a => a.action === 'delete'));
  assert.ok(rActions.some(a => a.action === 'restore'));

  // History remains after restore: both delete and restore present
  assert.ok(qActions.some(a => a.action === 'delete'));
  assert.ok(qActions.some(a => a.action === 'restore'));
  assert.ok(rActions.some(a => a.action === 'delete'));
  assert.ok(rActions.some(a => a.action === 'restore'));

  // Admin UI shows latest moderation info (Deleted by / Restored by etc)
  // For question now visible after restore, latest is restore, should show Restored by
  const adminRes = await http('/admin/discussions?filter=all', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await adminRes.text();
  assert.match(html, /Restored by/);
});

test('PHASE1: Normal user cannot restore and cannot view deleted content or audit', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7300, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Normal cannot restore', body: '', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 7301, discussion_id: 7300, user_id: 10, body: 'Deleted reply', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, author_name: 'Test User', author_email: 'test@example.com' }
  );
  // Normal user cannot restore question
  let res = await http('/admin/discussions/7300/restore', { method: 'POST', headers: { Cookie: COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 403);
  assert.equal(discussionsInDB.find(d => d.id === 7300).status, 'deleted');
  // Normal user cannot restore reply
  res = await http('/admin/discussions/replies/7301/restore', { method: 'POST', headers: { Cookie: COOKIE }, redirect: 'manual' });
  assert.equal(res.status, 403);
  assert.equal(repliesInDB.find(r => r.id === 7301).status, 'deleted');
  // Normal user cannot view deleted content via direct ID
  res = await http('/discussions/7300', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 404);
  // Normal user cannot view admin page (which contains audit)
  res = await http('/admin/discussions', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403);
  // Normal user viewing visible question should not see audit info
  discussionsInDB.push(
    { id: 7302, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Visible for normal', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  res = await http('/discussions/7302', { headers: { Cookie: COOKIE } });
  const html = await res.text();
  assert.doesNotMatch(html, /Deleted by/);
  assert.doesNotMatch(html, /Hidden by/);
  assert.doesNotMatch(html, /Restored by/);
});

test('PHASE1: Search by title, body, author, email, path, ID, status with filters', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 7400, user_id: 10, item_path: 'Guidewire/Gosu/PC/Config/Bundle.txt', title: 'Bundle question', body: 'UniqueBody123', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, author_name: 'Alice Wonder', author_email: 'alice@example.com' },
    { id: 7401, user_id: 10, item_path: 'Guidewire/other.txt', title: 'Other question', body: 'Other body', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'Bob Builder', author_email: 'bob@example.com' },
    { id: 7402, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/manual.pdf', title: 'PDF question', body: 'PDF body', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'Alice Wonder', author_email: 'alice@example.com' }
  );
  // Search by title with Deleted filter
  let res = await http('/admin/discussions?filter=deleted&search=Bundle', { headers: { Cookie: ADMIN_COOKIE } });
  let html = await res.text();
  assert.match(html, /Bundle question/);
  assert.doesNotMatch(html, /Other question/);

  // Search by body
  res = await http('/admin/discussions?search=UniqueBody123', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);

  // Search by author
  res = await http('/admin/discussions?search=Alice', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);
  assert.match(html, /PDF question/);
  assert.doesNotMatch(html, /Other question/);

  // Search by email
  res = await http('/admin/discussions?search=alice@example.com', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);

  // Search by path
  res = await http('/admin/discussions?search=Bundle.txt', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);

  // Search by ID
  res = await http('/admin/discussions?search=7400', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);

  // Search by status
  res = await http('/admin/discussions?search=deleted', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);
  // Search works with filter: Bundle + Deleted
  res = await http('/admin/discussions?filter=deleted&search=Bundle', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);
  // Hidden filter with search
  res = await http('/admin/discussions?filter=hidden&search=PDF', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /PDF question/);
  // q alias should also work
  res = await http('/admin/discussions?filter=deleted&q=Bundle', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /Bundle question/);
});

test('PHASE1: Pagination preserves filter and search', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  // Create 30 questions
  for (let i = 0; i < 30; i++) {
    discussionsInDB.push(
      { id: 8000 + i, user_id: 10, item_path: 'Guidewire/test.txt', title: `Paginated question ${i}`, body: '', status: 'visible', created_at: new Date(Date.now() - i * 1000), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
    );
  }
  // Page 1
  let res = await http('/admin/discussions?page=1', { headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);
  let html = await res.text();
  assert.match(html, /Paginated question/);
  // Should have Next and page numbers, no Previous on page 1
  assert.match(html, /Next/);
  assert.match(html, />1</);
  assert.match(html, />2</);
  // Page 2 should be different
  res = await http('/admin/discussions?page=2', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.equal(res.status, 200);
  // Page 2 should have Previous
  assert.match(html, /Previous/);
  assert.match(html, />2</);
  // Filter preserved across pages
  res = await http('/admin/discussions?filter=deleted&page=2', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /filter=deleted/);
  // Search preserved across pages (using search param) — need enough matching items to paginate
  for (let i = 0; i < 26; i++) {
    discussionsInDB.push(
      { id: 9000 + i, user_id: 10, item_path: 'Guidewire/test.txt', title: `Search paginated ${i}`, body: '', status: 'visible', created_at: new Date(Date.now() - i * 100), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
    );
  }
  res = await http('/admin/discussions?search=Search%20paginated&page=1', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  // Pagination links should preserve search when there are enough results to paginate
  assert.match(html, /search=Search/);
  assert.match(html, /Next/);
  // Also test q alias preserved? Template uses searchTerm, but pagination should include search param
  res = await http('/admin/discussions?q=Search%20paginated&page=1', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  // Should still preserve (as search)
  assert.match(html, /search=Search/);
  assert.match(html, /Next/);
});

test('PHASE1: Content routing agnostic for TXT/PDF/XLSX/MP4/image/folder', async () => {
  // TXT -> /query/
  let res = await http('/discussions?path=Guidewire%2FGosu%2FPC%2FConfig%2FUnlocking%20from%20quoting.txt', { headers: { Cookie: COOKIE } });
  let html = await res.text();
  assert.match(html, /\/query\/Guidewire/);
  // PDF -> /item/
  discussionsInDB.length = 0; repliesInDB.length = 0;
  discussionsInDB.push({ id: 8500, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/manual.pdf', title: 'PDF routing', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' });
  res = await http('/admin/discussions?search=PDF%20routing', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /\/item\/Guidewire/);
  // XLSX -> /item/
  discussionsInDB.push({ id: 8501, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating/data.xlsx', title: 'XLSX routing', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' });
  res = await http('/admin/discussions?search=XLSX%20routing', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /\/item\/Guidewire.*data\.xlsx/);
  // MP4 -> /watch/
  discussionsInDB.push({ id: 8502, user_id: 10, item_path: 'Videos/Finding Rate table & Routine Usages.mp4', title: 'Video routing', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' });
  res = await http('/admin/discussions?search=Video%20routing', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /\/watch\/Videos/);
  // image -> /item/
  discussionsInDB.push({ id: 8503, user_id: 10, item_path: 'Guidewire/images/photo.png', title: 'Image routing', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' });
  res = await http('/admin/discussions?search=Image%20routing', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /\/item\/Guidewire\/images\/photo\.png/);
  // folder -> /browse/
  discussionsInDB.push({ id: 8504, user_id: 10, item_path: 'Guidewire/Gosu/PC/Rating', title: 'Folder routing', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@x.com' });
  res = await http('/admin/discussions?search=Folder%20routing', { headers: { Cookie: ADMIN_COOKIE } });
  html = await res.text();
  assert.match(html, /\/browse\/Guidewire/);
  // Ensure targets open in new tab
  assert.match(html, /target="_blank"/);
});

test('PHASE1: Admin UI shows badges, reply counts, deleted/hidden by info', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0; moderationActions.length = 0;
  discussionsInDB.push(
    { id: 8600, user_id: 10, item_path: 'Guidewire/test.txt', title: 'UI deleted question', body: 'body', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, deleted_by_name: 'Admin User', deleted_by_email: 'admin@example.com', author_name: 'Test User', author_email: 'test@example.com' }
  );
  repliesInDB.push(
    { id: 8601, discussion_id: 8600, user_id: 10, body: 'Deleted reply', status: 'deleted', created_at: new Date(), updated_at: new Date(), deleted_at: new Date(), deleted_by: 99, deleted_by_name: 'Admin User', deleted_by_email: 'admin@example.com', author_name: 'Test User', author_email: 'test@example.com' },
    { id: 8602, discussion_id: 8600, user_id: 10, body: 'Hidden reply', status: 'hidden', created_at: new Date(), updated_at: new Date(), author_name: 'Test User', author_email: 'test@example.com' }
  );
  moderationActions.push({ id: 9100, target_type: 'question', target_id: 8600, action: 'delete', actor_user_id: 99, created_at: new Date(), actor_name: 'Admin User', actor_email: 'admin@example.com' });
  moderationActions.push({ id: 9101, target_type: 'reply', target_id: 8602, action: 'hide', actor_user_id: 99, created_at: new Date(), actor_name: 'Admin User', actor_email: 'admin@example.com' });
  const res = await http('/admin/discussions?filter=deleted', { headers: { Cookie: ADMIN_COOKIE } });
  const html = await res.text();
  // Badges should be uppercase
  assert.match(html, /DELETED/);
  // Question shows deleted status badge
  assert.match(html, /badge.*DELETED/);
  // Reply counts visible/hidden/deleted
  assert.match(html, /visible \/.*hidden \/.*deleted/);
  // Deleted by info
  assert.match(html, /Deleted by:/);
  assert.match(html, /admin@example.com/);
  // Hidden reply should show hidden badge and hidden by
  // Need to fetch all discussions (not just deleted filter) to see hidden reply
  const res2 = await http('/admin/discussions', { headers: { Cookie: ADMIN_COOKIE } });
  const html2 = await res2.text();
  assert.match(html2, /HIDDEN/);
  // Restore button for deleted question/reply
  assert.match(html, /Restore/);
});

test('Admin and Owner replies display Admin Reply badge, normal user replies do not', async () => {
  discussionsInDB.length = 0; repliesInDB.length = 0;
  discussionsInDB.push({
    id: 9900,
    user_id: 10,
    item_path: 'Guidewire/test.txt',
    title: 'Question for Admin Reply Badge',
    body: 'How to do this?',
    status: 'visible',
    created_at: new Date(),
    updated_at: new Date(),
    author_name: 'Regular User',
    author_email: 'user@example.com'
  });

  // Reply 1: Normal USER (user_id 10)
  repliesInDB.push({
    id: 9901,
    discussion_id: 9900,
    user_id: 10,
    body: 'User reply here',
    status: 'visible',
    created_at: new Date(),
    updated_at: new Date(),
    author_name: 'Regular User',
    author_email: 'user@example.com',
    author_app_role: 'USER'
  });

  // Reply 2: ADMIN (user_id 99)
  repliesInDB.push({
    id: 9902,
    discussion_id: 9900,
    user_id: 99,
    body: 'Admin reply here',
    status: 'visible',
    created_at: new Date(Date.now() + 1000),
    updated_at: new Date(),
    author_name: 'Admin User',
    author_email: 'admin@example.com',
    author_app_role: 'ADMIN'
  });

  // Reply 3: OWNER (user_id 1)
  repliesInDB.push({
    id: 9903,
    discussion_id: 9900,
    user_id: 1,
    body: 'Owner reply here',
    status: 'visible',
    created_at: new Date(Date.now() + 2000),
    updated_at: new Date(),
    author_name: 'Owner User',
    author_email: 'owner@example.com',
    author_app_role: 'OWNER'
  });

  const res = await http('/discussions/9900', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();

  // Admin Reply badge should be displayed for ADMIN and OWNER replies
  const matches = [...html.matchAll(/data-testid="admin-reply-badge"/g)];
  assert.equal(matches.length, 2, 'Exactly 2 Admin Reply badges rendered for ADMIN and OWNER replies');
  assert.match(html, /Admin Reply/);
});


test('Accept Answer - status restrictions and authorization', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 9991, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@a.com' }
  );

  repliesInDB.push(
    { id: 8001, discussion_id: 9991, user_id: 99, body: 'Admin Reply', status: 'approved', created_at: new Date(), updated_at: new Date() },
    { id: 8002, discussion_id: 9991, user_id: 99, body: 'Nested Admin Reply', parent_id: 8001, status: 'visible', created_at: new Date(), updated_at: new Date() },
    { id: 8003, discussion_id: 9991, user_id: 10, body: 'Pending Reply', status: 'pending', created_at: new Date(), updated_at: new Date() },
    { id: 8004, discussion_id: 9991, user_id: 10, body: 'Hidden Reply', status: 'hidden', created_at: new Date(), updated_at: new Date() },
    { id: 8005, discussion_id: 9991, user_id: 10, body: 'Deleted Reply', status: 'deleted', created_at: new Date(), updated_at: new Date() }
  );

  // Normal user cannot accept
  let res = await http('/discussions/9991/accept/8001', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot accept');
  
  res = await http('/discussions/9991/unaccept/8001', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot unaccept');

  res = await http('/discussions/9991/unaccept', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot unaccept all');

  // Admin can accept approved
  res = await http('/discussions/9991/accept/8001', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
   assert.equal(res.status, 200); assert.match(await res.text(), /Answer accepted/);
  

  // Unaccept
  res = await http('/discussions/9991/unaccept/8001', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);

  // Admin can accept visible nested
  res = await http('/discussions/9991/accept/8002', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200);

  // Accept rejected for pending
  res = await http('/discussions/9991/accept/8003', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);

  // Accept rejected for hidden
  res = await http('/discussions/9991/accept/8004', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);

  // Accept rejected for deleted
  res = await http('/discussions/9991/accept/8005', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);
});
