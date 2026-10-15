/**
 * Phase 5 Step 2 — Deterministic Admin Brief (read-only).
 *
 * Presentation only: consumes an evidence pack built by
 * `src/admin-assistant/evidence.js` (`buildAdminEvidencePack()`) and renders
 * a bounded Project Health / Admin Brief using fixed rules. No LLM/provider
 * calls, no routes, no UI, no DB access, no writes, no timers, no imports.
 *
 * Rules:
 * - Only states what the evidence contains; unknown statuses are quoted, not
 *   interpreted. Nothing is inferred beyond the pack.
 * - Every finding carries `evidenceRefs` (section + check/indicator identity
 *   + existing admin URL) so a future UI can expose "show evidence".
 * - `{ ok: false }` sections become `unavailable` findings, never silent gaps.
 * - Severity wording mirrors the existing Admin UI (`admin.ejs` Needs
 *   Attention badges; `admin-system.ejs` health badges), not new judgment.
 */

/** Hard caps for brief output. */
export const BRIEF_CAPS = {
  MAX_HEADLINE_CHARS: 280,
  MAX_SUMMARY_CHARS: 200,
  MAX_FINDINGS_PER_SECTION: 6,
  MAX_TOP_RISKS: 5,
  MAX_FINDING_CHARS: 200,
  MAX_REF_LABEL_CHARS: 120
};

const SECTION_ORDER = ['access', 'attention', 'health', 'integrity', 'usage', 'notes'];

const LEVEL_RANK = { critical: 3, warning: 2, info: 1 };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function ref(section, label, url, checkId = null) {
  const out = { section, label: truncateText(label || section, BRIEF_CAPS.MAX_REF_LABEL_CHARS) };
  if (checkId) out.checkId = String(checkId);
  if (url) out.url = String(url);
  return out;
}

function finding(id, severity, level, title, detail, evidenceRefs) {
  return {
    id: String(id),
    severity,
    level,
    title: truncateText(title, BRIEF_CAPS.MAX_FINDING_CHARS),
    detail: truncateText(detail, BRIEF_CAPS.MAX_FINDING_CHARS),
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : []
  };
}

function sectionResult(status, summary, findings = []) {
  return {
    status,
    summary: truncateText(summary, BRIEF_CAPS.MAX_SUMMARY_CHARS),
    findings: findings.slice(0, BRIEF_CAPS.MAX_FINDINGS_PER_SECTION)
  };
}

function unavailableSection(name, error) {
  return sectionResult('unavailable', `${labelFor(name)} unavailable.`, [
    finding(`${name}:unavailable`, 'unavailable', 'info', `${labelFor(name)} data unavailable`, String(error || 'Section failed to load.'), [
      ref(name, labelFor(name), urlFor(name))
    ])
  ]);
}

function labelFor(name) {
  return { access: 'Access overview', attention: 'Discussions needing attention', health: 'Runtime health', integrity: 'Integrity diagnostics', usage: 'Usage history', notes: 'Learner notes' }[name] || name;
}

function urlFor(name) {
  return {
    access: '/admin#users',
    attention: '/admin/discussions',
    health: '/admin/system',
    integrity: '/admin/system#integrity',
    usage: '/admin/system',
    notes: '/admin/learner-notes'
  }[name] || '/admin';
}

function summarizeAccess(section) {
  if (!section || section.ok !== true || !section.data || typeof section.data !== 'object') {
    return unavailableSection('access', section?.error);
  }
  const d = section.data;
  const total = num(d.total_users);
  const active = num(d.active_users);
  const pending = num(d.pending_users);
  const expiring = num(d.expiring_soon_users);
  const revoked = num(d.revoked_users);
  const findings = [];
  if (pending > 0) {
    findings.push(finding('access:pending', 'attention', 'warning', `${pending} pending access request(s)`, `${pending} user(s) waiting for approval.`, [ref('access', 'Admin users table', '/admin#users')]));
  }
  if (expiring > 0) {
    findings.push(finding('access:expiring', 'attention', 'warning', `${expiring} user(s) expiring within 7 days`, `${expiring} active user(s) expire within 7 days.`, [ref('access', 'Expiring users', '/admin/expiring-users')]));
  }
  if (revoked > 0) {
    findings.push(finding('access:revoked', 'attention', 'critical', `${revoked} revoked user(s) on record`, `${revoked} user(s) currently revoked.`, [ref('access', 'Admin users table', '/admin#users')]));
  }
  const status = findings.length ? 'attention' : 'healthy';
  return sectionResult(status, `Access: ${total} total user(s) (${active} active, ${pending} pending, ${expiring} expiring ≤7d, ${revoked} revoked).`, findings);
}

