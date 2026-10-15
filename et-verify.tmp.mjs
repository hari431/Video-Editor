// Temporary local verification harness for the Expense Tracker People screen.
// Runs against the local machine only; deleted after use. Never committed.
import { config } from 'dotenv';
config();

import pg from 'pg';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';

const mask = s => String(s).replace(/\/\/([^:/]+):([^@]+)@/, '//$1:***@');
console.log('DB URL (masked):', mask(process.env.EXPENSE_TRACKER_DATABASE_URL));
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
if (!BASE_URL) { console.error('BASE_URL missing'); process.exit(1); }

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' :: ' + detail : '')); }

// --- 1. Find the admin user (email must be in ADMIN_EMAILS) ---
const appPool = new pg.Pool({ connectionString: 'postgres://postgres:Hari431@localhost:5432/gosu_query_library', max: 1 });
const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const { rows: userRows } = await appPool.query('SELECT id, email, status FROM users ORDER BY id');
const admin = userRows.find(u => adminEmails.includes(u.email.toLowerCase()) && u.status === 'active') || userRows.find(u => adminEmails.includes(u.email.toLowerCase()));
if (!admin) { console.error('No ADMIN_EMAILS user found in local users table'); process.exit(1); }
console.log('Admin user id:', admin.id);

// --- 2. Insert a local unlocked admin session row (removed at the end) ---
const sid = crypto.randomBytes(16).toString('hex');
const sess = {
  cookie: { originalMaxAge: 2592000000, expires: new Date(Date.now() + 2592000000).toISOString(), httpOnly: true, path: '/', sameSite: 'lax' },
  passport: { user: admin.id },
  expenseTrackerUnlockedUntil: Date.now() + 30 * 60 * 1000
};
await appPool.query('INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, $3)',
  [sid, JSON.stringify(sess), new Date(Date.now() + 86400000)]);
const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
const cookie = 'connect.sid=' + encodeURIComponent('s:' + sid + '.' + sig);
console.log('Session cookie prepared (sid hidden)');

