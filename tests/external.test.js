import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { isExternalFileName, getExternalFriendlyName, isValidExternalUrl, extractYouTubeId, isBloggerUrl, extractDriveFileId, isDriveUrl, contentRouteForPath, readQueryLibrary } from '../src/library/local.js';
import { findExternal, findVideo, findFile, buildTree } from '../src/library/tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '..', 'queries');

test('External - filename detection – case-insensitive (Windows-safe)', () => {
  assert.equal(isExternalFileName('External - Foo.txt'), true);
  assert.equal(isExternalFileName('external - Foo.txt'), true);
  assert.equal(isExternalFileName('EXTERNAL - Foo.txt'), true);
  assert.equal(isExternalFileName(' External - Foo.txt'), true);
  assert.equal(isExternalFileName('Foo.txt'), false);
  assert.equal(isExternalFileName('External -Foo.txt'), false); // missing space after dash – should be false for strict "External - "
  assert.equal(isExternalFileName('External: Foo.txt'), false); // old convention removed
  assert.equal(isExternalFileName('ExternalFoo.txt'), false);
  assert.equal(isExternalFileName(''), false);
  assert.equal(isExternalFileName(null), false);
});

test('friendly-name extraction', () => {
  assert.equal(getExternalFriendlyName('External - Guidewire Rating Tutorial.txt'), 'Guidewire Rating Tutorial');
  assert.equal(getExternalFriendlyName('external - Guidewire Rating Tutorial.txt'), 'Guidewire Rating Tutorial');
  assert.equal(getExternalFriendlyName('EXTERNAL -   My Video  .txt'), 'My Video');
  assert.equal(getExternalFriendlyName('External - Foo'), 'Foo');
  assert.equal(getExternalFriendlyName('External -   .txt'), 'External Resource');
  assert.equal(getExternalFriendlyName('External - <b>Bold</b>.txt'), '<b>Bold</b>');
});