function summarizeAttention(section) {
  if (!section || section.ok !== true || !section.data || typeof section.data !== 'object' || !section.data.counts) {
    return unavailableSection('attention', section?.error);
  }
  const c = section.data.counts;
  const unanswered = num(c.unanswered_count);
  const hidden = num(c.hidden_questions_count) + num(c.hidden_replies_count);
  const findings = [];
  if (unanswered > 0) {
    findings.push(finding('attention:unanswered', 'attention', 'warning', `${unanswered} unanswered question(s)`, `${unanswered} visible question(s) have no visible replies.`, [ref('attention', 'Unanswered discussions', '/admin/discussions?filter=unanswered')]));
  }
  if (hidden > 0) {
    findings.push(finding('attention:hidden', 'attention', 'critical', `${hidden} hidden item(s) awaiting review`, `${hidden} hidden question(s)/replies(s) await review.`, [ref('attention', 'Hidden discussions', '/admin/discussions?filter=hidden')]));
  }
  const status = findings.length ? 'attention' : 'healthy';
  return sectionResult(status, `Discussions: ${unanswered} unanswered, ${hidden} hidden awaiting review.`, findings);
}

function summarizeHealth(section) {
  if (!section || section.ok !== true || !section.data || typeof section.data !== 'object' || !Array.isArray(section.data.indicators)) {
    return unavailableSection('health', section?.error);
  }
  const overall = String(section.data.overall || 'unknown');
  const indicators = section.data.indicators;
  const bad = indicators.filter(i => i && i.status !== 'healthy');
  const findings = bad.map(i => {
    const status = String(i.status || 'unknown');
    const level = status === 'critical' ? 'critical' : status === 'warning' ? 'warning' : 'info';
    return finding(`health:${String(i.name || 'indicator')}`, 'attention', level, `Runtime indicator "${i.name || 'unknown'}" is ${status}`, String(i.advisory || i.detail || `Status: ${status}.`), [
      ref('health', `Indicator: ${i.name || 'unknown'}`, '/admin/system')
    ]);
  });
  if (overall !== 'healthy' && overall !== 'warning' && overall !== 'critical') {
    return sectionResult('unavailable', `Runtime health reported unrecognized status "${overall}".`, [
      finding('health:unrecognized', 'unavailable', 'info', `Runtime health status "${overall}" not recognized`, 'Overall status was not healthy, warning, or critical.', [ref('health', 'Runtime health', '/admin/system')])
    ]);
  }
  const status = overall === 'healthy' ? 'healthy' : 'attention';
  return sectionResult(status, `Runtime health overall: ${overall} (${bad.length} of ${indicators.length} indicator(s) non-healthy).`, findings);
}

function summarizeIntegrity(section) {
  if (!section || section.ok !== true || !section.data || typeof section.data !== 'object' || !Array.isArray(section.data.checks)) {
    return unavailableSection('integrity', section?.error);
  }
  const checks = section.data.checks;
  const overall = String(section.data.overallStatus || 'unknown');
  if (!checks.length) {
    return sectionResult('unavailable', 'Integrity diagnostics returned no checks.', [
      finding('integrity:empty', 'unavailable', 'info', 'Integrity report empty', 'No diagnostic checks were returned.', [ref('integrity', 'Integrity diagnostics', '/admin/system#integrity')])
    ]);
  }
  const bad = checks.filter(c => c && c.status !== 'healthy');
  const rank = c => (c.status === 'critical' ? 0 : c.status === 'warning' ? 1 : 2);
  const findings = [...bad]
    .sort((a, b) => rank(a) - rank(b) || String(a.id || '').localeCompare(String(b.id || '')))
    .map(c => {
      const status = String(c.status || 'unknown');
      const level = status === 'critical' ? 'critical' : status === 'warning' ? 'warning' : 'info';
      return finding(`integrity:${String(c.id || 'check')}`, status === 'healthy' ? 'healthy' : 'attention', level, `"${c.title || c.id || 'Check'}" is ${status} (${num(c.count)} item(s))`, String(c.description || `Status: ${status}.`), [
        ref('integrity', `Check: ${c.title || c.id || 'unknown'}`, c.actionUrl || '/admin/system#integrity', c.id || null)
      ]);
    });
  if (overall !== 'healthy' && overall !== 'warning' && overall !== 'critical') {
    return sectionResult('unavailable', `Integrity diagnostics reported unrecognized status "${overall}".`, [
      finding('integrity:unrecognized', 'unavailable', 'info', `Integrity status "${overall}" not recognized`, 'Overall status was not healthy, warning, or critical.', [ref('integrity', 'Integrity diagnostics', '/admin/system#integrity')])
    ]);
  }
  const status = overall === 'healthy' ? 'healthy' : 'attention';
  const critical = checks.filter(c => c && c.status === 'critical').length;
  const warning = checks.filter(c => c && c.status === 'warning').length;
  return sectionResult(status, `Integrity: ${overall} across ${checks.length} check(s) (${critical} critical, ${warning} warning).`, findings);
}

