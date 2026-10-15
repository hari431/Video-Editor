import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  generateShareCode,
  isValidShareCode,
  findShareTarget,
  getOrCreateShareCode,
} from '../src/library/share-links.js';

const CODE_RE = /^[A-Za-z0-9_-]{12}$/;

// ---------- Pure unit tests (no DB) ----------

test('share-links: generated codes are short, opaque and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generateShareCode();
    assert.match(code, CODE_RE, '12 URL-safe chars');
    assert.ok(!seen.has(code), 'no duplicates in 200 draws');
    seen.add(code);
  }
  const sample = generateShareCode();
  assert.ok(!sample.includes('Guidewire') && !sample.includes('.txt'), 'code carries no path material');
});

test('share-links: code format validation', () => {
  assert.equal(isValidShareCode('Ab3_xY9-qWe2'), true);
  assert.equal(isValidShareCode('  Ab3_xY9-qWe2  '), true);
  assert.equal(isValidShareCode('short'), false);
  assert.equal(isValidShareCode('has space in it'), false);
  assert.equal(isValidShareCode('../../etc/passwd'), false);
  assert.equal(isValidShareCode(''), false);
  assert.equal(isValidShareCode(null), false);
  assert.equal(isValidShareCode('x'.repeat(65)), false);
});

// ---------- Module tests with mocked pool (in-memory table) ----------

function mockSharePool(store) {
  const originalQuery = pool.query;
  let collideOnce = false;
  pool.query = async (sql, params = []) => {
    if (/FROM share_links WHERE file_path =/.test(sql) && /^SELECT/i.test(sql.trim())) {
      const code = store.get(params[0]);
      return code ? { rows: [{ share_code: code }] } : { rows: [] };
    }
    if (/FROM share_links WHERE share_code =/.test(sql)) {
      for (const [fp, c] of store.entries()) {
        if (c === params[0]) return { rows: [{ file_path: fp }] };
      }
      return { rows: [] };
    }
    if (/INSERT INTO share_links/.test(sql)) {
      const [fp, code] = params;
      if (collideOnce) {
        collideOnce = false;
        const err = new Error('duplicate key value violates unique constraint "share_links_share_code_key"');
        err.code = '23505';
        throw err;
      }
      if ([...store.values()].includes(code)) {
        const err = new Error('duplicate key value violates unique constraint "share_links_share_code_key"');
        err.code = '23505';
        throw err;
      }
      if (store.has(fp)) return { rows: [] }; // ON CONFLICT (file_path) DO NOTHING
      store.set(fp, code);
      return { rows: [{ share_code: code }] };
    }
    return { rows: [] };
  };
  return {
    restore() { pool.query = originalQuery; },
    failNextInsertWithCollision() { collideOnce = true; },
  };
}

test('share-links: same path reuses its code, paths differ', async () => {
  const store = new Map();
  const mock = mockSharePool(store);
  try {
    const a1 = await getOrCreateShareCode('A/Note.txt', 7);
    const a2 = await getOrCreateShareCode('A/Note.txt', 7);
    assert.equal(a1, a2, 'stable code per exact path');
    const b = await getOrCreateShareCode('B/Note.txt', 7);
    assert.notEqual(a1, b, 'same filename elsewhere gets its own code');
    assert.equal(await findShareTarget(a1), 'A/Note.txt');
    assert.equal(await findShareTarget('zzzzzzzzzzzz'), null, 'unknown code');
    assert.equal(await findShareTarget('!!!'), null, 'malformed code without DB drama');
  } finally {
    mock.restore();
  }
});

test('share-links: code collision regenerates transparently', async () => {
  const store = new Map();
  const mock = mockSharePool(store);
  try {
    mock.failNextInsertWithCollision();
    const code = await getOrCreateShareCode('C/Note.txt', 7);
    assert.match(code, CODE_RE);
    assert.equal(await findShareTarget(code), 'C/Note.txt');
  } finally {
    mock.restore();
  }
});

test('share-links: malformed lookup never touches the database', async () => {
  const originalQuery = pool.query;
  pool.query = async () => { throw new Error('must not be called'); };
  try {
    assert.equal(await findShareTarget('not a code!!'), null);
  } finally {
    pool.query = originalQuery;
  }
});

// ---------- Migration artifact tests ----------

