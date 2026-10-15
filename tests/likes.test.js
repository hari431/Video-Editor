import './helpers/env.js';
process.env.HIDDEN_FOLDERS = 'Internal,Drafts';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { videoMimeType } from '../src/library/video.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const VIDEO_FIXTURE = 'Guidewire/Tutorials/Finding Rate table & Routine Usages.mp4';

const { app } = await import('../src/server.js');

const SID = 'likes-harness-session';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;

const USER_ROW = {
  id: 42,
  google_user_id: 'google-likes-1',
  email: 'likes@example.com',
  name: 'Likes Tester',
  status: 'active',
  app_role: 'ADMIN',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000)
};

const likedPaths = new Set();
let lastMyLikesUserId = null;

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 42 } }) }] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [USER_ROW] };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) {
      // Reuse Notes permission — user 42 has a role with notes_available = TRUE
      if (params[0] === 42) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT 1 FROM roles WHERE id = ANY/.test(sql)) {
      // Effective-role check via numeric role ids — not used in this harness
      return { rows: [], rowCount: 0 };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Videos', access_level: 'all', role_id: null },
          { folder_path: 'Guidewire', access_level: 'all', role_id: null },
          { folder_path: '__like_item_test', access_level: 'all', role_id: null }
        ]
      };
    }
    if (/item_likes/.test(sql) && /COUNT/.test(sql)) {
      return { rows: [{ cnt: String(likedPaths.has(params[0]) ? 1 : 0) }] };
    }
    if (/item_likes/.test(sql) && /SELECT id FROM item_likes/.test(sql)) {
      return { rows: likedPaths.has(params[0]) ? [{ id: 1 }] : [] };
    }
    if (/INSERT INTO item_likes/.test(sql)) {
      likedPaths.add(params[0]);
      return { rows: [] };
    }
    if (/DELETE FROM item_likes/.test(sql)) {
      likedPaths.delete(params[0]);
      return { rows: [] };
    }
    if (/content_action_permissions/.test(sql)) {
      // Notes permission reused for Likes — grant NOTES via content_action_permissions for user 42
      if (params[1] === 'NOTES' && Number(params[0]) === 42) {
        return { rows: [{ permission: 'NOTES' }], rowCount: 1 };
      }
      if (/SELECT permission FROM content_action_permissions WHERE user_id/.test(sql) && Number(params[0]) === 42) {
        // Direct grant check without permission param: include NOTES
        return { rows: [{ permission: 'COPY_QUERY' }, { permission: 'DOWNLOAD_PDF' }, { permission: 'NOTES' }], rowCount: 3 };
      }
      // Grant all content permissions to test user so PDF download gate does not block item/file routes
      return { rows: [{ permission: 'COPY_QUERY' }, { permission: 'DOWNLOAD_PDF' }], rowCount: 2 };
    }
    if (/content_permission_audit_log/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql) && /WHERE user_id/.test(sql)) {
      lastMyLikesUserId = params[0];
      return { rows: [...likedPaths].map(p => ({ item_path: p, created_at: new Date() })) };
    }
    return { rows: [] };
  };
  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) {
    pool.query = originalQuery;
    originalQuery = null;
  }
});

const enc = value => value.split('/').map(encodeURIComponent).join('/');

const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test('unauthenticated like API and my-likes page redirect to /login', async () => {
  const like = await http('/api/like/Videos/TestVideo.mp4', { method: 'POST', redirect: 'manual' });
  assert.equal(like.status, 302);
  assert.equal(like.headers.get('location'), '/login');
  const mine = await http('/my/likes', { redirect: 'manual' });
  assert.equal(mine.status, 302);
  assert.equal(mine.headers.get('location'), '/login');
});

test('my liked items page shows an empty state when nothing is liked', async () => {
  likedPaths.clear();
  const res = await http('/my/likes', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /You haven't liked anything yet/);
});

test('like API toggles like/unlike and returns the new count (video)', async () => {
  const p = VIDEO_FIXTURE;
  const first = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { liked: true, likeCount: 1 });

  const second = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { liked: false, likeCount: 0 });

  const third = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(third.status, 200);
  assert.deepEqual(await third.json(), { liked: true, likeCount: 1 });
});

test('legacy /video/:path/like alias still toggles the same like', async () => {
  const p = VIDEO_FIXTURE;
  const before = likedPaths.has(p);
  const res = await http(`/video/${enc(p)}/like`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.liked, !before);
  assert.equal(likedPaths.has(p), !before);
});

test('nested video paths with spaces and ampersands are accepted', async () => {
  const p = 'Guidewire/Tutorials/Finding Rate table & Routine Usages.mp4';
  const like = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(like.status, 200);
  assert.deepEqual(await like.json(), { liked: true, likeCount: 1 });
  const unlike = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.deepEqual(await unlike.json(), { liked: false, likeCount: 0 });
});

test('likes work for plain-text query files', async () => {
  const p = 'Premium/Policy Center/Rating/Partial worksheet print.txt';
  const res = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { liked: true, likeCount: 1 });
});

