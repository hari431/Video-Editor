import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BRIEF_CAPS, buildAdminBrief } from '../src/admin-assistant/brief.js';

const NOW = '2026-10-05T12:00:00.000Z';

function healthyPack() {
  return {
    meta: { generatedAt: NOW, readOnly: true },
    access: { ok: true, data: { total_users: 10, pending_users: 0, revoked_users: 0, active_users: 9, admin_users: 1, expiring_soon_users: 0 } },
    attention: {
      ok: true,
      data: {
        counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_questions_count: 3, recent_replies_count: 5 },
        recentActiveCount: 2,
        unansweredListCount: 0,
        recentActive: [],
        unansweredList: []
      }
    },
    health: {
      ok: true,
      data: {
        overall: 'healthy',
        recommendation: 'Looks sufficient.',
        indicators: [{ name: 'Memory / Heap', status: 'healthy', value: '50 MB', threshold: 't', detail: 'd', advisory: 'a' }]
      }
    },
    integrity: {
      ok: true,
      data: {
        timestamp: NOW,
        overallStatus: 'healthy',
        recommendation: 'All passed.',
        summary: { totalChecks: 2, totalIssues: 0, criticalCount: 0, warningCount: 0, healthyCount: 2, overallStatus: 'healthy' },
        checks: [
          { id: 'check-a', title: 'Check A', category: 'Cat', status: 'healthy', count: 0, description: 'd', actionUrl: '/admin/system#integrity', actionLabel: 'Review', items: [] },
          { id: 'check-b', title: 'Check B', category: 'Cat', status: 'healthy', count: 0, description: 'd', actionUrl: '/admin/system#integrity', actionLabel: 'Review', items: [] }
        ]
      }
    },
    usage: { ok: true, data: [{ day: '2026-10-04' }, { day: '2026-10-03' }] },
    notes: { ok: true, data: { total_notes: 5, unique_learners: 3, unique_questions: 4 } }
  };
}

function attentionPack() {
  const pack = healthyPack();
  pack.access = { ok: true, data: { total_users: 12, pending_users: 2, revoked_users: 1, active_users: 8, admin_users: 1, expiring_soon_users: 3 } };
  pack.attention.data.counts.unanswered_count = 4;
  pack.attention.data.counts.hidden_questions_count = 1;
  pack.attention.data.counts.hidden_replies_count = 2;
  pack.health.data.overall = 'warning';
  pack.health.data.indicators.push({ name: 'Error rate', status: 'warning', value: '6%', threshold: 't', detail: 'd', advisory: 'Check logs.' });
  pack.integrity.data.overallStatus = 'critical';
  pack.integrity.data.checks.push(
    { id: 'paid_products_missing_roles', title: 'Paid Products Referencing Missing Roles', category: 'Paid', status: 'critical', count: 2, description: 'Broken role ref.', actionUrl: '/admin/paid-products', actionLabel: 'Review', items: [] },
    { id: 'stale_active_user_accounts', title: 'Stale Active Accounts', category: 'Users', status: 'warning', count: 5, description: 'Past expiry.', actionUrl: '/admin/expiring-users', actionLabel: 'Review', items: [] }
  );
  return pack;
}

test('brief: healthy evidence yields healthy overall with no findings', async () => {
  const brief = buildAdminBrief(healthyPack(), { now: NOW });

  assert.equal(brief.overall, 'healthy');
  assert.equal(brief.headline, 'All available signals healthy.');
  assert.deepEqual(brief.topRisks, []);
  assert.deepEqual(brief.unavailableSections, []);
  for (const name of ['access', 'attention', 'health', 'integrity', 'usage', 'notes']) {
    assert.equal(brief.sections[name].status, 'healthy', name);
    assert.deepEqual(brief.sections[name].findings, [], name);
  }
  assert.equal(brief.meta.readOnly, true);
  assert.equal(brief.meta.generatedAt, NOW);
  assert.equal(brief.meta.evidenceGeneratedAt, NOW);
});

test('brief: attention evidence yields attention overall with cited findings', async () => {
  const brief = buildAdminBrief(attentionPack(), { now: NOW });

  assert.equal(brief.overall, 'attention');
  assert.match(brief.headline, /^Attention needed: /);
  assert.ok(brief.headline.length <= BRIEF_CAPS.MAX_HEADLINE_CHARS);

  // Every finding carries usable evidence references.
  const all = Object.values(brief.sections).flatMap(s => s.findings);
  assert.ok(all.length > 0);
  for (const f of all) {
    assert.equal(f.severity, 'attention');
    assert.ok(Array.isArray(f.evidenceRefs) && f.evidenceRefs.length > 0, f.id);
    for (const r of f.evidenceRefs) {
      assert.ok(typeof r.section === 'string' && r.section, f.id);
      assert.ok(typeof r.url === 'string' && r.url.startsWith('/admin'), f.id);
    }
  }

  // Integrity findings reference their check IDs.
  const ids = all.map(f => f.id);
  assert.ok(ids.includes('integrity:paid_products_missing_roles'));
  assert.ok(ids.includes('integrity:stale_active_user_accounts'));
  assert.ok(ids.includes('access:pending'));
  assert.ok(ids.includes('attention:unanswered'));

  // Critical risks sort before warnings in topRisks (lightweight refs: no detail).
  assert.ok(brief.topRisks.length > 0 && brief.topRisks.length <= BRIEF_CAPS.MAX_TOP_RISKS);
  assert.equal(brief.topRisks[0].level, 'critical');
  for (const r of brief.topRisks) {
    assert.equal(Object.hasOwn(r, 'detail'), false, r.id);
    assert.ok(Array.isArray(r.evidenceRefs) && r.evidenceRefs.length > 0, r.id);
  }
});

