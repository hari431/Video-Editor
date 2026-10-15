import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EVIDENCE_CAPS,
  buildAdminEvidencePack,
  getAccessOverview,
  maskEmail,
  sanitizeIntegrityReport,
  sanitizeNeedsAttention
} from '../src/admin-assistant/evidence.js';

const MOCK_ACCESS_ROW = {
  total_users: 10,
  pending_users: 2,
  revoked_users: 1,
  active_users: 6,
  admin_users: 1,
  expiring_soon_users: 3
};

function mockAccessClient(captured) {
  return {
    query: async sql => {
      captured.push(String(sql));
      return { rows: [{ ...MOCK_ACCESS_ROW }] };
    }
  };
}

function mockDeps(captured, overrides = {}) {
  return {
    accessClient: mockAccessClient(captured),
    metricsFn: async () => ({ ok: true }),
    healthFn: async () => ({ overall: 'healthy', indicators: [] }),
    integrityFn: async () => ({
      timestamp: '2026-10-05T00:00:00.000Z',
      overallStatus: 'warning',
      recommendation: 'Review diagnostics.',
      summary: { totalChecks: 1, totalIssues: 12 },
      checks: [
        {
          id: 'stale_active_user_accounts',
          title: 'Active Accounts Past Expiration',
          category: 'User Lifecycle & Access',
          status: 'warning',
          count: 12,
          description: 'Active accounts past expiry.',
          actionUrl: '/admin/expiring-users',
          actionLabel: 'Review',
          items: Array.from({ length: 12 }, (_, i) => ({
            userId: 100 + i,
            userEmail: `someone${i}@example.com`,
            details: `User access expired, account still active (${i}).`,
            apiToken: 'should-be-dropped'
          }))
        }
      ]
    }),
    historyFn: async limit => Array.from({ length: limit + 10 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}` })),
    needsFn: async () => ({
      counts: { unanswered_count: 4, hidden_questions_count: 1, hidden_replies_count: 2, recent_questions_count: 9, recent_replies_count: 7 },
      recentActive: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        title: `Question title ${i} with more than enough characters to exceed nothing`,
        item_path: `a/b/${i}.txt`,
        status: 'visible',
        created_at: '2026-10-01T00:00:00.000Z',
        author_name: 'Some Human'
      })),
      unansweredList: []
    }),
    notesFn: async () => ({ total_notes: 5, unique_learners: 3, unique_questions: 4 }),
    ...overrides
  };
}

test('evidence: pack aggregates read-only sections with caps and no raw PII', async () => {
  const captured = [];
  const pack = await buildAdminEvidencePack(mockDeps(captured));

  assert.equal(pack.meta.readOnly, true);
  assert.equal(pack.access.ok, true);
  assert.deepEqual(pack.access.data, MOCK_ACCESS_ROW);
  assert.equal(pack.attention.ok, true);
  assert.equal(pack.attention.data.recentActive.length, EVIDENCE_CAPS.MAX_LIST_ITEMS);
  assert.equal(pack.health.ok, true);
  assert.equal(pack.notes.ok, true);

  // Integrity items capped + emails masked, secret-ish keys dropped.
  const check = pack.integrity.data.checks[0];
  assert.equal(check.items.length, EVIDENCE_CAPS.MAX_ITEMS_PER_CHECK);
  assert.equal(check.items[0].userEmail, 's***@example.com');
  assert.equal(check.items[0].apiToken, undefined);

  // Usage history capped to MAX_HISTORY_DAYS.
  assert.ok(pack.usage.data.length <= EVIDENCE_CAPS.MAX_HISTORY_DAYS);

  // No raw PII anywhere in the serialized pack.
  const serialized = JSON.stringify(pack);
  assert.doesNotMatch(serialized, /someone\d@example\.com/);
  assert.doesNotMatch(serialized, /Some Human/);
  assert.doesNotMatch(serialized, /should-be-dropped/);
});

test('evidence: access overview issues fixed SELECT statements only', async () => {
  const captured = [];
  const client = mockAccessClient(captured);
  const overview = await getAccessOverview(client);

  assert.deepEqual(overview, MOCK_ACCESS_ROW);
  assert.equal(captured.length, 1);
  assert.match(captured[0].trimStart().slice(0, 6).toUpperCase(), /^SELECT/);
});

test('evidence: access overview falls back when app_role is missing', async () => {
  let calls = 0;
  const client = {
    query: async sql => {
      calls += 1;
      if (calls === 1) throw new Error('column "app_role" does not exist');
      assert.match(String(sql).trimStart().slice(0, 6).toUpperCase(), /^SELECT/);
      return { rows: [{ ...MOCK_ACCESS_ROW, admin_users: 0 }] };
    }
  };
  const overview = await getAccessOverview(client);
  assert.equal(calls, 2);
  assert.equal(overview.total_users, 10);
});

test('evidence: one failing section does not fail the pack', async () => {
  const captured = [];
  const pack = await buildAdminEvidencePack(
    mockDeps(captured, {
      integrityFn: async () => {
        throw new Error('diagnostics unavailable');
      }
    })
  );

  assert.equal(pack.integrity.ok, false);
  assert.equal(typeof pack.integrity.error, 'string');
  assert.equal(pack.access.ok, true);
  assert.equal(pack.health.ok, true);
  assert.equal(pack.usage.ok, true);
});

test('evidence: masking + sanitizer edge cases', async () => {
  assert.equal(maskEmail('Admin@Example.COM'), 'a***@example.com');
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskEmail(''), '***');

  const sanitized = sanitizeIntegrityReport(null);
  assert.deepEqual(sanitized.checks, []);

  const needs = sanitizeNeedsAttention(null);
  assert.deepEqual(needs.counts, {
    unanswered_count: 0,
    hidden_questions_count: 0,
    hidden_replies_count: 0,
    recent_questions_count: 0,
    recent_replies_count: 0
  });
});

test('evidence: module stays strictly read-only (source boundary)', async () => {
  const source = await readFile(new URL('../src/admin-assistant/evidence.js', import.meta.url), 'utf8');

  // Every SQL-looking template literal must be a SELECT (read-only).
  const blocks = [...source.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const sqlLike = blocks.filter(b => /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(b));
  assert.ok(sqlLike.length > 0, 'expected fixed SQL statements to inspect');
  for (const sql of sqlLike) {
    assert.match(sql.trimStart().slice(0, 6).toUpperCase(), /^SELECT/, `non-SELECT SQL found: ${sql.slice(0, 60)}`);
  }

  // No admin mutation identifiers anywhere.
  assert.doesNotMatch(
    source,
    /approveUser|extendUser|revokeUser|reactivateUser|grantAdmin|revokeAdmin|grantPremium|bulkExtend|bulkActivate|bulkRevoke|createPendingUser|createAdminUser/
  );

  // No LLM/provider, secret, or background-job surface.
  // (The module's own secret-key guard matches key *names* to drop them;
  // forbid real usages instead: env access, credential identifiers, key vars.)
  // Strip comments first so descriptive prose (e.g. "No LLM", "Luna") is not
  // mistaken for code; imports and identifiers below remain fully visible.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /luna|gemini|openrouter|generateContent|setInterval|setTimeout|nodemailer|SMTP/i);
  assert.doesNotMatch(code, /process\.env|SESSION_SECRET|GOOGLE_CLIENT|EMAIL_HOST|EMAIL_PASSWORD|RAZORPAY|ADMIN_EMAILS/i);
  assert.doesNotMatch(code, /['"]api[_-]?key['"]|\bapiKey\b/);

  // Only read-only getters may be imported.
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, [
    '../db/pool.js',
    '../knowledge/notes.js',
    '../library/discussions.js',
    '../monitoring/health.js',
    '../monitoring/history.js',
    '../monitoring/integrity.js',
    '../monitoring/metrics.js'
  ]);
});
