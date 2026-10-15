/**
 * Preflight/action-contract layer (declarative, no execution).
 *
 * Defines a small registry of read-only diagnostic action plans and a single
 * fail-closed validator. Actions are represented as `planned | blocked |
 * unavailable` — never as executable commands. There is no executor in this
 * codebase; a `planned` result is a validated plan description only.
 *
 * Validation order (deterministic, fail-closed):
 *   1. Malformed request        → `unavailable` / `invalid-request`
 *   2. Caller is not an admin   → `blocked` / `unauthorized`
 *      (checked before existence so unauthorized callers learn nothing
 *      about which action ids exist)
 *   3. Unknown action id        → `unavailable` / `unknown-action`
 *   4. Capability missing, mismatched, non-admin, or not read-only
 *                               → `blocked` / `capability-mismatch`
 *   5. Required evidence unavailable → `blocked` / `evidence-unavailable`
 *   6. All gates pass           → `planned` (plan only, no execution)
 *
 * Pure functions, zero imports, no I/O, no timers. All output bounded via
 * `ACTION_CAPS`. Callers supply the capability record and evidence
 * availability as plain data (a future router step wires the real registry).
 */

/** Hard caps for contract input/output. */
export const ACTION_CAPS = {
  MAX_ID_CHARS: 64,
  MAX_LABEL_CHARS: 80,
  MAX_DESCRIPTION_CHARS: 280,
  MAX_ACTIONS: 10,
  MAX_EVIDENCE_SECTIONS: 6
};

/** Evidence sections an action plan may require (mirrors the brief sections). */
export const ACTION_EVIDENCE_SECTIONS = ['access', 'attention', 'health', 'integrity', 'usage', 'notes'];

/**
 * Static action registry: read-only diagnostic plans only.
 * Every entry declares `sideEffects: false`; anything else is rejected
 * by validation even if somehow present.
 */
const REGISTRY = Object.freeze([
  Object.freeze({
    id: 'access.review-queue',
    label: 'Review pending access queue',
    description: 'Plan a review of pending and expiring access from the access overview.',
    category: 'access',
    capabilityId: 'access.overview',
    requiredEvidenceSections: Object.freeze(['access']),
    sideEffects: false
  }),
  Object.freeze({
    id: 'attention.triage',
    label: 'Triage discussions needing attention',
    description: 'Plan a triage pass over unanswered and hidden discussions.',
    category: 'attention',
    capabilityId: 'attention.discussions',
    requiredEvidenceSections: Object.freeze(['attention']),
    sideEffects: false
  }),
  Object.freeze({
    id: 'health.snapshot',
    label: 'Capture runtime health snapshot',
    description: 'Plan a read of the current runtime health indicators.',
    category: 'health',
    capabilityId: 'health.runtime',
    requiredEvidenceSections: Object.freeze(['health']),
    sideEffects: false
  }),
  Object.freeze({
    id: 'integrity.reconcile',
    label: 'Reconcile integrity diagnostics',
    description: 'Plan a review of integrity check results with admin evidence links.',
    category: 'integrity',
    capabilityId: 'integrity.diagnostics',
    requiredEvidenceSections: Object.freeze(['integrity']),
    sideEffects: false
  }),
  Object.freeze({
    id: 'brief.compose',
    label: 'Compose full admin brief plan',
    description: 'Plan a full brief read across every evidence section.',
    category: 'brief',
    capabilityId: 'access.overview',
    requiredEvidenceSections: Object.freeze(['access', 'attention', 'health', 'integrity', 'usage', 'notes']),
    sideEffects: false
  })
]);

const PLAN_ONLY_NOTE = 'Plan only. No execution capability exists.';

function cloneAction(entry) {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    category: entry.category,
    capabilityId: entry.capabilityId,
    requiredEvidenceSections: [...entry.requiredEvidenceSections],
    sideEffects: entry.sideEffects
  };
}