function summarizeUsage(section) {
  if (!section || section.ok !== true || !Array.isArray(section.data)) {
    return unavailableSection('usage', section?.error);
  }
  if (!section.data.length) {
    return sectionResult('healthy', 'Usage history: no daily aggregates recorded yet.', []);
  }
  return sectionResult('healthy', `Usage history: ${section.data.length} day(s) of persisted aggregates available.`, []);
}

function summarizeNotes(section) {
  if (!section || section.ok !== true || !section.data || typeof section.data !== 'object') {
    return unavailableSection('notes', section?.error);
  }
  const total = num(section.data.total_notes);
  const learners = num(section.data.unique_learners);
  const questions = num(section.data.unique_questions);
  return sectionResult('healthy', `Learner notes: ${total} note(s) from ${learners} learner(s) across ${questions} question(s).`, []);
}

const SUMMARIZERS = {
  access: summarizeAccess,
  attention: summarizeAttention,
  health: summarizeHealth,
  integrity: summarizeIntegrity,
  usage: summarizeUsage,
  notes: summarizeNotes
};

/**
 * Build a deterministic brief from an evidence pack.
 * Pure function of `(pack, opts)` — same pack + same `opts.now` yields the
 * same brief. Never throws on malformed packs; unknown shapes become
 * `unavailable` sections.
 */
export function buildAdminBrief(pack, opts = {}) {
  const source = pack && typeof pack === 'object' ? pack : {};
  const sections = {};
  for (const name of SECTION_ORDER) {
    sections[name] = SUMMARIZERS[name](source[name]);
  }

  const attentionFindings = [];
  const unavailableSections = [];
  for (const name of SECTION_ORDER) {
    for (const f of sections[name].findings) {
      if (f.severity === 'attention') attentionFindings.push(f);
    }
    if (sections[name].status === 'unavailable') unavailableSections.push(name);
  }

  const overall = attentionFindings.length ? 'attention' : unavailableSections.length ? 'unavailable' : 'healthy';

  // Lightweight references: full detail lives in `sections`; topRisks only
  // points at it. Keeps total output bounded under adversarial packs.
  const topRisks = [...attentionFindings]
    .sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, BRIEF_CAPS.MAX_TOP_RISKS)
    .map(f => ({ id: f.id, title: f.title, level: f.level, evidenceRefs: f.evidenceRefs }));

  let headline;
  if (attentionFindings.length) {
    const titles = attentionFindings.slice(0, 3).map(f => f.title);
    const extra = attentionFindings.length > 3 ? ` (+${attentionFindings.length - 3} more)` : '';
    headline = `Attention needed: ${titles.join('; ')}${extra}`;
  } else if (unavailableSections.length) {
    headline = `Brief incomplete: ${unavailableSections.length} section(s) unavailable (${unavailableSections.join(', ')}). Shown states are evidence-based only.`;
  } else {
    headline = 'All available signals healthy.';
  }

  return {
    meta: {
      generatedAt: opts && opts.now ? String(opts.now) : new Date().toISOString(),
      readOnly: true,
      evidenceGeneratedAt: source.meta?.generatedAt || null
    },
    overall,
    headline: truncateText(headline, BRIEF_CAPS.MAX_HEADLINE_CHARS),
    sections,
    topRisks,
    unavailableSections
  };
}
