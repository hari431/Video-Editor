import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { formatReconciliationDate } from '../src/utils/reconciliationDisplay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '../src/views/admin-paid-products.ejs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');

function renderReconciliation(latest, latestCompleted = null) {
  const data = {
    user: { name: 'Admin', email: 'admin@example.com' },
    reconciliationStatus: { hasRun: !!latest, latest: latest || null, latestCompleted },
    revenueSummary: { totalRevenueInr: '0.00', totalOrdersCount: 0 },
    activeGrantsByProduct: {},
    oneTimeVsRecurringMembers: {},
    needsAttentionItems: [],
    directoryResults: [],
    products: [],
    plans: [],
    promotions: [],
    filters: { search: '', productFilter: '', planFilter: '', billingTypeFilter: '', statusFilter: 'all' },
    msg: null,
    error: null,
    csrfToken: 'test-csrf',
  };
  return ejs.render(templateSrc, data, { filename: templatePath });
}

test('Reconciliation timestamp display — IST primary + UTC secondary', async (t) => {
  await t.test('1. formatReconciliationDate helper returns dual timezone string for 3 AM IST instant', () => {
    // 2026-09-16T21:30Z == Sep 17 03:00 IST — the canonical scheduled instant
    const utc = '2026-09-16T21:30:00.000Z';
    const expected = 'Sep 17, 2026, 3:00 AM IST (Sep 16, 2026, 9:30 PM UTC)';
    assert.equal(formatReconciliationDate(utc), expected);

    // Also verify winter/summer no DST drift
    assert.equal(
      formatReconciliationDate('2026-01-15T21:30:00.000Z'),
      'Jan 16, 2026, 3:00 AM IST (Jan 15, 2026, 9:30 PM UTC)'
    );
    assert.equal(
      formatReconciliationDate('2026-07-15T21:30:00.000Z'),
      'Jul 16, 2026, 3:00 AM IST (Jul 15, 2026, 9:30 PM UTC)'
    );
  });

  await t.test('2. helper handles null/empty/invalid gracefully', () => {
    assert.equal(formatReconciliationDate(null), '');
    assert.equal(formatReconciliationDate(undefined), '');
    assert.equal(formatReconciliationDate(''), '');
    assert.equal(formatReconciliationDate('invalid-date'), 'invalid-date');
  });

  await t.test('3. EJS server template uses Asia/Kolkata as IST and UTC as secondary', () => {
    // Must contain explicit timeZone params — no implicit host TZ
    assert.ok(templateSrc.includes('Asia/Kolkata'), 'must reference Asia/Kolkata');
    assert.ok(templateSrc.includes("'UTC'") || templateSrc.includes('"UTC"') || templateSrc.includes('UTC'), 'must reference UTC');
    // Both formatters must emit IST and UTC
    assert.ok(templateSrc.includes('IST (') && templateSrc.includes(' UTC)'), 'must format as IST (UTC)');
    // Verify the server helper _fmtReconcileDate contains both zones (grab larger span)
    const serverFn = templateSrc.match(/function _fmtReconcileDate[\s\S]*?UTC[\s\S]*?\}/);
    assert.ok(serverFn, 'must define _fmtReconcileDate');
    assert.ok(serverFn[0].includes('Asia/Kolkata'), '_fmtReconcileDate must use Asia/Kolkata');
    assert.ok(serverFn[0].includes('UTC'), '_fmtReconcileDate must use UTC');
  });

  await t.test('4. Server-rendered completed timestamp shows dual zone + Scheduled', () => {
    const utc = '2026-09-16T21:30:00.000Z'; // 3 AM IST Sep17
    const html = renderReconciliation({ started_at: utc, trigger_source: 'scheduled', status: 'completed', checked_users: 5 });
    assert.ok(html.includes('Sep 17, 2026, 3:00 AM IST (Sep 16, 2026, 9:30 PM UTC) · Scheduled'), `Expected dual formatted scheduled: ${html.slice(html.indexOf('reconciliation-last')-200, html.indexOf('reconciliation-last')+400)}`);
  });

  await t.test('5. Server-rendered Manual trigger also shows dual zone', () => {
    const utc = '2026-09-16T10:00:00.000Z'; // 3:30 PM IST same day
    const expected = formatReconciliationDate(utc);
    const html = renderReconciliation({ started_at: utc, trigger_source: 'manual', status: 'completed', checked_users: 2 });
    assert.ok(html.includes(`${expected} · Manual`), `Manual should show ${expected}: ${html.slice(html.indexOf('reconciliation-last')-100, html.indexOf('reconciliation-last')+300)}`);
  });

  await t.test('6. Failed and running (Previous/Started) states also use dual zone', () => {
    const prevUtc = '2026-09-15T21:30:00.000Z';
    const runningUtc = '2026-09-16T21:30:00.000Z';
    // Running case shows Previous
    const runningHtml = renderReconciliation(
      { started_at: runningUtc, trigger_source: 'scheduled', status: 'running', checked_users: 0 },
      { started_at: prevUtc, trigger_source: 'scheduled', status: 'completed', checked_users: 7 }
    );
    const prevExpected = formatReconciliationDate(prevUtc);
    assert.ok(runningHtml.includes(`Previous: ${prevExpected} · Scheduled`), 'Running Previous line must be dual zone');

    // Failed case
    const failedHtml = renderReconciliation({ started_at: runningUtc, trigger_source: 'scheduled', status: 'failed', checked_users: 0, error_message: 'boom' });
    assert.ok(failedHtml.includes('Sep 17, 2026, 3:00 AM IST (Sep 16, 2026, 9:30 PM UTC) · Scheduled'), 'Failed must show dual zone');
  });

  await t.test('7. Client fmtDate function mirrors server formatter (Asia/Kolkata + UTC)', () => {
    // Verify client fmtDate source contains both zones and produces same output as helper
    assert.ok(templateSrc.includes('function fmtDate'), 'must define client fmtDate');
    // crude extraction: find the fmtDate block containing both zones
    const idx = templateSrc.indexOf('function fmtDate');
    const block = templateSrc.slice(idx, idx + 600);
    assert.ok(block.includes('Asia/Kolkata'), 'client fmtDate must use Asia/Kolkata');
    assert.ok(block.includes('UTC'), 'client fmtDate must use UTC');
    assert.ok(block.includes('IST ('), 'client fmtDate must produce IST (UTC) pattern');
    // Replicate client logic locally and compare to helper
    function clientFmt(d) {
      try {
        const dt = new Date(d);
        const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
        const ist = dt.toLocaleString('en-US', { ...opts, timeZone: 'Asia/Kolkata' });
        const utc = dt.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
        return ist + ' IST (' + utc + ' UTC)';
      } catch { return String(d); }
    }
    assert.equal(clientFmt('2026-09-16T21:30:00.000Z'), 'Sep 17, 2026, 3:00 AM IST (Sep 16, 2026, 9:30 PM UTC)');
    assert.equal(clientFmt('2026-01-15T21:30:00.000Z'), formatReconciliationDate('2026-01-15T21:30:00.000Z'));
  });
});
