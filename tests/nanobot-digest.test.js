/**
 * Phase 3 Step 1 — pure digest composer proofs (stubbed evidence only).
 *
 * No scheduling, delivery, Express, gateway, or production wiring is
 * exercised here. Every test supplies hand-built stubs shaped like
 * `get_admin_brief` / `search_library` outputs and proves:
 *  1. every factual item maps back to supplied evidence (citations resolve)
 *  2. no text is invented (titles/details restate cited evidence strings)
 *  3. unusable evidence yields structured `unavailable`, never empty claims
 *  4. caps hold under adversarial input sizes
 *  5. the composer is pure and dependency-free (source-level pin)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DIGEST_CAPS,
  composeDigest,
  resolveEvidenceRef,
  everyItemCited
} from '../src/nanobot/digest.js';

function stubBrief() {
  return {
    headline: 'Attention needed: 2 pending access request(s).',
    sections: {
      access: {
        status: 'attention',
        summary: 'Access: 10 total user(s).',
        findings: [
          { id: 'access:pending', severity: 'attention', level: 'warning', title: '2 pending access request(s)', detail: '2 user(s) waiting for approval.', evidenceRefs: [{ section: 'access', url: '/admin#users' }] }
        ]
      },
      attention: {
        status: 'healthy',
        summary: 'Discussions: 0 unanswered.',
        findings: []
      }
    },
    topRisks: [],
    unavailableSections: []
  };
}

function stubResults() {
  return [
    { source: 'library', title: 'PolicyCenter Basics.txt', path: 'Guidewire/PolicyCenter Basics.txt', href: '/query/Guidewire/PolicyCenter%20Basics.txt', snippet: 'PolicyCenter underwriting workflow for commercial lines.' },
    { source: 'library', title: 'Pasta Notes.txt', path: 'Cooking/Pasta Notes.txt', href: '/query/Cooking/Pasta%20Notes.txt', snippet: 'Boil water, add salt, cook pasta al dente.' }
  ];
}

function inputStrings(brief, results) {
  const out = [];
  if (brief && typeof brief.headline === 'string') out.push(brief.headline);
  for (const section of Object.values(brief?.sections || {})) {
    for (const f of section?.findings || []) {
      if (f?.title) out.push(String(f.title));
      if (f?.detail) out.push(String(f.detail));
    }
  }
  for (const r of results || []) {
    if (r?.title) out.push(String(r.title));
    if (r?.snippet) out.push(String(r.snippet));
  }
  return out;
}

const untruncated = text => String(text || '').replace(/…$/, '');

// --- 1. citation mapping ------------------------------------------------------
test('Phase 3.1: every digest item maps back to supplied evidence', () => {
  const brief = stubBrief();
  const results = stubResults();
  const { ok, digest } = composeDigest({ brief, searchResults: results, opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.equal(ok, true);
  assert.equal(digest.fullyCited, true);
  assert.ok(digest.items.length >= 1, 'brief findings surface as items');
  assert.ok(digest.items.every(item => String(item.id).startsWith('brief:')), 'items come only from the brief');
  assert.deepEqual(digest.supportingEvidence.map(r => r.path).sort(), results.map(r => r.path).sort());
  assert.equal(everyItemCited(brief, results, digest.items), true);
  for (const item of digest.items) {
    assert.ok(item.evidenceRefs.length >= 1);
    for (const ref of item.evidenceRefs) {
      assert.ok(resolveEvidenceRef(brief, results, ref) !== null, `ref resolves: ${JSON.stringify(ref)}`);
    }
  }
});

test('Phase 4.5: search results stay supporting context, never automatic digest items', () => {
  const brief = stubBrief();
  const results = stubResults();
  const { digest } = composeDigest({ brief, searchResults: results, opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.ok(digest.items.every(item => !String(item.id).startsWith('search:')), 'no search: items');
  assert.equal(digest.supportingCount, results.length);
  for (const row of digest.supportingEvidence) {
    assert.deepEqual(Object.keys(row).sort(), ['href', 'path', 'snippet', 'source', 'title']);
  }
  const unrelated = composeDigest({
    brief,
    searchResults: [{ source: 'library', title: 'Pasta Notes.txt', path: 'Cooking/Pasta Notes.txt', href: '/query/Cooking/Pasta%20Notes.txt', snippet: 'Boil water.' }],
    opts: { now: '2026-10-06T00:00:00.000Z' }
  });
  assert.ok(unrelated.digest.items.every(item => String(item.id).startsWith('brief:')), 'unrelated rows never become items');
  assert.equal(unrelated.digest.supportingEvidence[0].path, 'Cooking/Pasta Notes.txt');
});

// --- 2. no invention -----------------------------------------------------------
test('Phase 3.1: item text restates cited evidence; nothing is invented', () => {
  const brief = stubBrief();
  const results = stubResults();
  const { digest } = composeDigest({ brief, searchResults: results, opts: { now: '2026-10-06T00:00:00.000Z' } });
  const sources = inputStrings(brief, results);
  for (const item of digest.items) {
    for (const field of ['title', 'detail']) {
      const text = untruncated(item[field]);
      assert.ok(text.length > 0, `${field} is non-empty`);
      assert.ok(sources.some(s => s.includes(text)), `${field} restates supplied evidence: ${text.slice(0, 60)}`);
    }
  }
});

// --- 3. insufficient evidence ---------------------------------------------------
test('Phase 3.1: unusable evidence yields structured unavailable, never empty claims', () => {
  const empty = composeDigest({ brief: null, searchResults: [], opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.digest.items, []);
  assert.equal(empty.digest.fullyCited, false);
  assert.ok(empty.digest.unavailable.includes('admin-brief'));
  assert.ok(empty.digest.unavailable.includes('library-search'));
  assert.match(empty.digest.headline, /unavailable/i);

  const malformed = composeDigest({ brief: { headline: 42 }, searchResults: 'nope', opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.equal(malformed.ok, true);
  assert.deepEqual(malformed.digest.items, []);

  assert.equal(resolveEvidenceRef(stubBrief(), stubResults(), { section: 'access', findingId: 'nope' }), null);
  assert.equal(resolveEvidenceRef(stubBrief(), stubResults(), { path: 'Missing/File.txt' }), null);
  assert.equal(resolveEvidenceRef(stubBrief(), stubResults(), null), null);
  assert.equal(everyItemCited(stubBrief(), stubResults(), []), false);
  assert.equal(everyItemCited(stubBrief(), stubResults(), [{ id: 'x', evidenceRefs: [{ path: 'Missing/File.txt' }] }]), false);
});

// --- 4. caps --------------------------------------------------------------------
test('Phase 3.1: caps hold under adversarial input sizes', () => {
  const brief = stubBrief();
  for (let i = 0; i < 20; i++) {
    brief.sections.access.findings.push({ id: `access:extra-${i}`, title: `Extra finding number ${i} with padding`, detail: 'x'.repeat(2000), evidenceRefs: [] });
  }
  const results = [{ title: 'T'.repeat(500), path: 'Big/Item.txt', href: '/item/Big/Item.txt', snippet: 'S'.repeat(5000) }];
  const { digest } = composeDigest({ brief, searchResults: results, opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.ok(digest.items.length <= DIGEST_CAPS.MAX_ITEMS);
  for (const item of digest.items) {
    assert.ok(item.title.length <= DIGEST_CAPS.MAX_TITLE_CHARS);
    assert.ok(item.detail.length <= DIGEST_CAPS.MAX_DETAIL_CHARS);
  }
  assert.ok(digest.headline.length <= DIGEST_CAPS.MAX_HEADLINE_CHARS);
});

test('Phase 4.4: digest composer excludes explicitly identified question sources', () => {
  const brief = stubBrief();
  const results = [
    { source: 'library', title: 'Question 1.txt', path: 'Question 1.txt', href: '/query/Question%201.txt', snippet: 'The learner question.' },
    { source: 'library', title: 'Supporting Guidewire reference', path: 'Guidewire/Supporting.txt', href: '/query/Guidewire/Supporting.txt', snippet: 'Supporting documentation.' }
  ];
  const { digest } = composeDigest({
    brief,
    searchResults: results,
    excludedPaths: new Set(['question 1.txt']),
    opts: { now: '2026-10-06T00:00:00.000Z' }
  });

  assert.deepEqual(digest.supportingEvidence.map(r => r.path), ['Guidewire/Supporting.txt']);
  assert.ok(digest.items.every(item => String(item.id).startsWith('brief:')));
});

test('Phase 3.1: duplicate search paths surface once', () => {
  const row = stubResults()[0];
  const { digest } = composeDigest({ brief: stubBrief(), searchResults: [row, { ...row }], opts: { now: '2026-10-06T00:00:00.000Z' } });
  assert.equal(digest.supportingEvidence.filter(r => r.path === row.path).length, 1);
});

// --- 5. purity -------------------------------------------------------------------
test('Phase 3.1: composer is pure and dependency-free', async () => {
  const src = await readFile(new URL('../src/nanobot/digest.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import\s/m);
  assert.doesNotMatch(src, /require\s*\(|process\.|db\/pool|pool\.query/i);
  assert.doesNotMatch(src, /node:(fs|net|child_process)/);
  assert.doesNotMatch(src, /INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);

  const args = { brief: stubBrief(), searchResults: stubResults(), opts: { now: '2026-10-06T00:00:00.000Z' } };
  assert.deepEqual(composeDigest(args).digest, composeDigest(args).digest);
});
