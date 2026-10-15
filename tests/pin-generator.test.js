import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import { pinReferencePath, buildPinString } from '../src/library/pin-generator.js';
import { parsePinnedReferences } from '../src/library/pinned.js';

// ---------- Pure helper tests (no DB, no fs) ----------

test('pin-generator: normal TXT → /query/…', () => {
  assert.equal(
    pinReferencePath('Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt'),
    '/query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt'
  );
});

test('pin-generator: External → /external/…', () => {
  assert.equal(
    pinReferencePath('Premium/Tutorials/External - Reading data from Excel.txt'),
    '/external/Premium/Tutorials/External - Reading data from Excel.txt'
  );
});

test('pin-generator: item-based binaries → /item/…', () => {
  assert.equal(pinReferencePath('Docs/Guide.pdf'), '/item/Docs/Guide.pdf');
  assert.equal(pinReferencePath('Docs/Data.xlsx'), '/item/Docs/Data.xlsx');
  assert.equal(pinReferencePath('Docs/Doc.docx'), '/item/Docs/Doc.docx');
  assert.equal(pinReferencePath('Docs/Slides.pptx'), '/item/Docs/Slides.pptx');
  assert.equal(pinReferencePath('Docs/Notes.md'), '/item/Docs/Notes.md');
});

test('pin-generator: exact nested path preserved, spaces readable', () => {
  const p = pinReferencePath('A/My Guide.pdf');
  assert.equal(p, '/item/A/My Guide.pdf');
  assert.doesNotMatch(p, /%20/, 'readable spaces, not percent-encoded');
  assert.doesNotMatch(p, /^[A-Za-z]:\\/, 'no filesystem path');
});

test('pin-generator: duplicate filenames generate different paths', () => {
  const a = pinReferencePath('Folder One/Same Name.txt');
  const b = pinReferencePath('Folder Two/Same Name.txt');
  assert.notEqual(a, b);
  assert.equal(a, '/query/Folder One/Same Name.txt');
  assert.equal(b, '/query/Folder Two/Same Name.txt');
});

test('pin-generator: buildPinString Normal format', () => {
  assert.equal(
    buildPinString({ access: 'normal', name: 'Reading data from Excel', path: '/query/Premium/X.txt' }),
    'Pinned: Reading data from Excel | /query/Premium/X.txt'
  );
});

test('pin-generator: buildPinString Premium format', () => {
  assert.equal(
    buildPinString({ access: 'Premium', name: 'Reading data from Excel', path: '/query/Premium/X.txt' }),
    'Pinned: Premium | Reading data from Excel | /query/Premium/X.txt'
  );
  assert.equal(
    buildPinString({ access: 'premium', name: 'N', path: '/item/A.pdf' }),
    'Pinned: Premium | N | /item/A.pdf'
  );
});

test('pin-generator: generated strings are accepted by the existing parser', () => {
  const normal = buildPinString({ access: 'normal', name: 'Reading data from Excel', path: '/query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt' });
  const premium = buildPinString({ access: 'premium', name: 'Reading data from Excel', path: '/query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt' });
  assert.equal(normal, 'Pinned: Reading data from Excel | /query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt');
  assert.equal(premium, 'Pinned: Premium | Reading data from Excel | /query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt');
  const rn = parsePinnedReferences(`body\n${normal}`).pinned;
  const rp = parsePinnedReferences(`body\n${premium}`).pinned;
  assert.equal(rn.length, 1);
  assert.deepEqual(rn[0], { title: 'Reading data from Excel', url: '/query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt', access: 'normal' });
  assert.equal(rp.length, 1);
  assert.deepEqual(rp[0], { title: 'Reading data from Excel', url: '/query/Premium/Policy Center/PC Config/Queries/Reading data from Excel.txt', access: 'premium' });
});

test('pin-generator: helper module performs no persistence or I/O', async () => {
  const src = await readFile(fileURLToPath(new URL('../src/library/pin-generator.js', import.meta.url)), 'utf8');
  for (const token of ['pool', "from 'pg'", 'node:fs', 'localStorage', 'document.cookie', 'INSERT', 'UPDATE', 'migrate']) {
    assert.doesNotMatch(src, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `no ${token} in helper`);
  }
  // Pure outputs only (also proves editable name changes title, never path).
  const renamed = buildPinString({ access: 'premium', name: 'Excel Reading Tutorial', path: '/query/Premium/X.txt' });
  assert.equal(renamed, 'Pinned: Premium | Excel Reading Tutorial | /query/Premium/X.txt');
});

// ---------- Route rendering tests (mocked pool, temp fixtures) ----------

const QUERIES_DIR = fileURLToPath(new URL('../queries/', import.meta.url));
const { app } = await import('../src/server.js');

