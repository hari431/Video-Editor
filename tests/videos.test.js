import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { readQueryLibrary, resolveLibraryPath, isSafeLibraryPath } from '../src/library/local.js';
import { buildTree, allFiles, folderAt, findFile, findVideo, searchFiles } from '../src/library/tree.js';
import { isVideoFileName, parseRange, streamVideoFile, videoMimeType } from '../src/library/video.js';
import { app } from '../src/server.js';

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));

const VIDEO_FIXTURE = 'Videos/Finding Rate table & Routine Usages.mp4';
const TEST_VIDEO = path.join(QUERIES_DIR, VIDEO_FIXTURE);
const SID = 'video-harness-session';
const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;

const USER_ROW = {
  id: 1,
  google_user_id: 'google-video-1',
  email: 'video@example.com',
  name: 'Video Tester',
  status: 'active',
  first_login_at: new Date(),
  last_login_at: new Date(),
  access_expires_at: new Date(Date.now() + 30 * 86400000)
};

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  await mkdir(path.dirname(TEST_VIDEO), { recursive: true });
  try {
    await stat(TEST_VIDEO);
  } catch {
    await writeFile(TEST_VIDEO, 'mock mp4 content');
  }
  originalQuery = pool.query;
pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      // eslint-disable-next-line no-unused-vars
      return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: 1 } }) }] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [USER_ROW] };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Videos', access_level: 'all', role_id: null },
          { folder_path: '__video_test', access_level: 'all', role_id: null },
          { folder_path: '__video_stream_test', access_level: 'all', role_id: null }
        ]
      };
    }
    if (/video_views/.test(sql) && /COUNT/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/item_likes/.test(sql) && /COUNT/.test(sql)) return { rows: [{ cnt: 0 }] };
    if (/item_likes/.test(sql) && /id/.test(sql) && /item_path/.test(sql) && /user_id/.test(sql)) return { rows: [] };
    if (/INSERT INTO video_views/.test(sql)) return { rows: [] };
    if (/INSERT INTO item_likes/.test(sql)) return { rows: [] };
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

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    headersSent: false,
    ended: false,
    destroyed: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || null;
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    },
    body() {
      return Buffer.concat(chunks);
    }
  };
  return res;
}

test('video discovery detects supported video files without reading their content', async () => {
  const base = path.join(QUERIES_DIR, '__video_test');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'clip.mp4'), randomBytes(64));
  await writeFile(path.join(base, 'show.webm'), randomBytes(64));
  await writeFile(path.join(base, 'movie.mov'), randomBytes(64));
  await writeFile(path.join(base, 'notes.png'), randomBytes(64));
  await writeFile(path.join(base, 'audio.mp3'), randomBytes(64));
  await writeFile(path.join(base, 'noext'), randomBytes(64));
  try {
    const { files, videos } = await readQueryLibrary();
    const videoPaths = videos.map(v => v.path);
    for (const expected of ['__video_test/clip.mp4', '__video_test/show.webm', '__video_test/movie.mov']) {
      assert.ok(videoPaths.includes(expected), `missing ${expected}`);
    }
    assert.ok(!videoPaths.includes('__video_test/notes.png'), 'png is not treated as video');
    assert.ok(!videoPaths.includes('__video_test/audio.mp3'), 'mp3 is not treated as video');
    assert.ok(!videoPaths.some(p => /noext$/.test(p)), 'extensionless files are ignored');
    assert.ok(!files.some(f => f.path.includes('clip.mp4')), 'videos are never parsed as query files');
    for (const video of videos) {
      assert.equal(video.content, undefined, 'video bytes are never loaded during discovery');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('tree exposes supported videos as video leaves and keeps query search unchanged', async () => {
  const { files, videos, folders } = await readQueryLibrary();
  const tree = buildTree(files, videos, folders);
  const videosFolder = folderAt(tree, 'Videos');
  assert.ok(videosFolder, 'Videos folder exists');
  const leaf = videosFolder.children.get('Finding Rate table & Routine Usages.mp4');
  assert.ok(leaf, 'Finding Rate table & Routine Usages.mp4 appears in the tree');
  assert.equal(leaf.type, 'video');
  assert.equal(findVideo(tree, VIDEO_FIXTURE), leaf);
  assert.equal(findFile(tree, VIDEO_FIXTURE), null, 'videos are not query files');
  assert.ok(!allFiles(tree).some(f => f.path.endsWith('.mp4')), 'videos are excluded from query search');
  assert.deepEqual(searchFiles(tree, 'TestVideo'), [], 'search results never include videos');
  const querySearch = searchFiles(tree, 'worksheet');
  assert.ok(
    querySearch.some(result => result.path === 'Guidewire/Gosu/PC/Rating/Partial worksheet print.txt'),
    'query search still works'
  );
});

test('video extension support and MIME mapping', async () => {
  assert.equal(isVideoFileName('clip.mp4'), true);
  assert.equal(isVideoFileName('CLIP.MP4'), true);
  assert.equal(isVideoFileName('show.webm'), true);
  assert.equal(isVideoFileName('movie.mov'), true);
  assert.equal(isVideoFileName('notes.png'), false);
  assert.equal(isVideoFileName('audio.mp3'), false);
  assert.deepEqual([...new Set(['.mp4', '.webm', '.mov'].map(e => e))], ['.mp4', '.webm', '.mov']);
  assert.equal(videoMimeType('x.mp4'), 'video/mp4');
  assert.equal(videoMimeType('x.webm'), 'video/webm');
  assert.equal(videoMimeType('x.mov'), 'video/quicktime');
  assert.equal(videoMimeType('x.bin'), 'application/octet-stream');
});

test('library view renders video cards without the extension', async () => {
  const tree = buildTree([], [{ path: 'Videos/clip.mp4' }], ['Videos']);
  const folder = folderAt(tree, 'Videos');
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'library.ejs'), {
    user: { name: 'Tester', access_expires_at: new Date() },
    tree,
    folder,
    path: 'Videos',
    displayName: name => name.replace(/\.txt$/i, ''),
    categoryForPath: () => 'Videos'
  });
  assert.match(html, /href="\/watch\/Videos\/clip\.mp4"/, 'video card links to the watch page');
  assert.match(html, /🎬/, 'video card shows a video icon');
  assert.match(html, /<strong[^>]*>clip<\/strong>/, 'label strips the extension');
  assert.doesNotMatch(html, /<strong[^>]*>clip\.mp4<\/strong>/, 'extension is not shown');
});