test('brief: failed sections become unavailable, never silent', async () => {
  const pack = healthyPack();
  pack.integrity = { ok: false, error: 'diagnostics unavailable' };
  pack.usage = { ok: false, error: 'db_error' };
  const brief = buildAdminBrief(pack, { now: NOW });

  assert.equal(brief.overall, 'unavailable');
  assert.deepEqual(brief.unavailableSections, ['integrity', 'usage']);
  assert.match(brief.headline, /Brief incomplete: 2 section\(s\) unavailable/);
  assert.equal(brief.sections.integrity.status, 'unavailable');
  assert.equal(brief.sections.integrity.findings[0].severity, 'unavailable');
  assert.equal(brief.sections.access.status, 'healthy');
});

test('brief: attention wins over unavailable in overall state', async () => {
  const pack = attentionPack();
  pack.notes = { ok: false, error: 'nope' };
  const brief = buildAdminBrief(pack, { now: NOW });

  assert.equal(brief.overall, 'attention');
  assert.deepEqual(brief.unavailableSections, ['notes']);
  assert.ok(brief.topRisks.length > 0);
});

test('brief: malformed packs degrade to unavailable without throwing', async () => {
  for (const bad of [null, undefined, {}, { meta: null }]) {
    const brief = buildAdminBrief(bad, { now: NOW });
    assert.equal(brief.overall, 'unavailable');
    assert.deepEqual(brief.unavailableSections, ['access', 'attention', 'health', 'integrity', 'usage', 'notes']);
    assert.deepEqual(brief.topRisks, []);
  }
});

test('brief: output is deterministic and bounded', async () => {
  const pack = attentionPack();
  const first = buildAdminBrief(pack, { now: NOW });
  const second = buildAdminBrief(structuredClone(pack), { now: NOW });
  assert.deepEqual(first, second);

  // Adversarial pack: many checks, long strings, oversized lists.
  const hostile = healthyPack();
  hostile.integrity.data.overallStatus = 'warning';
  hostile.integrity.data.checks = Array.from({ length: 40 }, (_, i) => ({
    id: `check-${i}`,
    title: `Check ${i} ` + 'x'.repeat(500),
    category: 'Cat',
    status: i % 3 === 0 ? 'critical' : 'warning',
    count: 9999,
    description: 'y'.repeat(2000),
    actionUrl: '/admin/system#integrity',
    actionLabel: 'Review',
    items: []
  }));
  hostile.health.data.overall = 'critical';
  hostile.health.data.indicators = Array.from({ length: 20 }, (_, i) => ({
    name: `Indicator ${i}`,
    status: 'critical',
    value: 'z'.repeat(500),
    threshold: 't',
    detail: 'd'.repeat(1000),
    advisory: 'a'.repeat(1000)
  }));
  const brief = buildAdminBrief(hostile, { now: NOW });
  const serialized = JSON.stringify(brief);
  assert.ok(serialized.length < 12000, `brief too large: ${serialized.length}`);
  // +1 slack: truncateText appends an ellipsis to over-long strings.
  assert.ok(brief.headline.length <= BRIEF_CAPS.MAX_HEADLINE_CHARS + 1);
  assert.ok(brief.topRisks.length <= BRIEF_CAPS.MAX_TOP_RISKS);
  for (const section of Object.values(brief.sections)) {
    assert.ok(section.findings.length <= BRIEF_CAPS.MAX_FINDINGS_PER_SECTION);
    assert.ok(section.summary.length <= BRIEF_CAPS.MAX_SUMMARY_CHARS + 1);
    for (const f of section.findings) {
      assert.ok(f.title.length <= BRIEF_CAPS.MAX_FINDING_CHARS + 1, f.id);
      assert.ok(f.detail.length <= BRIEF_CAPS.MAX_FINDING_CHARS + 1, f.id);
    }
  }
  // No untruncated runs leak through: capped text keeps at most cap+1 chars
  // (trailing ellipsis), so no single-char run may exceed that.
  assert.doesNotMatch(serialized, /x{202,}|y{202,}|a{202,}/);
  for (const r of brief.topRisks.flatMap(r => r.evidenceRefs)) {
    assert.ok(r.label.length <= BRIEF_CAPS.MAX_REF_LABEL_CHARS + 1, r.label.slice(0, 40));
  }
});

test('brief: module is dependency-free presentation code (source boundary)', async () => {
  const source = await readFile(new URL('../src/admin-assistant/brief.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

  // No imports at all: pure function of the pack object.
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bfrom\s+['"]/);

  // No DB, LLM, env, timer, or network surface.
  assert.doesNotMatch(code, /\bpool\b|db\/pool|getMetrics|getNeedsAttention|SELECT|INSERT|UPDATE|DELETE\b/i);
  assert.doesNotMatch(code, /luna|gemini|openrouter|generateContent|fetch\(|process\.env|setInterval|setTimeout/i);
});