const SECRET = process.env.SESSION_SECRET;
const enc = v => v.split('/').map(encodeURIComponent).join('/');

const ADMIN = { id: 201, google_user_id: 'google-201', email: 'gen-admin@example.com', name: 'GenAdmin', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'ADMIN' };
const OWNER = { id: 202, google_user_id: 'google-202', email: 'gen-owner@example.com', name: 'GenOwner', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: null, app_role: 'OWNER' };
const USER = { id: 203, google_user_id: 'google-203', email: 'gen-user@example.com', name: 'GenUser', status: 'active', first_login_at: new Date(), last_login_at: new Date(), access_expires_at: new Date(Date.now() + 86400000), app_role: 'USER' };
const USERS = { 201: ADMIN, 202: OWNER, 203: USER };

function sidFor(id) { return `pin-gen-${id}`; }
function cookieFor(id) { return `connect.sid=s:${cookieSignature.sign(sidFor(id), SECRET)}`; }

let server, port, originalQuery;

test.before(async () => {
  const base = path.join(QUERIES_DIR, '__pin_gen_test');
  await mkdir(path.join(base, 'Sub Dir'), { recursive: true });
  await mkdir(path.join(base, 'Other'), { recursive: true });
  await writeFile(path.join(base, 'Sub Dir', 'Same Name.txt'), 'alpha content');
  await writeFile(path.join(base, 'Other', 'Same Name.txt'), 'beta content');
  await writeFile(path.join(base, 'External - Sample Link.txt'), 'https://example.com/hello');
  await writeFile(path.join(base, 'Doc.pdf'), randomBytes(128));

  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/SELECT sess FROM/.test(sql)) {
      const m = String(params[0]).match(/pin-gen-(\d+)/);
      const uid = m ? Number(m[1]) : null;
      if (uid && USERS[uid]) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: uid } }) }] };
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id =/.test(sql)) {
      return { rows: [USERS[Number(params[0])] || USER] };
    }
    if (/user_roles/.test(sql)) return { rows: [] };
    if (/folder_permissions/.test(sql)) {
      return { rows: [{ folder_path: '__pin_gen_test', access_level: 'all', role_id: null }] };
    }
    if (/content_action_permissions/.test(sql)) return { rows: [], rowCount: 0 };
    if (/item_likes/.test(sql)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  await rm(path.join(QUERIES_DIR, '__pin_gen_test'), { recursive: true, force: true });
});

const http = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, opts);

