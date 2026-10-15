/**
 * Phase 3 Step 1 — pure digest composer (no scheduling, delivery, Express,
 * gateway, or production wiring).
 *
 * This module is deliberately dependency-free: zero imports, no I/O, no
 * clock except an injectable `opts.now`, no environment access. It composes a
 * human-readable nightly digest ONLY from caller-supplied evidence:
 *
 *   - `brief`: an Admin Assistant brief (`headline`, `sections`, `topRisks`).
 *     Digest `items` come ONLY from brief findings (actual admin attention).
 *   - `searchResults`: `search_library`-shaped rows
 *     (`{ title, path, href, snippet }`) kept as supporting context only
 *     (`digest.supportingEvidence`), never as automatic digest items.
 *
 * Anti-invention contract (pinned by tests):
 * - Every digest item carries `evidenceRefs` that resolve to supplied
 *   evidence: either a brief finding (`{ section, findingId }`) or a search
 *   result (`{ path }`). Items that cannot cite supplied evidence are never
 *   emitted; their topics land in `unavailable` instead.
 * - Item `title`/`detail` text is restated (truncated) from the cited
 *   evidence strings only — never synthesized, never inferred.
 * - Empty or unusable evidence yields a structured `unavailable` digest,
 *   never an empty claim of health and never a throw.
 */

export const DIGEST_CAPS = {
  MAX_ITEMS: 12,
  MAX_TITLE_CHARS: 160,
  MAX_DETAIL_CHARS: 400,
  MAX_HEADLINE_CHARS: 280
};

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function findingById(brief, section, findingId) {
  const findings = brief?.sections?.[section]?.findings;
  if (!Array.isArray(findings)) return null;
  return findings.find(f => f && f.id === findingId) || null;
}

function resultByPath(searchResults, path) {
  if (!Array.isArray(searchResults)) return null;
  return searchResults.find(r => r && r.path === path) || null;
}

/**
 * Resolve one evidence ref against the supplied evidence.
 * Returns the source string the ref restates, or null when unresolvable.
 */
export function resolveEvidenceRef(brief, searchResults, ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.findingId === 'string' && typeof ref.section === 'string') {
    const finding = findingById(brief, ref.section, ref.findingId);
    if (!finding) return null;
    return [finding.title, finding.detail].filter(Boolean).join(' — ');
  }
  if (typeof ref.path === 'string') {
    const row = resultByPath(searchResults, ref.path);
    if (!row) return null;
    return [row.title, row.snippet ?? row.content].filter(Boolean).join(' — ');
  }
  return null;
}

/** True when every item cites at least one resolvable evidence ref. */
export function everyItemCited(brief, searchResults, items) {
  if (!Array.isArray(items) || !items.length) return false;
  return items.every(item =>
    Array.isArray(item?.evidenceRefs) &&
    item.evidenceRefs.length > 0 &&
    item.evidenceRefs.every(ref => resolveEvidenceRef(brief, searchResults, ref) !== null)
  );
}

function itemFromFinding(brief, searchResults, section, finding) {
  const ref = { section, findingId: finding.id };
  const source = resolveEvidenceRef(brief, searchResults, ref);
  if (!source) return null;
  return {
    id: `brief:${section}:${finding.id}`,
    title: truncateText(finding.title || finding.id, DIGEST_CAPS.MAX_TITLE_CHARS),
    detail: truncateText(finding.detail || finding.title || '', DIGEST_CAPS.MAX_DETAIL_CHARS),
    evidenceRefs: [ref]
  };
}

function normalizeDigestPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
}

function digestResultIsExcluded(row, excludedPaths) {
  if (!row || !excludedPaths || !(excludedPaths instanceof Set) || !excludedPaths.size) return false;
  const path = normalizeDigestPath(row.path);
  const title = normalizeDigestPath(row.title);
  const basename = path ? path.slice(path.lastIndexOf('/') + 1) : '';
  return Boolean(
    (path && excludedPaths.has(path)) ||
    (title && excludedPaths.has(title)) ||
    (basename && excludedPaths.has(basename))
  );
}

function toSupportingRow(row) {
  if (!row || typeof row.path !== 'string' || !row.path) return null;
  return {
    source: row.source ?? 'library',
    title: row.title ?? null,
    path: row.path,
    href: row.href ?? null,
    snippet: String(row.snippet ?? row.content ?? '').slice(0, 900)
  };
}

function supportingEvidenceFromResults(searchResults, excludedPaths) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(searchResults)) return out;
  for (const row of searchResults) {
    if (out.length >= DIGEST_CAPS.MAX_ITEMS) break;
    if (digestResultIsExcluded(row, excludedPaths)) continue;
    const publicRow = toSupportingRow(row);
    if (!publicRow) continue;
    const key = String(publicRow.path).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(publicRow);
  }
  return out;
}

/**
 * Compose a digest from supplied evidence. Pure function of its arguments.
 * Returns `{ ok:true, digest }` always (never throws on malformed input);
 * `digest.unavailable` names input areas that could not be stated from
 * evidence, and `digest.items` is non-empty only when fully cited.
 *
 * Digest items come ONLY from the admin brief (actual admin attention
 * items). `searchResults` are supporting context only: they are filtered
 * (question sources excluded), de-duplicated, capped, and returned as
 * `digest.supportingEvidence` — never as automatic digest items.
 */
export function composeDigest({ brief = null, searchResults = [], excludedPaths = new Set(), opts = {} } = {}) {
  const items = [];
  const unavailable = [];

  const sections = brief && typeof brief === 'object' && brief.sections && typeof brief.sections === 'object'
    ? brief.sections
    : null;
  if (sections) {
    for (const section of Object.keys(sections).sort()) {
      const findings = sections[section]?.findings;
      if (!Array.isArray(findings)) continue;
      for (const finding of findings) {
        if (!finding || typeof finding.id !== 'string') continue;
        if (items.length >= DIGEST_CAPS.MAX_ITEMS) break;
        const item = itemFromFinding(brief, searchResults, section, finding);
        if (item) items.push(item);
      }
      if (items.length >= DIGEST_CAPS.MAX_ITEMS) break;
    }
  } else {
    unavailable.push('admin-brief');
  }

  const supportingEvidence = supportingEvidenceFromResults(searchResults, excludedPaths);
  if (!supportingEvidence.length) {
    unavailable.push('library-search');
  }

  const cited = items.length > 0 && everyItemCited(brief, searchResults, items);
  const headline = !items.length
    ? 'Digest unavailable: no evidence-backed items could be stated.'
    : truncateText(
        typeof brief?.headline === 'string' && brief.headline
          ? `Digest: ${brief.headline}`
          : `Digest: ${items.length} evidence-backed item(s).`,
        DIGEST_CAPS.MAX_HEADLINE_CHARS
      );

  return {
    ok: true,
    digest: {
      headline,
      generatedAt: opts && opts.now ? String(opts.now) : new Date().toISOString(),
      itemCount: cited ? items.length : 0,
      items: cited ? items : [],
      supportingEvidence,
      supportingCount: supportingEvidence.length,
      unavailable: cited ? unavailable : [...unavailable, 'citation-check-failed'],
      fullyCited: cited
    }
  };
}