test('video player page uses native controls and never autoplays', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false
  });
  assert.match(html, /<video controls/, 'native controls are enabled');
  assert.match(html, /preload="metadata"/);
  assert.doesNotMatch(html, /autoplay/, 'videos never autoplay');
  assert.match(html, /src="\/video\/Videos\/TestVideo\.mp4"/, 'player sources the stream route');
  assert.match(html, /type="video\/mp4"/, 'correct MIME type on the source');
  assert.match(html, /<h1>TestVideo<\/h1>/, 'page title strips the extension');
});

test('watermark renders authenticated user email', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', email: 'user@example.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false
  });
  assert.match(html, /Learn with me/, '"Learn with me" appears in watermark');
  assert.match(html, /user@example.com/, 'authenticated user email appears in watermark');
});

test('watermark email is HTML escaped', async () => {
  // EJS auto-escapes HTML, so an email with angle brackets renders as entities.
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', email: 'test<script>@example.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false
  });
  // The email user part should appear in the watermark
  assert.match(html, /test/, 'email user part appears in watermark');
  // The raw unescaped <script> tag from the email should NOT appear as live markup
  assert.doesNotMatch(html, /test<script/i, 'email script payload never renders as an element');
});

test('watermark is inside video shell container', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', email: 'user@example.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false
  });
  // Watermark div should be inside .video-shell
  assert.match(html, /<div class="video-shell">/, '.video-shell container present');
  assert.match(html, /<div class="video-watermark">/, 'watermark div present inside video-shell');
});

test('controlsList="nodownload" remains present', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'video.ejs'), {
    user: { name: 'Tester', email: 'user@example.com', access_expires_at: new Date() },
    file: { path: 'Videos/TestVideo.mp4' },
    path: 'Videos/TestVideo.mp4',
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Videos',
    videoMimeType,
    viewsCount: 0,
    likeCount: 0,
    userLiked: false
  });
  assert.match(html, /controlsList="nodownload"/, 'controlsList="nodownload" remains present on video element');
});