test('share-links: migration creates the table with both uniqueness constraints', async () => {
  const sql = await readFile(fileURLToPath(new URL('../migrations/043_share_links.sql', import.meta.url)), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS share_links/, 'table defined');
  assert.match(sql, /file_path TEXT PRIMARY KEY/, 'file_path unique via PK (one code per exact path)');
  assert.match(sql, /share_code TEXT NOT NULL UNIQUE/, 'share_code unique');
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i, 'migration is additive-only');
  const migrateSrc = await readFile(fileURLToPath(new URL('../scripts/migrate.js', import.meta.url)), 'utf8');
  assert.match(migrateSrc, /043_share_links\.sql/, 'migration registered for baselining');
});

// ---------- Route tests (mocked pool, temp fixtures) ----------

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const { app, _clearLibraryCache } = await import('../src/server.js');

const SECRET = process.env.SESSION_SECRET;
const enc = v => v.split('/').map(encodeURIComponent).join('/');

const USER = { id: 401, google_user_id: 'google-401', email: 'share-user@example.com', name: 'ShareUser', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const USERS = { 401: USER };
const cookieFor = id => `connect.sid=s:${cookieSignature.sign(`share-${id}`, SECRET)}`;

const shareStore = new Map();
let server, port, originalQuery;

test.before(async () => {
  const base = path.join(QUERIES_DIR, '__share_test');
  const noaccess = path.join(QUERIES_DIR, '__share_noaccess');
  await mkdir(path.join(base, 'Sub Dir'), { recursive: true });
  await mkdir(noaccess, { recursive: true });
  await writeFile(path.join(base, 'Sub Dir', 'Note.txt'), 'shareable notes');
  await writeFile(path.join(base, 'Doc.pdf'), randomBytes(128));
  await writeFile(path.join(base, 'Doc_1.txt'), 'Pinned: x | https://example.com/x\n');
  await writeFile(path.join(base, 'External - Link.txt'), 'https://example.com/hello');
  await writeFile(path.join(base, 'clip.mp4'), randomBytes(64));
  await writeFile(path.join(noaccess, 'Secret.txt'), 'restricted');

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const m = String(params[0]).match(/share-(\d+)/);
      const uid = m ? Number(m[1]) : null;
      if (uid && USERS[uid]) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: uid } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) return { rows: [USERS[Number(params[0])] || USER] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return { rows: [{ folder_path: '__share_test', access_level: 'all', role_id: null }] };
    }
    if (/content_action_permissions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/video_views/.test(sql) && /COUNT/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/item_likes/.test(sql) && /COUNT/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/FROM share_links WHERE file_path =/.test(sql) && /^SELECT/i.test(sql.trim())) {
      const code = shareStore.get(params[0]);
      return code ? { rows: [{ share_code: code }] } : { rows: [] };
    }
    if (/FROM share_links WHERE share_code =/.test(sql)) {
      for (const [fp, c] of shareStore.entries()) {
        if (c === params[0]) return { rows: [{ file_path: fp }] };
      }
      return { rows: [] };
    }
    if (/INSERT INTO share_links/.test(sql)) {
      const [fp, code] = params;
      if ([...shareStore.values()].includes(code)) {
        const err = new Error('duplicate key value violates unique constraint "share_links_share_code_key"');
        err.code = '23505';
        throw err;
      }
      if (shareStore.has(fp)) return { rows: [] };
      shareStore.set(fp, code);
      return { rows: [{ share_code: code }] };
    }
    if (/item_likes/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  await rm(path.join(QUERIES_DIR, '__share_test'), { recursive: true, force: true });
  await rm(path.join(QUERIES_DIR, '__share_noaccess'), { recursive: true, force: true });
});

const http = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, opts);
const postShare = (itemPath, id) => http('/api/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(id ? { Cookie: cookieFor(id) } : {}) },
  body: JSON.stringify({ itemPath })
});

test('share-links: unauthenticated generation is rejected', async () => {
  const res = await postShare('__share_test/Sub Dir/Note.txt', null);
  assert.equal(res.status, 401);
});

