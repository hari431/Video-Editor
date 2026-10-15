/**
 * Phase 5 Step 3 — Deterministic admin query layer (read-only).
 *
 * Pure functions over an already-built brief (`buildAdminBrief()` output).
 * An explicit allowlist maps questions to intents; anything outside the
 * allowlist returns `unsupported` instead of guessing. No SQL, no filesystem,
 * no shell, no retrieval beyond the brief, no LLM. Zero imports.
 */

/** Bounds for query handling. */
export const QUERY_CAPS = {
  MAX_QUESTION_CHARS: 500,
  MAX_ANSWER_CHARS: 1000,
  MAX_FINDINGS: 6,
  MAX_EVIDENCE_REFS: 12
};

/**
 * Explicit allowlist of supported intents, most specific first.
 * Each intent names the brief section(s) it may read.
 */
export const SUPPORTED_INTENTS = [
  {
    intent: 'brief',
    label: 'Project health summary',
    patterns: [/brief|overall|project health|how is .* (site|system|project|doing)|status overview|anything (wrong|need attention)/]
  },
  {
    intent: 'pending',
    label: 'Pending access requests',
    patterns: [/pending|awaiting approval|access request|approve|approval queue/]
  },
  {
    intent: 'expiring',
    label: 'Expiring user access',
    patterns: [/expir|expiry|expiring|renew|about to expire/]
  },
  {
    intent: 'integrity',
    label: 'Integrity diagnostics',
    patterns: [/integrity|diagnostic|entitlement|inconsisten|reconcil|paid product|missing role|orphan/]
  },
  {
    intent: 'discussions',
    label: 'Discussions needing attention',
    patterns: [/discussion|unanswered|hidden|moderation|question.*(answer|review)/]
  },
  {
    intent: 'usage',
    label: 'Usage history',
    patterns: [/usage|traffic|requests|history|metrics|views|downloads/]
  },
  {
    intent: 'notes',
    label: 'Learner notes',
    patterns: [/learner note|notes stats|study notes/]
  },
  {
    intent: 'users',
    label: 'User access overview',
    patterns: [/users?|revoked|active .*user|who has access|accounts?/]
  }
];

/** Validate the raw question. Returns `{ ok, question }` or `{ ok:false, error }`. */
export function validateAdminQuestion(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Question must be a string.' };
  }
  const question = value.replace(/\s+/g, ' ').trim();
  if (!question) {
    return { ok: false, error: 'Question is required.' };
  }
  if (question.length > QUERY_CAPS.MAX_QUESTION_CHARS) {
    return { ok: false, error: `Question exceeds the maximum length of ${QUERY_CAPS.MAX_QUESTION_CHARS} characters.` };
  }
  return { ok: true, question };
}

/** Match a validated question against the allowlist. Returns the intent entry or null. */
export function matchAdminIntent(question) {
  const text = String(question || '').toLowerCase();
  for (const entry of SUPPORTED_INTENTS) {
    if (entry.patterns.some(re => re.test(text))) return entry;
  }
  return null;
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function sectionFindings(brief, names) {
  const out = [];
  for (const name of names) {
    const findings = brief?.sections?.[name]?.findings;
    if (Array.isArray(findings)) out.push(...findings);
  }
  return out.slice(0, QUERY_CAPS.MAX_FINDINGS);
}

function evidenceRefsOf(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    for (const r of f?.evidenceRefs || []) {
      const key = `${r.section}|${r.checkId || ''}|${r.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= QUERY_CAPS.MAX_EVIDENCE_REFS) return out;
    }
  }
  return out;
}

function sectionSummary(brief, name, fallback) {
  const summary = brief?.sections?.[name]?.summary;
  return typeof summary === 'string' && summary ? summary : fallback;
}

/**
 * Answer a validated question deterministically from the brief.
 * Returns `{ ok:true, intent, answer, findings, evidenceRefs }`,
 * `{ ok:false, error:'unsupported', supported }`, or
 * `{ ok:false, error:'unavailable' }` when the brief itself is unusable.
 */
export function answerAdminQuery(question, brief) {
  const entry = matchAdminIntent(question);
  if (!entry) {
    return {
      ok: false,
      error: 'unsupported',
      message: 'This question is outside the supported admin topics. No answer was generated.',
      supported: SUPPORTED_INTENTS.map(e => e.label)
    };
  }
  if (!brief || typeof brief !== 'object' || !brief.sections) {
    return { ok: false, error: 'unavailable', message: 'Admin evidence is currently unavailable.' };
  }

  let answer;
  let findings;
  switch (entry.intent) {
    case 'brief': {
      const titles = (brief.topRisks || []).slice(0, 3).map(r => r.title).filter(Boolean);
      answer = titles.length
        ? `${brief.headline} Top risks: ${titles.join('; ')}.`
        : String(brief.headline || 'Brief unavailable.');
      findings = (brief.topRisks || [])
        .slice(0, QUERY_CAPS.MAX_FINDINGS)
        .map(r => ({ id: r.id, title: r.title, level: r.level, evidenceRefs: r.evidenceRefs || [] }));
      break;
    }
    case 'pending':
    case 'users':
    case 'expiring': {
      answer = sectionSummary(brief, 'access', 'Access overview unavailable.');
      findings = sectionFindings(brief, ['access']);
      break;
    }
    case 'integrity': {
      answer = sectionSummary(brief, 'integrity', 'Integrity diagnostics unavailable.');
      findings = sectionFindings(brief, ['integrity']);
      break;
    }
    case 'discussions': {
      answer = sectionSummary(brief, 'attention', 'Discussion attention data unavailable.');
      findings = sectionFindings(brief, ['attention']);
      break;
    }
    case 'usage': {
      answer = sectionSummary(brief, 'usage', 'Usage history unavailable.');
      findings = [];
      break;
    }
    case 'notes': {
      answer = sectionSummary(brief, 'notes', 'Learner notes data unavailable.');
      findings = [];
      break;
    }
    default: {
      return {
        ok: false,
        error: 'unsupported',
        message: 'This question is outside the supported admin topics. No answer was generated.',
        supported: SUPPORTED_INTENTS.map(e => e.label)
      };
    }
  }

  return {
    ok: true,
    intent: entry.intent,
    answer: truncateText(answer, QUERY_CAPS.MAX_ANSWER_CHARS),
    findings,
    evidenceRefs: evidenceRefsOf(findings)
  };
}