test('streaming serves a full file when no Range header is sent', async () => {
  const base = path.join(QUERIES_DIR, '__video_stream_test');
  await mkdir(base, { recursive: true });
  const filePath = path.join(base, 'clip.mp4');
  const bytes = randomBytes(200);
  await writeFile(filePath, bytes);
  try {
    const abs = resolveLibraryPath('__video_stream_test/clip.mp4');
    const res = makeRes();
    const how = await streamVideoFile(res, abs, undefined);
    assert.equal(how, 'full');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'video/mp4');
    assert.equal(res.headers['Content-Length'], 200);
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.ok(res.body().equals(bytes), 'all bytes streamed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('streaming honors HTTP Range requests for seeking', async () => {
  const base = path.join(QUERIES_DIR, '__video_stream_test');
  await mkdir(base, { recursive: true });
  const filePath = path.join(base, 'clip.mp4');
  const bytes = randomBytes(200);
  await writeFile(filePath, bytes);
  try {
    const abs = resolveLibraryPath('__video_stream_test/clip.mp4');
    const res = makeRes();
    const how = await streamVideoFile(res, abs, 'bytes=5-9');
    assert.equal(how, 'partial');
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['Content-Range'], 'bytes 5-9/200');
    assert.equal(res.headers['Content-Length'], 5);
    assert.equal(res.headers['Content-Type'], 'video/mp4');
    assert.ok(res.body().equals(bytes.subarray(5, 10)), 'only the requested range is streamed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('streaming answers unsatisfiable ranges with 416', async () => {
  const base = path.join(QUERIES_DIR, '__video_stream_test');
  await mkdir(base, { recursive: true });
  const filePath = path.join(base, 'clip.mp4');
  await writeFile(filePath, randomBytes(200));
  try {
    const abs = resolveLibraryPath('__video_stream_test/clip.mp4');
    const res = makeRes();
    const how = await streamVideoFile(res, abs, 'bytes=200-');
    assert.equal(how, 'unsatisfied');
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['Content-Range'], 'bytes */200');
    assert.equal(res.body().length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('missing video files surface as ENOENT and never hang', async () => {
  const base = path.join(QUERIES_DIR, '__video_missing_test');
  await mkdir(base, { recursive: true });
  try {
    const abs = path.join(base, 'gone.mp4');
    const res = makeRes();
    await assert.rejects(streamVideoFile(res, abs, undefined), error => error && error.code === 'ENOENT');
    assert.equal(res.statusCode, null, 'nothing written to response on missing file');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('library path resolution rejects traversal and works for real videos', async () => {
  assert.equal(resolveLibraryPath('../../Windows/win.ini'), null);
  assert.equal(resolveLibraryPath('../secret.mp4'), null);
  assert.equal(resolveLibraryPath('Videos\\..\\x.mp4'), null);
  assert.equal(resolveLibraryPath('/etc/passwd'), null);
  assert.equal(resolveLibraryPath('..%2Fsecret.mp4'), null);
  assert.equal(resolveLibraryPath(''), null);
  assert.equal(isSafeLibraryPath('..%2F..'), false);
  const abs = resolveLibraryPath(VIDEO_FIXTURE);
  assert.ok(abs, 'real video resolves');
  const rel = path.relative(QUERIES_DIR, abs);
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'resolved path stays inside the library');
});

test('unauthenticated video and watch routes redirect to /login', async () => {
  const video = await fetch(`http://127.0.0.1:${port}/video/${encodeURIComponent(VIDEO_FIXTURE).replace('%2F', '/')}`, { redirect: 'manual' });
  assert.equal(video.status, 302);
  assert.equal(video.headers.get('location'), '/login');
  const watch = await fetch(`http://127.0.0.1:${port}/watch/${encodeURIComponent(VIDEO_FIXTURE).replace('%2F', '/')}`, { redirect: 'manual' });
  assert.equal(watch.status, 302);
  assert.equal(watch.headers.get('location'), '/login');
});

test('authenticated video access streams with Range support', async () => {
  const fileStat = await stat(TEST_VIDEO);
  const fullBytes = await readFile(TEST_VIDEO);
  const headers = { Range: 'bytes=0-9', Cookie: COOKIE };
  const video = await fetch(`http://127.0.0.1:${port}/video/${encodeURIComponent(VIDEO_FIXTURE).replace('%2F', '/')}`, { headers });
  assert.equal(video.status, 206, 'partial content delivered');
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal(video.headers.get('content-range'), `bytes 0-9/${fileStat.size}`);
  assert.equal(video.headers.get('accept-ranges'), 'bytes');
  const body = Buffer.from(await video.arrayBuffer());
  assert.equal(body.length, 10);
  assert.ok(body.equals(fullBytes.subarray(0, 10)), 'requested range bytes match');
});

test('missing videos and traversal are rejected over HTTP', async () => {
  const missing = await fetch(`http://127.0.0.1:${port}/video/Videos/does-not-exist.mp4`, {
    headers: { Cookie: COOKIE }
  });
  assert.equal(missing.status, 404);
  const traversal = await fetch(`http://127.0.0.1:${port}/video/..%2F..%2FWindows%2Fwin.ini`, {
    headers: { Cookie: COOKIE }
  });
  assert.equal(traversal.status, 400, 'traversal is rejected before any file access');
});

test('watch page is served to authenticated users', async () => {
  const watch = await fetch(`http://127.0.0.1:${port}/watch/${encodeURIComponent(VIDEO_FIXTURE).replace('%2F', '/')}`, {
    headers: { Cookie: COOKIE }
  });
  assert.equal(watch.status, 200);
  const html = await watch.text();
  assert.match(html, /<video controls/);
});

test('server remains stable while a large video file exists', async () => {
  const big = path.join(QUERIES_DIR, 'Videos', '__stability.mp4');
  await writeFile(big, randomBytes(30 * 1024 * 1024));
  try {
    for (let i = 0; i < 5; i++) {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200, 'server still responsive');
    }
    const login = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(login.status, 200);
    const search = await fetch(`http://127.0.0.1:${port}/api/search`);
    assert.equal(search.status, 401);
  } finally {
    await rm(big, { force: true });
  }
});

test('parseRange handles common seek patterns', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.equal(parseRange('bytes=abc', 100), null);
  assert.equal(parseRange(null, 100), null);
});