test('share-links: invalid paths are rejected', async () => {
  for (const bad of ['', '../outside.txt', '  ']) {
    const res = await postShare(bad, 401);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('share-links: normal user generates then reuses a stable code', async () => {
  const first = await postShare('__share_test/Sub Dir/Note.txt', 401);
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.ok, true);
  assert.match(a.code, CODE_RE);
  assert.equal(a.urlPath, `/s/${a.code}`);
  const second = await postShare('__share_test/Sub Dir/Note.txt', 401);
  assert.deepEqual(await second.json(), a, 'same file returns the same code');
});

test('share-links: companion _1.txt files never get share links', async () => {
  const res = await postShare('__share_test/Doc_1.txt', 401);
  assert.equal(res.status, 404);
});

test('share-links: inaccessible and missing items are rejected', async () => {
  const denied = await postShare('__share_noaccess/Secret.txt', 401);
  assert.equal(denied.status, 404, 'no folder access → 404');
  const missing = await postShare('__share_test/Nope.txt', 401);
  assert.equal(missing.status, 404, 'missing file → 404');
});

test('share-links: short URL redirects to the canonical route', async () => {
  const made = await (await postShare('__share_test/Doc.pdf', 401)).json();
  const res = await http(made.urlPath, { headers: { Cookie: cookieFor(401) }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/item/${enc('__share_test/Doc.pdf')}`);
});

test('share-links: unknown and malformed codes 404', async () => {
  const unknown = await http('/s/zzzzzzzzzzzz', { headers: { Cookie: cookieFor(401) }, redirect: 'manual' });
  assert.equal(unknown.status, 404);
  const malformed = await http('/s/not-a-code!!', { headers: { Cookie: cookieFor(401) }, redirect: 'manual' });
  assert.equal(malformed.status, 404);
});

test('share-links: anonymous short URLs go to login; link grants nothing itself', async () => {
  const made = await (await postShare('__share_test/Sub Dir/Note.txt', 401)).json();
  const anon = await http(made.urlPath, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/login');
  // A user without folder access still only gets a redirect; the target denies.
  const target = await http(`/query/${enc('__share_test/Sub Dir/Note.txt')}`, { redirect: 'manual' });
  assert.equal(target.status, 302, 'anonymous cannot open the target either');
});

test('share-links: link grants nothing — deleted file resolves then denies', async () => {
  const tmpPath = path.join(QUERIES_DIR, '__share_test', 'Temp.txt');
  await writeFile(tmpPath, 'temporary');
  _clearLibraryCache();
  const made = await (await postShare('__share_test/Temp.txt', 401)).json();
  assert.match(made.code, CODE_RE);
  await rm(tmpPath, { force: true });
  _clearLibraryCache();
  const res = await http(made.urlPath, { headers: { Cookie: cookieFor(401) }, redirect: 'manual' });
  assert.equal(res.status, 302, 'short URL still resolves to the canonical route');
  assert.equal(res.headers.get('location'), `/query/${enc('__share_test/Temp.txt')}`);
  const target = await http(`/query/${enc('__share_test/Temp.txt')}`, { headers: { Cookie: cookieFor(401) }, redirect: 'manual' });
  assert.equal(target.status, 404, 'target route denies the missing file');
});

test('share-links: Share button renders on every content page for normal users', async () => {
  const pages = [
    `/query/${enc('__share_test/Sub Dir/Note.txt')}`,
    `/external/${enc('__share_test/External - Link.txt')}`,
    `/item/${enc('__share_test/Doc.pdf')}`,
    `/watch/${enc('__share_test/clip.mp4')}`,
  ];
  const expectedPaths = [
    '__share_test/Sub Dir/Note.txt',
    '__share_test/External - Link.txt',
    '__share_test/Doc.pdf',
    '__share_test/clip.mp4',
  ];
  for (let i = 0; i < pages.length; i++) {
    const res = await http(pages[i], { headers: { Cookie: cookieFor(401) } });
    assert.equal(res.status, 200, pages[i]);
    const html = await res.text();
    assert.match(html, /data-testid="share-button"/, `share button on ${pages[i]}`);
    assert.ok(html.includes(`data-path="${expectedPaths[i]}"`), `exact item path on ${pages[i]}`);
  }
});

test('share-links: Share button shows upload icon plus Share text', async () => {
  const res = await http(`/query/${enc('__share_test/Sub Dir/Note.txt')}`, { headers: { Cookie: cookieFor(401) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  const button = html.match(/<button[^>]*data-testid="share-button"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(button, /<svg[^>]*viewBox="0 0 24 24"[^>]*>/, 'inline upload icon present');
  assert.match(button, /M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4/, 'tray shape present');
  assert.match(button, /polyline points="17 8 12 3 7 8"/, 'upward arrow present');
  assert.match(button, /data-testid="share-button-label">Share</, 'Share text kept in label span');
  const partialSrc = await readFile(fileURLToPath(new URL('../src/views/partials/share-button.ejs', import.meta.url)), 'utf8');
  assert.match(partialSrc, /querySelector\('\[data-testid="share-button-label"\]'\)/, 'status text targets the label span, icon untouched');
});
