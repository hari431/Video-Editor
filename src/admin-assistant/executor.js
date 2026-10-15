/**
 * Narrow action executor (read-only diagnostic plans only).
 *
 * Executes ONLY the 5 plans declared in the trusted `./actions.js` registry.
 * There is deliberately no generic "run capability" abstraction: each action
 * id maps to one explicitly implemented, read-only handler function below,
 * so the trust boundary stays auditable.
 *
 * Server-side gates, re-run on every call (a client-supplied `planned`
 * result is never trusted):
 *   1. `validateActionRequest()` from the trusted registry — non-`ok`
 *      contract results (`blocked` / `unavailable`) are returned unchanged.
 *   2. The action is re-resolved from the trusted registry by exact id.
 *      Caller-supplied ids that are not in the registry → `unavailable`.
 *   3. Every required evidence section must actually be present and usable
 *      in the supplied `brief` — context claims alone are not enough.
 *      Missing/unavailable section data → `blocked` / `evidence-unavailable`.
 *   4. The matching explicit handler repackages brief data only. Unexpected
 *      handler failure → `blocked` / `execution-failed` with a generic
 *      message. Internal errors, commands, secrets, and stacks never leave
 *      this module.
 *
 * Status vocabulary: `planned` (eligible, from the contract layer only),
 * `blocked` (policy/auth/evidence/execution failure prevents execution),
 * `unavailable` (the request cannot be resolved), `executed` (a handler
 * actually ran and returned bounded read-only data).
 *
 * No shell, exec, spawn, sudo, Docker, filesystem writes, network scanning,
 * arbitrary URLs, or DB access. Imports only `./actions.js`. All output
 * bounded via `EXECUTOR_CAPS`.
 */

import { getPlannedAction, validateActionRequest } from './actions.js';

/** Hard caps for executor output. */
export const EXECUTOR_CAPS = {
  MAX_FINDINGS: 6,
  MAX_TOP_RISKS: 5,
  MAX_EVIDENCE_REFS: 12,
  MAX_SUMMARY_CHARS: 200,
  MAX_TEXT_CHARS: 200,
  MAX_REF_LABEL_CHARS: 120
};

const ALLOWED_LEVELS = new Set(['critical', 'warning', 'info']);

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isSafeAdminUrl(url) {
  return typeof url === 'string' && /^\/admin([#?/]|$)/.test(url);
}

function checksFor(results) {
  return [
    { check: 'authorization', passed: results.authorization === true },
    { check: 'capability', passed: results.capability === true },
    { check: 'evidence', passed: results.evidence === true }
  ];
}

function sanitizeRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    section: truncateText(raw.section, EXECUTOR_CAPS.MAX_TEXT_CHARS),
    label: truncateText(raw.label ?? raw.section, EXECUTOR_CAPS.MAX_REF_LABEL_CHARS)
  };
  if (typeof raw.checkId === 'string' && raw.checkId) {
    out.checkId = truncateText(raw.checkId, EXECUTOR_CAPS.MAX_TEXT_CHARS);
  }
  if (isSafeAdminUrl(raw.url)) out.url = String(raw.url);
  if (!out.section || !out.label) return null;
  return out;
}

function sanitizeFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const level = typeof raw.level === 'string' && ALLOWED_LEVELS.has(raw.level) ? raw.level : 'info';
  const refs = [];
  if (Array.isArray(raw.evidenceRefs)) {
    for (const ref of raw.evidenceRefs) {
      const clean = sanitizeRef(ref);
      if (clean) refs.push(clean);
      if (refs.length >= EXECUTOR_CAPS.MAX_EVIDENCE_REFS) break;
    }
  }
  const title = truncateText(raw.title, EXECUTOR_CAPS.MAX_TEXT_CHARS);
  if (!title) return null;
  return {
    id: truncateText(raw.id ?? title, EXECUTOR_CAPS.MAX_TEXT_CHARS),
    title,
    level,
    evidenceRefs: refs
  };
}

