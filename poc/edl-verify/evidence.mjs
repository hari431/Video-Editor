// poc/edl-verify/evidence.mjs — re-export shim (kept API-stable for the POC).
//
// The validator now lives in src/library/edl-evidence.js as the single rule
// source for both the POC harness and the Admin Video Editor integration.
// This module re-exports it under the original POC names so adapter.mjs,
// evidence-test.mjs, and all existing fixtures keep working unchanged — the
// POC remains a standalone harness that proves the production rules.
export {
  checkEdlEvidence as checkEdl,
  checkEvidenceEdge as checkEdge,
  EVIDENCE_EPS as EPS,
  EVIDENCE_SILENCE_PREFER_S as SILENCE_PREFER_S,
} from '../../src/library/edl-evidence.js';