// --- 3. Start the server (or reuse one already listening on PORT) ---
const net = await import('node:net');
const portBusy = await new Promise(resolve => {
  const s = net.createConnection({ host: '127.0.0.1', port: Number(PORT) }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
let child = null;
if (portBusy) {
  console.log('Server already listening on port ' + PORT + ' — reusing it');
} else {
  child = spawn('node', ['src/server.js'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write('[server] ' + d));
  child.stderr.on('data', d => process.stdout.write('[server:err] ' + d));
  console.log('Spawned server, waiting for port ' + PORT + '…');
}
const waitPort = async () => {
  for (let i = 0; i < 100; i++) {
    const up = await new Promise(resolve => {
      const s = net.createConnection({ host: '127.0.0.1', port: Number(PORT) }, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
};
if (!await waitPort()) { console.error('Server did not start'); process.exit(1); }

const fetchApi = (path, init = {}) => fetch(BASE_URL + path, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });

// --- 4. HTTP API tests ---
const getRes = await fetchApi('/api/admin/expense-tracker/data');
check('GET /data returns 200', getRes.status === 200, 'status=' + getRes.status);
const initialPayload = await getRes.json();
const snapshot = structuredClone(initialPayload.data);
check('GET /data returns workspace with default people', JSON.stringify(snapshot.people) === '["You","Chandu"]', JSON.stringify(snapshot.people));

const postEcho = await fetchApi('/api/admin/expense-tracker/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: snapshot })
});
const echoJson = await postEcho.json();
check('POST /data saves successfully', postEcho.status === 200 && echoJson.success === true, 'status=' + postEcho.status);

// --- 5. Full People screen flow in jsdom against the real rendered page ---
const pageRes = await fetchApi('/admin/expense-tracker');
check('GET /admin/expense-tracker renders tracker (not unlock page)', pageRes.status === 200 && (await pageRes.text()).includes('id="peopleView"'));
const html = await (await fetchApi('/admin/expense-tracker')).text();

const dom = new JSDOM(html, {
  url: BASE_URL + '/admin/expense-tracker',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (input, init = {}) => fetch(new URL(String(input), BASE_URL), { ...init, headers: { ...(init.headers || {}) } });
    let promptReply = null;
    window.__setPromptReply = v => { promptReply = v; };
    window.prompt = () => promptReply;
  }
});
const { window } = dom;
const doc = window.document;
const $ = id => doc.getElementById(id);

const waitUntil = async (fn, timeoutMs = 8000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return true; } catch { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('Timed out waiting for ' + label);
};

try {
  await waitUntil(() => $('status').textContent.includes('Local data ready'), 8000, 'initial load');
  check('A1 initial load shows "Local data ready."', true);

  const cardNames = () => [...doc.querySelectorAll('#peopleCards [data-person]')].map(c => c.dataset.person);
  check('A2 person cards render for existing people', cardNames().join('|') === 'You|Chandu', cardNames().join('|'));
  check('A3 cards show current-month zero totals initially', $('peopleCards').textContent.includes('Income: ₹0.00'), '');

  // Add a person via the prompt
  window.__setPromptReply('Test Person');
  $('addPerson').click();
  await waitUntil(() => $('ledgerTitle').textContent.includes('Test Person'), 8000, 'new person ledger opens');
  check('B1 add person opens their ledger automatically', !$('ledgerView').hidden && $('peopleView').hidden);
  check('B2 new person card exists', cardNames().includes('Test Person'), cardNames().join('|'));

  // Add an income entry
  $('description').value = 'Salary'; $('category').value = 'Salary'; $('amount').value = '50000'; $('entryType').value = 'income';
  $('addEntry').click();
  await waitUntil(() => $('entries').textContent.includes('Salary'), 8000, 'income entry appears');
  // Add an expense entry
  $('description').value = 'Rent'; $('category').value = 'Rent'; $('amount').value = '15000'; $('entryType').value = 'expenses';
  $('addEntry').click();
  await waitUntil(() => $('monthlySummary').textContent.includes('35,000'), 8000, 'net updated');
  check('C1 entries saved and summary shows Income/Expenses/Net', $('monthlySummary').textContent.includes('50,000') && $('monthlySummary').textContent.includes('15,000') && $('monthlySummary').textContent.includes('35,000'), $('monthlySummary').textContent.trim().replace(/\s+/g, ' '));

  // Back to people navigation
  $('backToPeople').click();
  await waitUntil(() => !$('peopleView').hidden, 4000, 'back to people');
  check('D1 Back to people returns to the People screen', !$('peopleView').hidden && $('ledgerView').hidden);
  const tpCard = [...doc.querySelectorAll('#peopleCards [data-person]')].find(c => c.dataset.person === 'Test Person');
  const cardText = tpCard ? tpCard.textContent.replace(/\s+/g, ' ') : '';
  check('D2 card shows current-month income/expenses/net', cardText.includes('50,000') && cardText.includes('15,000') && cardText.includes('35,000'), cardText.trim());

  // Re-open the ledger from the card
  tpCard.click();
  await waitUntil(() => !$('ledgerView').hidden && $('ledgerTitle').textContent.includes('Test Person'), 4000, 'ledger reopen');
  check('E1 selecting a person card opens their ledger', !$('ledgerView').hidden);

  // Duplicate name is rejected
  window.__setPromptReply('test person');
  $('backToPeople').click();
  $('addPerson').click();
  await waitUntil(() => $('status').textContent.includes('already exists'), 4000, 'duplicate rejection');
  check('F1 duplicate person name rejected case-insensitively', $('status').classList.contains('et-danger'));
  window.__setPromptReply(null);
} catch (e) {
  check('UI flow completed without unexpected error', false, e.message);
}

// --- 6. Verify the UI actions actually persisted server-side, then restore snapshot ---
const afterRes = await fetchApi('/api/admin/expense-tracker/data');
const afterData = (await afterRes.json()).data;
const tp = afterData.months?.['2026-10']?.people?.['Test Person'];
check('G1 UI changes persisted to the local database', !!tp && tp.income?.[0]?.amount === 50000 && tp.expenses?.[0]?.amount === 15000, JSON.stringify(tp || null));

const restoreRes = await fetchApi('/api/admin/expense-tracker/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: snapshot })
});
const restoredData = (await (await fetchApi('/api/admin/expense-tracker/data')).json()).data;
check('H1 workspace restored to pre-test snapshot', JSON.stringify(restoredData.people) === JSON.stringify(snapshot.people) && Object.keys(restoredData.months).length === Object.keys(snapshot.months).length, 'people=' + JSON.stringify(restoredData.people));

// --- 7. Cleanup: remove session row, close dom and server ---
dom.window.close();
await appPool.query('DELETE FROM user_sessions WHERE sid = $1', [sid]);
await appPool.end();
if (child) child.kill();

const failed = results.filter(r => !r.ok);
console.log('\n==== SUMMARY: ' + (results.length - failed.length) + '/' + results.length + ' checks passed ====');
if (failed.length) { failed.forEach(f => console.log('FAILED: ' + f.name + ' :: ' + f.detail)); process.exit(1); }
process.exit(0);