test('pin-generator: Admin sees generator on TXT with exact path + default name', async () => {
  const res = await http(`/query/${enc('__pin_gen_test/Sub Dir/Same Name.txt')}`, { headers: { Cookie: cookieFor(201) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="pin-generator"/, 'generator present');
  assert.match(html, /\/query\/__pin_gen_test\/Sub Dir\/Same Name\.txt/, 'exact canonical path');
  assert.match(html, /value="Same Name"/, 'default name without extension');
  assert.match(html, /data-testid="pin-gen-panel" hidden/, 'OFF by default');
  const panelTag = html.match(/<div[^>]*data-testid="pin-gen-panel"[^>]*>/)[0];
  assert.doesNotMatch(panelTag, /display\s*:/, 'no inline display overriding hidden');
});

test('pin-generator: Owner sees generator; duplicate filename resolves to current item', async () => {
  const res = await http(`/query/${enc('__pin_gen_test/Other/Same Name.txt')}`, { headers: { Cookie: cookieFor(202) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="pin-generator"/);
  assert.match(html, /\/query\/__pin_gen_test\/Other\/Same Name\.txt/, 'other folder path');
  assert.doesNotMatch(html, /Sub Dir\/Same Name/, 'not the duplicate folder');
});

test('pin-generator: normal USER never receives the generator UI', async () => {
  for (const p of [
    `/query/${enc('__pin_gen_test/Sub Dir/Same Name.txt')}`,
    `/external/${enc('__pin_gen_test/External - Sample Link.txt')}`,
    `/item/${enc('__pin_gen_test/Doc.pdf')}`,
  ]) {
    const res = await http(p, { headers: { Cookie: cookieFor(203) } });
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.doesNotMatch(html, /data-testid="pin-generator"/, `no generator on ${p}`);
    assert.doesNotMatch(html, /pin-gen-path/, `no reference path on ${p}`);
  }
});

test('pin-generator: External uses /external/ route + friendly name', async () => {
  const res = await http(`/external/${enc('__pin_gen_test/External - Sample Link.txt')}`, { headers: { Cookie: cookieFor(201) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="pin-generator"/);
  assert.match(html, /\/external\/__pin_gen_test\/External - Sample Link\.txt/);
  assert.match(html, /value="Sample Link"/, 'friendly name default');
  assert.doesNotMatch(html, /_1\.txt/, 'never references the companion file');
});

// ---------- Headless client-behavior tests (real shipped inline script) ----------

function stubEl() {
  const listeners = {};
  return {
    textContent: '', value: '', checked: false, hidden: false,
    style: {},
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    fire: (t) => { (listeners[t] || []).forEach(fn => fn()); },
    select: () => {},
  };
}

async function loadGeneratorScript() {
  const src = await readFile(
    fileURLToPath(new URL('../src/views/partials/pin-generator.ejs', import.meta.url)), 'utf8');
  const script = src.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {
    toggle: stubEl(), label: stubEl(), panel: stubEl(), path: stubEl(),
    name: stubEl(), generate: stubEl(), result: stubEl(), output: stubEl(),
    copy: stubEl(), copied: stubEl(), premium: stubEl(),
  };
  els.panel.hidden = true;
  els.result.hidden = true;
  els.copied.hidden = true;
  els.label.textContent = 'OFF';
  els.path.textContent = '/query/Folder/Same Name.txt';
  els.name.value = 'Same Name';
  els.copy.textContent = 'Copy';
  const root = {
    querySelector: (sel) => {
      if (sel.includes('toggle"]')) return els.toggle;
      if (sel.includes('toggle-label')) return els.label;
      if (sel.includes('panel')) return els.panel;
      if (sel.includes('pin-gen-path')) return els.path;
      if (sel.includes('pin-gen-name')) return els.name;
      if (sel.includes('generate')) return els.generate;
      if (sel.includes('result')) return els.result;
      if (sel.includes('output')) return els.output;
      if (sel.includes('copy"]')) return els.copy;
      if (sel.includes('copied')) return els.copied;
      if (sel.includes('premium')) return els.premium;
      return null;
    },
  };
  let clipboard = null;
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { clipboard = t; } } },
    configurable: true,
  });
  const prevDocument = globalThis.document;
  globalThis.document = {
    querySelectorAll: () => [root],
    createElement: () => stubEl(),
    body: stubEl(),
  };
  try {
    eval(script);
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
  return { els, clipboard: () => clipboard };
}

test('pin-generator UI: Generate/Copy blocked while OFF', async () => {
  const { els, clipboard } = await loadGeneratorScript();
  assert.equal(els.panel.hidden, true, 'panel hidden initially');
  els.generate.fire('click');
  assert.equal(els.output.value, '', 'no pin generated while OFF');
  assert.equal(els.result.hidden, true, 'result stays hidden while OFF');
  els.copy.fire('click');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(clipboard(), null, 'nothing copied while OFF');
});

test('pin-generator UI: ON shows panel, Generate/Copy work, OFF clears again', async () => {
  const { els, clipboard } = await loadGeneratorScript();
  els.toggle.checked = true;
  els.toggle.fire('change');
  assert.equal(els.panel.hidden, false, 'panel visible when ON');
  assert.equal(els.label.textContent, 'ON');
  els.generate.fire('click');
  assert.equal(els.output.value, 'Pinned: Same Name | /query/Folder/Same Name.txt');
  assert.equal(els.result.hidden, false);
  els.premium.checked = true;
  els.name.value = 'Renamed';
  els.generate.fire('click');
  assert.equal(els.output.value, 'Pinned: Premium | Renamed | /query/Folder/Same Name.txt');
  els.copy.fire('click');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(clipboard(), 'Pinned: Premium | Renamed | /query/Folder/Same Name.txt', 'complete string copied');
  els.toggle.checked = false;
  els.toggle.fire('change');
  assert.equal(els.panel.hidden, true, 'panel hidden when switched OFF');
  assert.equal(els.label.textContent, 'OFF');
  assert.equal(els.output.value, '', 'generated state cleared on OFF');
  assert.equal(els.result.hidden, true, 'result hidden on OFF');
  els.generate.fire('click');
  assert.equal(els.output.value, '', 'Generate blocked after switching OFF');
});

test('pin-generator: PDF item uses /item/ route, OFF hides controls', async () => {
  const res = await http(`/item/${enc('__pin_gen_test/Doc.pdf')}`, { headers: { Cookie: cookieFor(201) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-testid="pin-generator"/);
  assert.match(html, /\/item\/__pin_gen_test\/Doc\.pdf/);
  assert.match(html, /value="Doc"/, 'extension stripped from default name');
  assert.match(html, /data-testid="pin-gen-toggle"/, 'OFF/ON toggle present');
  assert.match(html, /data-testid="pin-gen-generate"/, 'generate control inside hidden panel');
  assert.match(html, /Generate Pin/);
  assert.match(html, /data-testid="pin-gen-copy"/, 'copy control present');
});
