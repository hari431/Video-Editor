import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const restrictPath = path.join(__dirname, '..', 'src', 'public', 'devtools-restrict.js');
const partialPath = path.join(__dirname, '..', 'src', 'views', 'partials', 'adsense-verification.ejs');
const serverPath = path.join(__dirname, '..', 'src', 'server.js');

test('devtools-restrict.js exists and is central', () => {
  assert.ok(fs.existsSync(restrictPath), 'src/public/devtools-restrict.js should exist');
  const src = fs.readFileSync(restrictPath, 'utf8');
  assert.match(src, /window\.__IS_PRIVILEGED__/);
  assert.match(src, /window\.__IS_AUTHENTICATED__/);
  assert.match(src, /isLocalhost/);
  assert.match(src, /contextmenu/);
  assert.match(src, /F12/);
  assert.match(src, /e\.ctrlKey && e\.shiftKey/);
  assert.match(src, /key === 'I'/);
  assert.match(src, /key === 'J'/);
  assert.match(src, /key === 'C'/);
  assert.match(src, /key === 'U'/);
  assert.doesNotMatch(src, /debugger;/);
  assert.doesNotMatch(src, /while\s*\(true\)/);
  // Must not block normal shortcuts – should not contain generic Ctrl+C block
  assert.doesNotMatch(src, /key === 'C'[^}]*ctrlKey && !e\.shiftKey/); // crude check
});

test('partial loads script globally via common include', () => {
  const partial = fs.readFileSync(partialPath, 'utf8');
  assert.match(partial, /window\.__IS_PRIVILEGED__/);
  assert.match(partial, /window\.__IS_AUTHENTICATED__/);
  assert.match(partial, /devtools-restrict\.js/);
});

test('server renders isPrivileged flag for OWNER/ADMIN', () => {
  const serverSrc = fs.readFileSync(serverPath, 'utf8');
  assert.match(serverSrc, /res\.locals\.isPrivileged/);
  assert.match(serverSrc, /res\.locals\.isAuthenticated/);
  assert.match(serverSrc, /isOwnerUser.*isAdminUser|isAdminUser.*isOwnerUser/);
});

test('restrict logic respects privileged and localhost', async () => {
  // Simulate client logic
  const src = fs.readFileSync(restrictPath, 'utf8');
  // Check that file checks for localhost variants
  assert.match(src, /localhost/);
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /::1/);
  // Check that it early returns for privileged / localhost and only for authenticated
  assert.match(src, /isAuthenticated/);
  assert.match(src, /if \(!isAuthenticated\) return/);
  assert.match(src, /if \(isPrivileged \|\| isLocalhost\) return/);
});