test('URL extraction – trim whitespace', async () => {
  const raw = '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  \n';
  assert.equal(isValidExternalUrl(raw.trim()), true);
  assert.equal(raw.trim(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('YouTube watch URL – extract ID', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&ab_channel=test'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('YouTube short URL – youtu.be', () => {
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ/'), 'dQw4w9WgXcQ');
});

test('YouTube embed/shorts formats', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/v/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('invalid URL – not http/https or malformed', () => {
  assert.equal(isValidExternalUrl(''), false);
  assert.equal(isValidExternalUrl('not a url'), false);
  assert.equal(isValidExternalUrl('ftp://example.com'), false);
  assert.equal(isValidExternalUrl('javascript:alert(1)'), false);
  assert.equal(isValidExternalUrl('   '), false);
  assert.equal(extractYouTubeId('https://example.com'), null);
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractYouTubeId('not a url'), null);
});

test('non-YouTube URL – valid but not YouTube', () => {
  assert.equal(isValidExternalUrl('https://example.com/page'), true);
  assert.equal(isValidExternalUrl('http://example.org'), true);
  assert.equal(extractYouTubeId('https://example.com'), null);
  assert.equal(extractYouTubeId('https://vimeo.com/123'), null);
});

test('normal TXT remains unchanged', async () => {
  assert.equal(isExternalFileName('NormalQuery.txt'), false);
  assert.equal(isExternalFileName('My Notes.txt'), false);
  assert.equal(contentRouteForPath('Guidewire/NormalQuery.txt'), '/query/');
  assert.equal(contentRouteForPath('Guidewire/External - Foo.txt'), '/external/');
  assert.equal(contentRouteForPath('Guidewire/external - foo.txt'), '/external/');
  // Old convention should no longer be treated as external
  assert.equal(contentRouteForPath('Guidewire/External: Foo.txt'), '/query/');
  assert.equal(isExternalFileName('External: Foo.txt'), false);
});

test('existing video behavior remains unchanged', async () => {
  assert.equal(contentRouteForPath('Videos/MyVideo.mp4'), '/watch/');
  assert.equal(contentRouteForPath('Videos/MyVideo.webm'), '/watch/');
  assert.equal(contentRouteForPath('Videos/MyVideo.mov'), '/watch/');
  assert.equal(isExternalFileName('MyVideo.mp4'), false);
});

test('XSS/HTML escaping in friendly names – raw name not executed', async () => {
  const malicious = 'External - <script>alert(1)</script>.txt';
  const friendly = getExternalFriendlyName(malicious);
  assert.equal(friendly, '<script>alert(1)</script>');
  const { app } = await import('../src/server.js');
  const fn = app.locals.linkifyBody;
  const escaped = fn(friendly);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(isValidExternalUrl('javascript:alert(1)'), false);
});

test('path traversal/safety – external path still validated', async () => {
  const { isSafeLibraryPath } = await import('../src/library/local.js');
  assert.equal(isSafeLibraryPath('Guidewire/External - Foo.txt'), true);
  assert.equal(isSafeLibraryPath('../etc/passwd'), false);
  assert.equal(isSafeLibraryPath('Guidewire/../../etc/passwd'), false);
  assert.equal(isSafeLibraryPath('Guidewire/External - Foo.txt\\..\\..\\etc/passwd'), false);
  assert.equal(isSafeLibraryPath(''), false);
  assert.equal(isSafeLibraryPath(null), false);
});

test('External - handling does not break normal TXT and is detectable via helpers', async () => {
  assert.equal(isExternalFileName('External - Guidewire Rating Tutorial.txt'), true);
  assert.equal(getExternalFriendlyName('External - Guidewire Rating Tutorial.txt'), 'Guidewire Rating Tutorial');
  assert.equal(contentRouteForPath('Some/Folder/External - Guidewire Rating Tutorial.txt'), '/external/');
  const mockExternal = {
    path: 'SubFolder/External - Guidewire Rating Tutorial.txt',
    name: 'External - Guidewire Rating Tutorial.txt',
    friendlyName: getExternalFriendlyName('External - Guidewire Rating Tutorial.txt'),
    type: 'external',
    externalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    youtubeId: extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    isYouTube: true,
  };
  assert.equal(mockExternal.friendlyName, 'Guidewire Rating Tutorial');
  assert.equal(mockExternal.youtubeId, 'dQw4w9WgXcQ');
  assert.equal(isExternalFileName('NormalQuery.txt'), false);
  assert.equal(contentRouteForPath('Guidewire/NormalQuery.txt'), '/query/');
  const fakeFiles = [];
  const fakeVideos = [];
  const fakeFolders = ['SubFolder'];
  const fakeItems = [mockExternal];
  const tree = buildTree(fakeFiles, fakeVideos, fakeFolders, fakeItems);
  const found = findExternal(tree, 'SubFolder/External - Guidewire Rating Tutorial.txt');
  assert.ok(found, 'external should be findable via findExternal');
  assert.equal(found.file.friendlyName, 'Guidewire Rating Tutorial');
});

test('video file still detected as video, not external', async () => {
  assert.equal(isExternalFileName('MyVideo.mp4'), false);
  assert.equal(isExternalFileName('External - MyVideo.mp4'), true);
});

test('YouTube external page HTML contains only opaque token, not real video ID', async () => {
  const tmpRoot = path.join(QUERIES_DIR, '__external_token_test');
  const tmpFile = path.join(tmpRoot, 'External - TokenTest.txt');
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(tmpFile, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n');
  const SID = 'external-token-test-sid';
  const USER_TOK = { id: 6002, google_user_id: 'google-token', email: 'token@example.com', name: 'Token User', status: 'active', app_role: 'USER', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const COOKIE_TOK = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      if (params[0] === SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER_TOK.id } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ ...USER_TOK }], rowCount: 1 };
    if (/SELECT 1 FROM content_action_permissions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql) && /notes_available/.test(sql)) return { rows: [], rowCount: 0 };
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: '__external_token_test', access_level: 'all', role_id: null }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/SELECT COUNT/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/SELECT id FROM item_likes/.test(sql)) return { rows: [] };
    if (/video_views/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { app } = await import('../src/server.js');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);
  try {
    const res = await http('/external/__external_token_test/External%20-%20TokenTest.txt', { headers: { Cookie: COOKIE_TOK } });
    assert.equal(res.status, 200);
    const html = await res.text();
    // HTML must contain token, not real ID or embed URL
    const tokenMatch = html.match(/data-token="([A-Za-z0-9_-]+)"/);
    assert.ok(tokenMatch, 'HTML should contain data-token with opaque token');
    const token = tokenMatch[1];
    assert.ok(token.length >= 8, 'token should be 8+ chars');
    assert.doesNotMatch(html, /youtube\.com\/embed\/dQw4w9WgXcQ/);
    assert.doesNotMatch(html, /dQw4w9WgXcQ/);
    // Non-YouTube fallback should still work – check token resolves to embed
    const apiRes = await http(`/api/external-video/${encodeURIComponent(token)}`, { headers: { Cookie: COOKIE_TOK } });
    assert.equal(apiRes.status, 200);
    const data = await apiRes.json();
    assert.ok(data.embedUrl.includes('dQw4w9WgXcQ'), 'API should return real embed URL');
    assert.match(data.embedUrl, /https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?rel=0&fs=0/);
  } finally {
    await new Promise(r => server.close(r));
    pool.query = origQuery;
    pool.connect = origConnect;
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('external video token – invalid token returns 404', async () => {
  const SID2 = 'external-invalid-token-sid';
  const COOKIE2 = `connect.sid=s:${cookieSignature.sign(SID2, process.env.SESSION_SECRET)}`;
  const USER2 = { id: 6003, google_user_id: 'google-invalid', email: 'invalid@example.com', name: 'Invalid User', status: 'active', app_role: 'USER', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const origQ = pool.query;
  const origC = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM/.test(sql) && params[0] === SID2) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER2.id } }) }] };
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [{ ...USER2 }], rowCount: 1 };
    if (/folder_permissions/.test(sql)) return { rows: [] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/user_roles/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { app } = await import('../src/server.js');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/external-video/invalidToken123`, { headers: { Cookie: COOKIE2 } });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.match(data.error, /Invalid or expired/);
  } finally {
    await new Promise(r => server.close(r));
    pool.query = origQ;
    pool.connect = origC;
  }
});

test('external video token – unauthenticated returns 401/302', async () => {
  const { app } = await import('../src/server.js');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/external-video/someToken123`, { redirect: 'manual' });
    assert.ok([401, 302].includes(res.status), `expected 401 or 302 for unauthenticated, got ${res.status}`);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('Blogger URL detection – only HTTPS blogspot.com allowed', () => {
  assert.equal(isBloggerUrl('https://learnwithmegw.blogspot.com/2026/02/youtube-videos.html'), true);
  assert.equal(isBloggerUrl('https://subdomain.blogspot.com/page'), true);
  assert.equal(isBloggerUrl('https://blogspot.com/'), true);
  assert.equal(isBloggerUrl('http://learnwithmegw.blogspot.com/page'), false); // only HTTPS
  assert.equal(isBloggerUrl('https://example.com'), false);
  assert.equal(isBloggerUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(isBloggerUrl(''), false);
  assert.equal(isBloggerUrl('not a url'), false);
  assert.equal(isBloggerUrl('ftp://learnwithmegw.blogspot.com/page'), false);
});

test('Blogger external page renders iframe with sandbox, non-Blogger shows fallback', async () => {
  const tmpRoot = path.join(QUERIES_DIR, '__external_blogger_test');
  const bloggerFile = path.join(tmpRoot, 'External - BloggerTest.txt');
  const otherFile = path.join(tmpRoot, 'External - OtherTest.txt');
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(bloggerFile, 'https://learnwithmegw.blogspot.com/2026/02/youtube-videos.html\n');
  await writeFile(otherFile, 'https://example.com/page\n');
  const SIDB = 'external-blogger-test-sid';
  const USERB = { id: 6004, google_user_id: 'google-blogger', email: 'blogger@example.com', name: 'Blogger User', status: 'active', app_role: 'USER', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const COOKIEB = `connect.sid=s:${cookieSignature.sign(SIDB, process.env.SESSION_SECRET)}`;
  const origQ = pool.query;
  const origC = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql) && params[0] === SIDB) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USERB.id } }) }] };
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [{ ...USERB }], rowCount: 1 };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: '__external_blogger_test', access_level: 'all', role_id: null }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/user_roles/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { app, _clearLibraryCache } = await import('../src/server.js');
  _clearLibraryCache();
  const { invalidatePermissionCache } = await import('../src/library/local.js');
  invalidatePermissionCache();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);
  try {
    // Debug: check if file is discoverable via readQueryLibrary
    const { readQueryLibrary: dbgRead } = await import('../src/library/local.js');
    const { buildTree: dbgBuild, findExternal: dbgFind } = await import('../src/library/tree.js');
    const { _clearLibraryCache: dbgClear } = await import('../src/server.js');
    dbgClear();
    const dbgLib = await dbgRead();
    const dbgTree = dbgBuild(dbgLib.files, dbgLib.videos, dbgLib.folders, dbgLib.items);
    const dbgNode = dbgFind(dbgTree, '__external_blogger_test/External - BloggerTest.txt');
    console.log('DEBUG blogger file discoverable', !!dbgNode, dbgNode ? JSON.stringify({path: dbgNode.file.path, friendly: dbgNode.file.friendlyName, url: dbgNode.file.externalUrl}) : 'not found', 'items count', dbgLib.items.filter(i=>i.name.includes('BloggerTest')).length);
    // Blogger should be embedded
    const resBlog = await http('/external/__external_blogger_test/External%20-%20BloggerTest.txt', { headers: { Cookie: COOKIEB } });
    if (resBlog.status !== 200) {
      const txt = await resBlog.text();
      console.log('Blogger embed status', resBlog.status, txt.slice(0, 800));
      // Debug canAccess
      const { canAccessLibraryPath } = await import('../src/library/local.js');
      // Need to ensure folder permissions cache is populated – call loadFolderPermissions
      const { loadFolderPermissions } = await import('../src/library/local.js');
      await loadFolderPermissions();
      const can = canAccessLibraryPath(USERB, '__external_blogger_test/External - BloggerTest.txt');
      console.log('canAccess for USERB', can, 'user', USERB);
      const { isSafeLibraryPath } = await import('../src/library/local.js');
      console.log('isSafe', isSafeLibraryPath('__external_blogger_test/External - BloggerTest.txt'));
      const { findExternal: dbgFind2 } = await import('../src/library/tree.js');
      const { readQueryLibrary: dbgRead2 } = await import('../src/library/local.js');
      const lib2 = await dbgRead2();
      const { buildTree: dbgBuild2 } = await import('../src/library/tree.js');
      const tree2 = dbgBuild2(lib2.files, lib2.videos, lib2.folders, lib2.items);
      console.log('findExternal in test after 404', !!dbgFind2(tree2, '__external_blogger_test/External - BloggerTest.txt'));
    }
    assert.equal(resBlog.status, 200);
    const htmlBlog = await resBlog.text();
    assert.match(htmlBlog, /iframe[^>]*src="https:\/\/learnwithmegw\.blogspot\.com\/2026\/02\/youtube-videos\.html"/);
    assert.match(htmlBlog, /sandbox="allow-scripts allow-same-origin allow-popups"/);
    assert.match(htmlBlog, /referrerpolicy="no-referrer-when-downgrade"/);
    assert.match(htmlBlog, /loading="lazy"/);
    // Non-Blogger (example.com) should show fallback, not iframe with example.com src
    const resOther = await http('/external/__external_blogger_test/External%20-%20OtherTest.txt', { headers: { Cookie: COOKIEB } });
    assert.equal(resOther.status, 200);
    const htmlOther = await resOther.text();
    assert.match(htmlOther, /Open External Link/);
    assert.match(htmlOther, /https:\/\/example\.com\/page/);
    // Ensure YouTube still works (not broken by Blogger change)
    // Create a YouTube external for this check
    const ytFile = path.join(tmpRoot, 'External - YtCheck.txt');
    await writeFile(ytFile, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // Clear library cache so new file is discovered
    {
      const { _clearLibraryCache: clr } = await import('../src/server.js');
      clr();
      const { invalidatePermissionCache: inv } = await import('../src/library/local.js');
      inv();
    }
    const resYt = await http('/external/__external_blogger_test/External%20-%20YtCheck.txt', { headers: { Cookie: COOKIEB } });
    const htmlYt = await resYt.text();
    assert.match(htmlYt, /data-token="/);
    assert.doesNotMatch(htmlYt, /youtube\.com\/embed\/dQw4w9WgXcQ/);
    await rm(ytFile, { force: true });
  } finally {
    await new Promise(r => server.close(r));
    pool.query = origQ;
    pool.connect = origC;
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('invalid/non-HTTPS Blogger URL not treated as embeddable', async () => {
  assert.equal(isBloggerUrl('http://learnwithmegw.blogspot.com/page'), false);
  assert.equal(isBloggerUrl('https://evil.blogspot.com.evil.com'), false);
  // isValidExternalUrl still true for http, but isBloggerUrl should be false
  assert.equal(isValidExternalUrl('http://learnwithmegw.blogspot.com/page'), true);
  assert.equal(isBloggerUrl('http://learnwithmegw.blogspot.com/page'), false);
});

test('Drive file URL - valid patterns', () => {
  const validId = '1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_';
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${validId}/view?usp=sharing`), validId);
  assert.equal(isDriveUrl(`https://drive.google.com/file/d/${validId}/view?usp=sharing`), true);
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${validId}/preview`), validId);
  assert.equal(isDriveUrl(`https://drive.google.com/file/d/${validId}/preview`), true);
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${validId}`), validId);
  assert.equal(isDriveUrl(`https://drive.google.com/file/d/${validId}`), true);
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${validId}/view`), validId);
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${validId}/preview?usp=sharing`), validId);
});

test('Drive file URL - invalid patterns', () => {
  const validId = '1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_';
  assert.equal(isDriveUrl(`http://drive.google.com/file/d/${validId}/view`), false);
  assert.equal(extractDriveFileId(`http://drive.google.com/file/d/${validId}/view`), null);
  assert.equal(isDriveUrl(`https://drive.google.com/open?id=${validId}`), false);
  assert.equal(isDriveUrl(`https://drive.google.com/uc?export=download&id=${validId}`), false);
  assert.equal(isDriveUrl(`https://drive.google.com/drive/folders/${validId}`), false);
  assert.equal(isDriveUrl(`https://docs.google.com/document/d/${validId}`), false);
  assert.equal(isDriveUrl(`https://evil.com/file/d/${validId}`), false);
  assert.equal(isDriveUrl('https://drive.google.com/file/d/short/view'), false);
  assert.equal(isDriveUrl('https://drive.google.com/file/d/'), false);
  assert.equal(isDriveUrl('https://drive.google.com/file/d/abc'), false);
  assert.equal(isDriveUrl('not a url'), false);
  assert.equal(isDriveUrl(''), false);
  assert.equal(isDriveUrl(`https://drive.google.com/file/d/${validId}/extra`), false);
});

test('Drive external page renders preview iframe with safe attributes, no Open External Link', async () => {
  const tmpRoot = path.join(QUERIES_DIR, '__external_drive_test');
  const driveFile = path.join(tmpRoot, 'External - DriveTest.txt');
  const otherFile = path.join(tmpRoot, 'External - DriveOtherTest.txt');
  await mkdir(tmpRoot, { recursive: true });
  const validId = '1JjZML-RZxv3gtHa7vzOp5ptp7S0fvmu_';
  const driveUrl = `https://drive.google.com/file/d/${validId}/view?usp=sharing`;
  const expectedPreview = `https://drive.google.com/file/d/${validId}/preview`;
  await writeFile(driveFile, driveUrl + '\n');
  await writeFile(otherFile, 'https://example.com/page\n');
  const SID = 'external-drive-test-sid';
  const USER = { id: 6005, google_user_id: 'google-drive', email: 'drive@example.com', name: 'Drive User', status: 'active', app_role: 'USER', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000) };
  const COOKIE = `connect.sid=s:${cookieSignature.sign(SID, process.env.SESSION_SECRET)}`;
  const origQ = pool.query;
  const origC = pool.connect;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql) && params[0] === SID) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: USER.id } }) }] };
    if (/SELECT \* FROM users WHERE id/.test(sql)) return { rows: [{ ...USER }], rowCount: 1 };
    if (/folder_permissions/.test(sql)) return { rows: [{ folder_path: '__external_drive_test', access_level: 'all', role_id: null }] };
    if (/ad_settings/.test(sql)) return { rows: [] };
    if (/user_roles/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { app, _clearLibraryCache } = await import('../src/server.js');
  _clearLibraryCache();
  const { invalidatePermissionCache } = await import('../src/library/local.js');
  invalidatePermissionCache();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const http = (p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts);
  try {
    const resDrive = await http('/external/__external_drive_test/External%20-%20DriveTest.txt', { headers: { Cookie: COOKIE } });
    assert.equal(resDrive.status, 200);
    const htmlDrive = await resDrive.text();
    assert.match(htmlDrive, new RegExp(`iframe[^>]*src="${expectedPreview.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`));
    assert.match(htmlDrive, /sandbox="allow-scripts allow-same-origin allow-popups"/);
    assert.match(htmlDrive, /referrerpolicy="no-referrer-when-downgrade"/);
    assert.match(htmlDrive, /loading="lazy"/);
    assert.doesNotMatch(htmlDrive, /Open External Link/);
    // Normal external still shows fallback
    const resOther = await http('/external/__external_drive_test/External%20-%20DriveOtherTest.txt', { headers: { Cookie: COOKIE } });
    assert.equal(resOther.status, 200);
    const htmlOther = await resOther.text();
    assert.match(htmlOther, /Open External Link/);
  } finally {
    await new Promise(r => server.close(r));
    pool.query = origQ;
    pool.connect = origC;
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