test('traversal and missing paths are rejected', async () => {
  const traversal = await http('/api/like/..%2F..%2FWindows%2Fwin.ini', {
    method: 'POST',
    headers: { Cookie: COOKIE }
  });
  assert.equal(traversal.status, 400, 'traversal is rejected before tallying any like');

  const missing = await http('/api/like/Guidewire%2FTutorials%2Fdoes-not-exist.mp4', {
    method: 'POST',
    headers: { Cookie: COOKIE }
  });
  assert.equal(missing.status, 404);
});

test('restricted folders (HIDDEN_FOLDERS) cannot be liked', async () => {
  const res = await http('/api/like/Internal%2Fsecret.txt', {
    method: 'POST',
    headers: { Cookie: COOKIE }
  });
  assert.equal(res.status, 404);
});

test('pdf files support likes, the item page, and raw file serving', async () => {
  const base = path.join(QUERIES_DIR, '__like_item_test');
  await mkdir(base, { recursive: true });
  const bytes = randomBytes(256);
  await writeFile(path.join(base, 'note.pdf'), bytes);
  try {
    const p = '__like_item_test/note.pdf';

    const like = await http(`/api/like/${enc(p)}`, { method: 'POST', headers: { Cookie: COOKIE } });
    assert.equal(like.status, 200);
    assert.deepEqual(await like.json(), { liked: true, likeCount: 1 });

    const item = await http(`/item/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(item.status, 200);
    const itemHtml = await item.text();
    assert.match(itemHtml, /note/, 'item page shows the file name');
    assert.match(itemHtml, /like-btn/, 'item page embeds the common like control');
    assert.match(itemHtml, /\/download\/__like_item_test\/note\.pdf/, 'download/open link points at the download route');
    assert.match(itemHtml, /<iframe/, 'viewable files get an inline preview');
    assert.match(itemHtml, /\/file\/__like_item_test\/note\.pdf/, 'preview iframe points at the file route');

    const file = await http(`/file/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes), 'file preview bytes are served');
    const dl = await http(`/download/${enc(p)}`, { headers: { Cookie: COOKIE } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(dl.headers.get('content-disposition') || '', /attachment/);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(bytes), 'download bytes are served');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('my liked items lists only the current user accessible likes', async () => {
  likedPaths.add('Internal/drafts-secret.txt');
  likedPaths.add(VIDEO_FIXTURE);
  const res = await http('/my/likes', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(lastMyLikesUserId, 42, 'the likes query is scoped to the authenticated user');
  const html = await res.text();
  assert.match(html, /Finding Rate table &amp; Routine Usages/, 'liked video appears on the page');
  assert.match(html, /Partial worksheet print/, 'liked query file appears on the page');
  assert.doesNotMatch(html, /drafts-secret/, 'likes on restricted paths are never exposed');
  likedPaths.delete('Internal/drafts-secret.txt');
});

test('item page renders a download link (no iframe) for non-viewable types', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'item.ejs'), {
    user: { name: 'Tester', access_expires_at: new Date() },
    itemPath: 'docs/notes.docx',
    fileName: 'notes.docx',
    sizeText: '12 KB',
    typeLabel: 'Document',
    viewable: false,
    canRenderInBrowser: false,
    likeCount: 2,
    liked: true,
    hasNotes: true,
    displayName: n => n,
    prettyTitle: n => n.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'docs',
    fileHref: '/file/docs/notes.docx',
    discussions: []
  });
  assert.match(html, /Open \/ Download/);
  assert.match(html, /like-btn/);
  assert.doesNotMatch(html, /<iframe/, 'non-viewable types are not embedded inline');
});

test('like control markup keeps the button separate from the count span', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: n => n.replace(/\.txt$/i, ''),
    prettyTitle: n => n.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 3,
    likeCount: 5,
    userLiked: false,
    hasNotes: true
  });
  assert.match(html, /<span class="like-count">5<\/span>/, 'count lives in its own element');
  assert.match(
    html,
    /♥ <span class="like-count">5<\/span> Likes<\/span>\s*<button class="like-btn"/,
    'count and button are siblings inside the like control'
  );
  assert.match(
    html,
    /<button class="like-btn" data-path="Videos\/TestVideo\.mp4">Like<\/button>/,
    'a real button element is rendered for the Like action'
  );
  assert.match(html, /<a class="nav-link" href="\/my\/likes">/, 'nav to My Liked Items is present');
  assert.match(html, /src="\/like\.js"/, 'the page loads the shared like control');
});

test('shared like.js updates only the count and never the button container', async () => {
  const code = await readFile(new URL('../src/public/like.js', import.meta.url), 'utf8');
  assert.match(code, /querySelector\('\.like-count'\)/, 'like.js targets the dedicated count element');
  assert.doesNotMatch(code, /parentElement/, 'like.js never overwrites the button container');
  assert.match(code, /\/api\/like\//, 'like.js posts to the common like API');
});