function collectRefs(findings) {
  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    for (const ref of finding.evidenceRefs || []) {
      const key = `${ref.section}|${ref.checkId || ''}|${ref.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
      if (out.length >= EXECUTOR_CAPS.MAX_EVIDENCE_REFS) return out;
    }
  }
  return out;
}

function usableSection(brief, name) {
  const section = brief?.sections?.[name];
  if (!section || typeof section !== 'object') return null;
  if (section.status === 'unavailable') return null;
  if (typeof section.summary !== 'string' || !section.summary) return null;
  return section;
}

function sectionFindings(section, limit) {
  const out = [];
  if (!Array.isArray(section.findings)) return out;
  for (const raw of section.findings) {
    const clean = sanitizeFinding(raw);
    if (clean) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Explicit read-only handlers (one per declared plan) ─────────────────────
// Each reads ONLY its required brief section(s) and repackages them.
// Returns `{ summary, findings }` or `null` when its data is unusable.

function executeAccessReviewQueue(brief) {
  const section = usableSection(brief, 'access');
  if (!section) return null;
  return { summary: section.summary, findings: sectionFindings(section, EXECUTOR_CAPS.MAX_FINDINGS) };
}

function executeAttentionTriage(brief) {
  const section = usableSection(brief, 'attention');
  if (!section) return null;
  return { summary: section.summary, findings: sectionFindings(section, EXECUTOR_CAPS.MAX_FINDINGS) };
}

function executeHealthSnapshot(brief) {
  const section = usableSection(brief, 'health');
  if (!section) return null;
  return { summary: section.summary, findings: sectionFindings(section, EXECUTOR_CAPS.MAX_FINDINGS) };
}

function executeIntegrityReconcile(brief) {
  const section = usableSection(brief, 'integrity');
  if (!section) return null;
  return { summary: section.summary, findings: sectionFindings(section, EXECUTOR_CAPS.MAX_FINDINGS) };
}

function executeBriefCompose(brief) {
  const headline = typeof brief?.headline === 'string' && brief.headline ? brief.headline : null;
  if (!headline) return null;
  const risks = [];
  if (Array.isArray(brief.topRisks)) {
    for (const raw of brief.topRisks) {
      const clean = sanitizeFinding(raw);
      if (clean) risks.push(clean);
      if (risks.length >= EXECUTOR_CAPS.MAX_TOP_RISKS) break;
    }
  }
  return { summary: headline, findings: risks };
}

/**
 * Execute a declared read-only diagnostic plan.
 *
 * @param {object} request Untrusted input: only `{ actionId }`.
 * @param {object} context Server-supplied: `{ isAdmin, capability, unavailableSections }`.
 * @param {object} sources Server-supplied data: `{ brief }` (a `buildAdminBrief()` result).
 * @returns `executed` with bounded read-only data, or the fail-closed
 *   `blocked` / `unavailable` contract result. Never throws on malformed
 *   input; never exposes internal errors, commands, secrets, or stacks.
 */
export function executePlannedAction(request, context, sources) {
  // Gate 1: re-run contract validation server-side. Never trust a
  // client-supplied `planned` result — there is no plan input at all.
  const contract = validateActionRequest(request, context);
  if (!contract.ok) return contract;

  // Gate 2: resolve from the trusted registry by exact id. Caller ids that
  // are not declared actions cannot resolve, however well-formed.
  const action = getPlannedAction(contract.action.id);
  if (!action || action.sideEffects !== false) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'unknown-action',
      message: 'Unknown action id.',
      checks: checksFor({ authorization: false, capability: false, evidence: false })
    };
  }

  // Gate 3: required evidence must actually be present and usable in the
  // supplied brief — context claims alone are insufficient.
  const src = sources && typeof sources === 'object' ? sources : {};
  const brief = src.brief;
  const briefUnavailable = Array.isArray(brief?.unavailableSections) ? brief.unavailableSections : null;
  if (!brief || typeof brief !== 'object' || briefUnavailable === null) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'evidence-unavailable',
      message: 'Required evidence is currently unavailable.',
      checks: checksFor({ authorization: true, capability: true, evidence: false })
    };
  }
  const unavailableSet = new Set(briefUnavailable.map(name => String(name)));
  if (action.requiredEvidenceSections.some(section => unavailableSet.has(section))) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'evidence-unavailable',
      message: 'Required evidence is currently unavailable.',
      checks: checksFor({ authorization: true, capability: true, evidence: false })
    };
  }

  // Gate 4: explicit per-action dispatch. No generic runner exists —
  // an id without a dedicated handler cannot execute.
  let produced;
  try {
    switch (action.id) {
      case 'access.review-queue':
        produced = executeAccessReviewQueue(brief);
        break;
      case 'attention.triage':
        produced = executeAttentionTriage(brief);
        break;
      case 'health.snapshot':
        produced = executeHealthSnapshot(brief);
        break;
      case 'integrity.reconcile':
        produced = executeIntegrityReconcile(brief);
        break;
      case 'brief.compose':
        produced = executeBriefCompose(brief);
        break;
      default:
        produced = null;
    }
  } catch {
    produced = 'failed';
  }
  if (produced === 'failed') {
    return {
      ok: false,
      status: 'blocked',
      reason: 'execution-failed',
      message: 'The action could not be completed.',
      checks: checksFor({ authorization: true, capability: true, evidence: true })
    };
  }
  if (!produced) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'evidence-unavailable',
      message: 'Required evidence is currently unavailable.',
      checks: checksFor({ authorization: true, capability: true, evidence: false })
    };
  }

  const summary = truncateText(produced.summary, EXECUTOR_CAPS.MAX_SUMMARY_CHARS);
  return {
    ok: true,
    status: 'executed',
    actionId: action.id,
    label: action.label,
    summary,
    findings: produced.findings,
    evidenceRefs: collectRefs(produced.findings),
    checks: checksFor({ authorization: true, capability: true, evidence: true })
  };
}