function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const name = String(item ?? '').trim().toLowerCase();
    if (!ACTION_EVIDENCE_SECTIONS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function checksFor(results) {
  return [
    { check: 'authorization', passed: results.authorization === true },
    { check: 'capability', passed: results.capability === true },
    { check: 'evidence', passed: results.evidence === true }
  ];
}

function blocked(reason, message, results) {
  return { ok: false, status: 'blocked', reason, message, checks: checksFor(results) };
}

function unavailable(reason, message) {
  return {
    ok: false,
    status: 'unavailable',
    reason,
    message,
    checks: checksFor({ authorization: false, capability: false, evidence: false })
  };
}

/** List every registered action plan (cloned, registry order). */
export function listPlannedActions() {
  return REGISTRY.map(cloneAction);
}

/** Fetch one action plan by exact id. Returns a clone or null. */
export function getPlannedAction(id) {
  if (typeof id !== 'string') return null;
  const found = REGISTRY.find(entry => entry.id === id);
  return found ? cloneAction(found) : null;
}

/**
 * Validate an action request against capability, authorization, and evidence.
 *
 * @param {object} request Untrusted input. Only `{ actionId: string }` is
 *   accepted; any other own-property (especially execution-like fields)
 *   makes the request invalid.
 * @param {object} context Server-supplied data:
 *   `{ isAdmin: boolean, capability: object|null, unavailableSections: string[] }`.
 *   `capability` must be the registry record for the action's `capabilityId`
 *   with `requires.admin === true` and `flags.readOnly === true`.
 * @returns A bounded `planned | blocked | unavailable` contract result.
 *   Never throws on malformed input; never returns executable content.
 */
export function validateActionRequest(request, context) {
  // 1. Malformed request → unavailable (fail closed, no further disclosure).
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return unavailable('invalid-request', 'Action request must be an object with an action id.');
  }
  // Only `{ actionId }` is accepted. Any extra own-property — benign or
  // execution-suggesting (`command`, `shell`, `url`, …) — fails closed.
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== 'actionId') {
    return unavailable('invalid-request', 'Action request must contain only an action id.');
  }
  const actionId = request.actionId;
  if (typeof actionId !== 'string') {
    return unavailable('invalid-request', 'Action id must be a string.');
  }
  const id = actionId.replace(/\s+/g, ' ').trim();
  if (!id || id.length > ACTION_CAPS.MAX_ID_CHARS) {
    return unavailable('invalid-request', 'Action id is missing or too long.');
  }
  // 2. Authorization before existence (no action-id oracle for non-admins).
  const ctx = context && typeof context === 'object' ? context : {};
  if (ctx.isAdmin !== true) {
    return blocked('unauthorized', 'Admin authorization is required.', {});
  }

  // 3. Unknown action → unavailable.
  const action = REGISTRY.find(entry => entry.id === id);
  if (!action) {
    return unavailable('unknown-action', 'Unknown action id.');
  }

  // 4. Capability must be the matching, admin-gated, read-only record.
  const capability = ctx.capability;
  if (
    !capability ||
    typeof capability !== 'object' ||
    capability.id !== action.capabilityId ||
    capability.requires?.admin !== true ||
    capability.flags?.readOnly !== true
  ) {
    return blocked('capability-mismatch', 'A matching read-only admin capability is required.', {
      authorization: true
    });
  }

  // 5. Every required evidence section must be available.
  const unavailableSet = new Set(normalizeSections(ctx.unavailableSections));
  const missing = action.requiredEvidenceSections.filter(section => unavailableSet.has(section));
  if (missing.length > 0) {
    return blocked('evidence-unavailable', `Required evidence unavailable: ${missing.join(', ')}.`, {
      authorization: true,
      capability: true
    });
  }

  // 6. All gates pass — still a plan, never an execution.
  return {
    ok: true,
    status: 'planned',
    action: cloneAction(action),
    checks: checksFor({ authorization: true, capability: true, evidence: true }),
    note: PLAN_ONLY_NOTE
  };
}
