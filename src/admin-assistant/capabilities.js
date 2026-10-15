/**
 * Step 1 — Isolated Admin capability registry (read-only, declarative).
 *
 * Inspired by the registry/search/preflight ideas in `AKCodez/hackingtool-plugin`
 * (`tools.json` + `ht_search.py` + `ht_preflight.py`), reduced to a safe subset:
 * a static list of read-only admin diagnostic capabilities with deterministic
 * filtering and a pure preflight verdict. No execution, no shell, no network,
 * no DB, no timers, no imports, no writes. Not wired into any route yet.
 *
 * Each capability declares:
 *   id, label, description, category, requires ({ admin }), flags
 *   ({ readOnly, needsLiveEvidence, longRunning }), evidenceSection, adminUrl.
 *
 * All output is bounded via `CAPABILITY_CAPS`. All functions are pure and
 * deterministic: same input yields the same output.
 */

/** Hard caps for registry output. */
export const CAPABILITY_CAPS = {
  MAX_QUERY_CHARS: 120,
  MAX_RESULTS: 25,
  MAX_ID_CHARS: 64,
  MAX_LABEL_CHARS: 80,
  MAX_DESCRIPTION_CHARS: 280
};

/** Known categories mirror the deterministic brief sections. */
export const CAPABILITY_CATEGORIES = ['access', 'attention', 'health', 'integrity', 'usage', 'notes'];

/**
 * Static registry: one read-only capability per brief section.
 * Frozen at module load; accessors return clones so callers cannot mutate it.
 */
const REGISTRY = Object.freeze([
  Object.freeze({
    id: 'access.overview',
    label: 'Access overview',
    description: 'Read-only summary of total, active, pending, expiring, and revoked user access.',
    category: 'access',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'access',
    adminUrl: '/admin#users'
  }),
  Object.freeze({
    id: 'attention.discussions',
    label: 'Discussions needing attention',
    description: 'Read-only counts of unanswered and hidden discussions awaiting review.',
    category: 'attention',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'attention',
    adminUrl: '/admin/discussions'
  }),
  Object.freeze({
    id: 'health.runtime',
    label: 'Runtime health',
    description: 'Read-only runtime health indicators already collected by monitoring.',
    category: 'health',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'health',
    adminUrl: '/admin/system'
  }),
  Object.freeze({
    id: 'integrity.diagnostics',
    label: 'Integrity diagnostics',
    description: 'Read-only integrity check results with existing admin evidence links.',
    category: 'integrity',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'integrity',
    adminUrl: '/admin/system#integrity'
  }),
  Object.freeze({
    id: 'usage.history',
    label: 'Usage history',
    description: 'Read-only daily usage aggregates already persisted by the app.',
    category: 'usage',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'usage',
    adminUrl: '/admin/system'
  }),
  Object.freeze({
    id: 'notes.summary',
    label: 'Learner notes summary',
    description: 'Read-only aggregate counts of learner notes by learner and question.',
    category: 'notes',
    requires: Object.freeze({ admin: true }),
    flags: Object.freeze({ readOnly: true, needsLiveEvidence: true, longRunning: false }),
    evidenceSection: 'notes',
    adminUrl: '/admin/learner-notes'
  })
]);

function cloneCapability(entry) {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    category: entry.category,
    requires: { ...entry.requires },
    flags: { ...entry.flags },
    evidenceSection: entry.evidenceSection,
    adminUrl: entry.adminUrl
  };
}

function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return text.slice(0, CAPABILITY_CAPS.MAX_QUERY_CHARS);
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CAPABILITY_CAPS.MAX_RESULTS;
  return Math.min(Math.max(Math.floor(n), 1), CAPABILITY_CAPS.MAX_RESULTS);
}

function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const name = String(item ?? '').trim().toLowerCase();
    if (!CAPABILITY_CATEGORIES.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** List every registered capability (cloned, registry order). */
export function listAdminCapabilities() {
  return REGISTRY.map(cloneCapability);
}

/** Fetch one capability by exact id. Returns a clone or null. */
export function getAdminCapability(id) {
  if (typeof id !== 'string') return null;
  const found = REGISTRY.find(entry => entry.id === id);
  return found ? cloneCapability(found) : null;
}

/**
 * Deterministic filter over capability metadata (ANDed).
 * Options: `{ q, category, readOnly, requiresAdmin, limit }`.
 * Returns `{ count, capabilities }` bounded by `MAX_RESULTS`.
 */
export function searchAdminCapabilities(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const q = normalizeQuery(opts.q);
  const category = typeof opts.category === 'string' ? opts.category.trim().toLowerCase() : '';
  const limit = clampLimit(opts.limit);
  const readOnly = opts.readOnly === undefined ? undefined : opts.readOnly === true;
  const requiresAdmin = opts.requiresAdmin === undefined ? undefined : opts.requiresAdmin === true;

  const matches = [];
  for (const entry of REGISTRY) {
    if (category && entry.category !== category) continue;
    if (readOnly !== undefined && entry.flags.readOnly !== readOnly) continue;
    if (requiresAdmin !== undefined && entry.requires.admin !== requiresAdmin) continue;
    if (q) {
      const blob = `${entry.id} ${entry.label} ${entry.description} ${entry.category}`.toLowerCase();
      if (!blob.includes(q)) continue;
    }
    matches.push(cloneCapability(entry));
    if (matches.length >= limit) break;
  }
  return { count: matches.length, capabilities: matches };
}

/**
 * Pure preflight over evidence-section availability.
 * Input: `{ unavailableSections }` (unknown names ignored).
 * Output: `{ status: ready|partial|blocked, available, unavailable,
 *   recommendations, summary }`. Bounded to at most one recommendation.
 */
export function preflightAdminCapabilities(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const unavailable = normalizeSections(opts.unavailableSections);
  const unavailableSet = new Set(unavailable);
  const available = CAPABILITY_CATEGORIES.filter(name => !unavailableSet.has(name));

  let status = 'ready';
  if (available.length === 0) status = 'blocked';
  else if (unavailable.length > 0) status = 'partial';

  const recommendations = [];
  if (unavailable.length > 0) {
    recommendations.push({
      priority: unavailable.length === CAPABILITY_CATEGORIES.length ? 'critical' : 'high',
      action: `Restore unavailable admin evidence: ${unavailable.join(', ')}.`,
      why: 'Capabilities in those sections cannot report until their evidence is available.'
    });
  }

  let summary = `Ready — ${available.length}/${CAPABILITY_CATEGORIES.length} capability sections available.`;
  if (status === 'partial') {
    summary = `Partial — ${unavailable.length} section(s) unavailable (${unavailable.join(', ')}).`;
  } else if (status === 'blocked') {
    summary = 'Blocked — no capability sections available.';
  }

  return { status, available: [...available], unavailable, recommendations, summary };
}
