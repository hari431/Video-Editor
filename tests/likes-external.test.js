import './helpers/env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '..', 'queries');
const FIXTURE_DIR = path.join(QUERIES_DIR, '__like_external_test');
const EXTERNAL_NAME = 'External - PC ACE Palisades Questions Review - Part1.txt';
const EXTERNAL_PATH = `__like_external_test/${EXTERNAL_NAME}`;

const { app, _clearLibraryCache } = await import('../src/server.js');
const { invalidatePermissionCache } = await import('../src/library/local.js');

const SID = 'likes-external-harness-session';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;

const USER_ROW = {
  id: 43,
  google_user_id: 'google-likes-external-1',
  email: 'likes-external@example.com',
  name: 'Likes External Tester',
  status: 'active',
  app_role: 'ADMIN',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000)
};

const likedPaths = new Set();
let originalQuery = null;
let originalConnect = null;
let server = null;
let port = 0;

const enc = value => value.split('/').map(encodeURIComponent).join('/');
const http = (suffix, init) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

test.before(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(path.join(FIXTURE_DIR, EXTERNAL_NAME), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n');
  _clearLibraryCache();
  invalidatePermissionCache();

  originalQuery = pool.query;
  originalConnect = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 43 } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [USER_ROW] };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) {
      if (params[0] === 43) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT 1 FROM roles WHERE id = ANY/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Videos', access_level: 'all', role_id: null },
          { folder_path: 'Guidewire', access_level: 'all', role_id: null },
          { folder_path: '__like_external_test', access_level: 'all', role_id: null }
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
      if (params[1] === 'NOTES' && Number(params[0]) === 43) {
        return { rows: [{ permission: 'NOTES' }], rowCount: 1 };
      }
      return { rows: [{ permission: 'COPY_QUERY' }, { permission: 'DOWNLOAD_PDF' }, { permission: 'NOTES' }], rowCount: 3 };
    }
    if (/content_permission_audit_log/.test(sql)) return { rows: [] };
    if (/FROM item_likes/.test(sql) && /WHERE user_id/.test(sql)) {
      return { rows: [...likedPaths].map(p => ({ item_path: p, created_at: new Date() })) };
    }
    return { rows: [] };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });

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
  if (originalConnect) {
    pool.connect = originalConnect;
    originalConnect = null;
  }
  _clearLibraryCache();
  invalidatePermissionCache();
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

test('liked External item links to /external/ (not /item/)', async () => {
  likedPaths.clear();
  _clearLibraryCache();
  invalidatePermissionCache();
  likedPaths.add(EXTERNAL_PATH);

  const res = await http('/my/likes', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  const expectedHref = `/external/${enc(EXTERNAL_PATH)}`;
  assert.match(html, new RegExp(expectedHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'liked External item uses /external/ route');
  assert.doesNotMatch(html, new RegExp(`/item/${enc(EXTERNAL_PATH)}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'liked External item must not fall back to /item/');
  assert.match(html, /External/, 'liked External item is labelled External');
});

test('liked video/text items keep their existing routes', async () => {
  likedPaths.clear();
  const videoName = 'Sample Clip.mp4';
  const textName = 'Sample Note.txt';
  await writeFile(path.join(FIXTURE_DIR, videoName), 'fake-video-bytes');
  await writeFile(path.join(FIXTURE_DIR, textName), 'sample text content');
  _clearLibraryCache();
  invalidatePermissionCache();
  const videoPath = `__like_external_test/${videoName}`;
  const textPath = `__like_external_test/${textName}`;
  likedPaths.add(videoPath);
  likedPaths.add(textPath);

  const res = await http('/my/likes', { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(
    html,
    new RegExp(`/watch/${enc(videoPath)}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'liked video still uses /watch/'
  );
  assert.match(
    html,
    new RegExp(`/query/${enc(textPath)}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'liked text still uses /query/'
  );
});
