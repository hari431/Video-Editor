/**
 * Phase 5 Step 3 — Admin Assistant API routes (read-only, admin-only).
 *
 * Exposes the deterministic evidence/brief pipeline over four endpoints:
 *   GET  /api/admin/assistant/brief
 *   GET  /api/admin/assistant/capabilities
 *   POST /api/admin/assistant/query
 *   POST /api/admin/assistant/execute (5 declared read-only plans only)
 *
 * Guards: `requireApiAuth` + `requireAdmin` on both; `requireSameOrigin` on
 * POST (existing CSRF convention). Bounded input (500-char questions,
 * Express 100kb JSON limit), per-user in-memory rate limit with lazy expiry
 * (no timers, no dependencies), redacted errors. Timeouts reuse the app-wide
 * 15s request timeout (`src/server.js`). No writes, no SQL tools.
 *
 * Step 5 LLM: when `ADMIN_ASSISTANT_LLM_ENABLED=true` with a provider + key,
 * a successful deterministic answer may be verbalized by the model (see
 * `./provider.js` — brief/evidence only, key server-side). Otherwise the
 * deterministic answer is returned unchanged. Failures fall back to the
 * deterministic answer with a static note. Browser-supplied provider fields
 * remain rejected.
 */
import { buildAdminEvidencePack } from './evidence.js';
import { buildAdminBrief } from './brief.js';
import { getAdminCapability, listAdminCapabilities, preflightAdminCapabilities } from './capabilities.js';
import { getPlannedAction } from './actions.js';
import { executePlannedAction } from './executor.js';
import { validateAdminQuestion, answerAdminQuery } from './query.js';
import { generateAdminAnswer, getAdminLlmConfig, redactAdminLlmError, LLM_FALLBACK_NOTE } from './provider.js';
import { requireApiAuth, requireAdmin, requireSameOrigin } from '../auth/middleware.js';
import { isAdminUser } from '../auth/admin.js';
import { composeDigest } from '../nanobot/digest.js';
import { searchLibraryTool } from '../nanobot/mcp-bridge.js';
import { readQueryLibrary } from '../library/local.js';
import { buildTree } from '../library/tree.js';

/** API bounds. Exported for tests. */
export const ASSISTANT_API_LIMITS = {
  RATE_WINDOW_MS: 60_000,
  RATE_MAX_REQUESTS: 30,
  RATE_MAX_KEYS: 1000
};

// In-memory per-user buckets, lazily expired and size-capped. No timers.
const rateBuckets = new Map();

/** Test seam: clear rate-limit state between tests. */
export function resetAssistantRateLimits() {
  rateBuckets.clear();
}

function checkRateLimit(key) {
  const now = Date.now();
  if (rateBuckets.size >= ASSISTANT_API_LIMITS.RATE_MAX_KEYS) {
    const oldest = rateBuckets.keys().next().value;
    if (oldest !== undefined) rateBuckets.delete(oldest);
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= ASSISTANT_API_LIMITS.RATE_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  if (bucket.count >= ASSISTANT_API_LIMITS.RATE_MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

function rateKeyFor(req) {
  const id = req?.user?.id;
  if (id !== undefined && id !== null && String(id) !== '') return `id:${String(id)}`;
  const email = req?.user?.email;
  if (email) return `email:${String(email).toLowerCase()}`;
  return 'anonymous';
}

async function buildAssistantBrief() {
  const pack = await buildAdminEvidencePack();
  return buildAdminBrief(pack);
}

// Intent -> brief section(s) whose summaries may accompany the findings.
// Mirrors the allowlist in `./query.js`; unknown intents contribute nothing.
const INTENT_SECTIONS = {
  pending: ['access'],
  expiring: ['access'],
  users: ['access'],
  integrity: ['integrity'],
  discussions: ['attention'],
  usage: ['usage'],
  notes: ['notes']
};

function summaryForIntent(brief, intent) {
  if (intent === 'brief') return '';
  const names = INTENT_SECTIONS[intent] || [];
  return names
    .map(name => brief?.sections?.[name]?.summary)
    .filter(text => typeof text === 'string' && text)
    .join(' ');
}

export async function handleAssistantBrief(_req, res) {
  try {
    const brief = await buildAssistantBrief();
    return res.json({ ok: true, brief });
  } catch {
    return res.status(500).json({ ok: false, error: 'Unable to build admin brief.' });
  }
}

const NANOBOT_DIGEST_LIBRARY_QUERY_CAP = 3;
const NANOBOT_DIGEST_LIBRARY_RESULT_CAP = 5;

function digestLibraryQueries(brief, evidencePack) {
  const queries = [];
  const seen = new Set();
  const add = value => {
    const query = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  // Prefer the actual sanitized discussion/question titles from the evidence
  // pack. These are much more specific library-search anchors than aggregate
  // labels such as "2 unanswered question(s)", while remaining author-free.
  const unanswered = evidencePack?.attention?.data?.unansweredList;
  if (Array.isArray(unanswered)) {
    for (const row of unanswered) {
      add(row?.title);
      if (queries.length >= NANOBOT_DIGEST_LIBRARY_QUERY_CAP) break;
    }
  }

  // Fall back to critical/warning brief findings only when no usable
  // discussion titles were available. Do not pad real question queries with
  // aggregate labels such as "2 unanswered question(s)" because that reduces
  // retrieval relevance.
  if (!queries.length) {
    for (const section of Object.values(brief?.sections || {})) {
      for (const finding of Array.isArray(section?.findings) ? section.findings : []) {
        if (finding?.level === 'critical' || finding?.level === 'warning') add(finding.title);
        if (queries.length >= NANOBOT_DIGEST_LIBRARY_QUERY_CAP) break;
      }
      if (queries.length >= NANOBOT_DIGEST_LIBRARY_QUERY_CAP) break;
    }
  }

  // When no admin finding yields a usable query, run no library search:
  // digest items come from the brief alone and supporting context stays
  // empty (recorded as `library-search` unavailable) rather than padding
  // with unrelated raw results.
  return queries.slice(0, NANOBOT_DIGEST_LIBRARY_QUERY_CAP);
}

function digestQuestionSourcePaths(evidencePack) {
  const paths = new Set();
  const unanswered = evidencePack?.attention?.data?.unansweredList;
  if (!Array.isArray(unanswered)) return paths;

  for (const row of unanswered) {
    const itemPath = String(row?.item_path || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
    const title = String(row?.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (itemPath) {
      paths.add(itemPath);
      const base = itemPath.slice(itemPath.lastIndexOf('/') + 1);
      if (base) paths.add(base);
    }
    if (title) paths.add(title);
  }
  return paths;
}

function isDigestQuestionSource(row, excludedPaths) {
  if (!row || !excludedPaths?.size) return false;
  const path = String(row.path || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
  const title = String(row.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (path && excludedPaths.has(path)) return true;
  if (title && excludedPaths.has(title)) return true;

  // Also protect against a library result exposing the same source with a
  // different display title: compare the path basename with the question title.
  if (path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (excludedPaths.has(base)) return true;
  }
  return false;
}

export async function buildNanobotDigestLibraryEvidence({ brief, evidencePack, user, tree, searchTool = searchLibraryTool } = {}) {
  if (!brief || !user || !tree) return [];
  const results = [];
  const seenPaths = new Set();
  const excludedQuestionSources = digestQuestionSourcePaths(evidencePack);

  for (const query of digestLibraryQueries(brief, evidencePack)) {
    let response;
    try {
      response = await searchTool({ query, topK: NANOBOT_DIGEST_LIBRARY_RESULT_CAP, user, tree });
    } catch {
      continue;
    }
    if (response?.ok !== true || !Array.isArray(response.results)) continue;
    for (const row of response.results) {
      if (isDigestQuestionSource(row, excludedQuestionSources)) continue;
      const key = String(row?.path || '').toLowerCase();
      if (!key || seenPaths.has(key)) continue;
      seenPaths.add(key);
      results.push(row);
      if (results.length >= NANOBOT_DIGEST_LIBRARY_RESULT_CAP) return results;
    }
  }

  return results;
}

export function filterNanobotDigestQuestionItems(digest, evidencePack) {
  if (!digest) return digest;
  const questionSources = new Set();
  for (const row of evidencePack?.attention?.data?.unansweredList || []) {
    const title = String(row?.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const itemPath = String(row?.item_path || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
    if (title) questionSources.add(title);
    if (itemPath) questionSources.add(itemPath);
    if (itemPath) {
      const base = itemPath.slice(itemPath.lastIndexOf('/') + 1);
      if (base) questionSources.add(base);
    }
  }
  if (!questionSources.size) return digest;

  const isQuestionRef = value => {
    const path = String(value || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!path) return false;
    const base = path.slice(path.lastIndexOf('/') + 1);
    return questionSources.has(path) || (base && questionSources.has(base));
  };

  if (Array.isArray(digest.items)) {
    digest.items = digest.items.filter(item => {
      const title = String(item?.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const refs = Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [];
      const refMatches = refs.some(ref => isQuestionRef(ref?.path));
      return !questionSources.has(title) && !refMatches;
    });
    digest.itemCount = digest.items.length;
    digest.fullyCited = digest.items.length > 0;
  }

  // Supporting context is internal only (never automatic items): drop the
  // question source itself while retaining other supporting rows.
  if (Array.isArray(digest.supportingEvidence)) {
    digest.supportingEvidence = digest.supportingEvidence.filter(row => {
      if (isQuestionRef(row?.path)) return false;
      const title = String(row?.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return !questionSources.has(title);
    });
    digest.supportingCount = digest.supportingEvidence.length;
  }
  return digest;
}

export async function handleNanobotDigest(req, res) {
  try {
    const pack = await buildAdminEvidencePack();
    const brief = buildAdminBrief(pack);

    // Reuse the same library tree/search path as the existing MCP bridge.
    // The digest remains server-side Admin/Owner protected by the route guards.
    const library = await readQueryLibrary();
    const tree = buildTree(
      library.files,
      library.videos,
      library.folders,
      library.items || []
    );
    const searchResults = await buildNanobotDigestLibraryEvidence({
      brief,
      evidencePack: pack,
      user: req.user,
      tree
    });

    // The unanswered discussion title is also the retrieval query. Keep the
    // exact query strings in the final exclusion set so a search result that
    // represents the question itself cannot re-enter the digest under a
    // different path/title representation.
    const excludedPaths = digestQuestionSourcePaths(pack);
    for (const row of pack?.attention?.data?.unansweredList || []) {
      const query = String(row?.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (query) excludedPaths.add(query);
    }

    const result = composeDigest({
      brief,
      searchResults,
      excludedPaths
    });

    // Final response boundary: never allow an unanswered discussion title to
    // surface as a library evidence item, even if an upstream search result
    // changes its path/title representation.
    filterNanobotDigestQuestionItems(result.digest, pack);
    return res.json(result);
  } catch {
    return res.status(503).json({ ok: false, error: 'Nanobot digest is currently unavailable.' });
  }
}

export async function handleAssistantQuery(req, res) {
  if (!checkRateLimit(rateKeyFor(req))) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again shortly.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // LLM/provider path is not implemented in Phase 5: reject explicitly.
  if (body.provider !== undefined || body.model !== undefined || body.api_key !== undefined || body.apiKey !== undefined) {
    return res.status(400).json({ ok: false, error: 'AI-assisted answers are disabled.' });
  }
  const validated = validateAdminQuestion(body.question);
  if (!validated.ok) {
    return res.status(400).json({ ok: false, error: validated.error });
  }
  let brief;
  try {
    brief = await buildAssistantBrief();
  } catch {
    return res.status(503).json({ ok: false, error: 'unavailable', message: 'Admin evidence is currently unavailable.' });
  }
  const result = answerAdminQuery(validated.question, brief);
  if (!result.ok && result.error === 'unsupported') {
    return res.status(422).json(result);
  }
  if (!result.ok) {
    return res.status(503).json(result);
  }
  // Controlled LLM enhancement: deterministic findings/refs always win.
  // Disabled/unconfigured -> deterministic answer unchanged. Any provider
  // failure -> deterministic answer + static note (never error internals).
  const llmConfig = getAdminLlmConfig();
  if (!llmConfig.configured) {
    return res.json({ ok: true, ...result, assistance: 'deterministic' });
  }
  try {
    const text = await generateAdminAnswer({
      question: validated.question,
      headline: brief.headline,
      summary: summaryForIntent(brief, result.intent),
      findings: result.findings
    });
    return res.json({ ok: true, ...result, answer: text, assistance: 'llm', provider: llmConfig.provider });
  } catch (error) {
    try {
      console.error(`[admin-assistant] LLM failed: ${redactAdminLlmError(error)}`);
    } catch {}
    return res.json({ ok: true, ...result, answer: `${result.answer}${LLM_FALLBACK_NOTE}`, assistance: 'deterministic-fallback' });
  }
}

function isSafeCapabilityUrl(url) {
  return typeof url === 'string' && /^\/admin([#?/]|$)/.test(url);
}

/**
 * Step 2 — Read-only capability/status view over the Step 1 registry.
 *
 * No execution: returns only the safe metadata already declared in
 * `./capabilities.js` (id, label, description, category) plus a `readOnly`
 * flag, per-capability availability derived from the brief's
 * `unavailableSections`, and the overall `ready|partial|blocked` preflight.
 * Same guards as the brief endpoint; failures become 503, never internals.
 */
export async function handleAssistantCapabilities(_req, res) {
  let brief;
  try {
    brief = await buildAssistantBrief();
  } catch {
    return res.status(503).json({ ok: false, error: 'unavailable', message: 'Admin evidence is currently unavailable.' });
  }
  const unavailableSections = Array.isArray(brief?.unavailableSections) ? brief.unavailableSections : [];
  const preflight = preflightAdminCapabilities({ unavailableSections });
  const unavailableSet = new Set(preflight.unavailable);
  const capabilities = [];
  for (const entry of listAdminCapabilities()) {
    if (unavailableSet.has(entry.evidenceSection)) {
      capabilities.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        readOnly: true,
        available: false,
        ...(isSafeCapabilityUrl(entry.adminUrl) ? { url: entry.adminUrl } : {})
      });
    } else {
      capabilities.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        readOnly: true,
        available: true,
        ...(isSafeCapabilityUrl(entry.adminUrl) ? { url: entry.adminUrl } : {})
      });
    }
    if (capabilities.length >= 25) break;
  }
  return res.json({
    ok: true,
    preflight: { status: preflight.status, summary: preflight.summary, unavailable: preflight.unavailable },
    capabilities
  });
}

/**
 * Step 5 — Execute one declared read-only diagnostic plan.
 *
 * Accepts only `{ actionId }`. The id must resolve in the trusted
 * `./actions.js` registry — capability ids, unknown ids, and any extra
 * fields fail closed. Authorization (`isAdminUser`), the capability record,
 * and evidence sources are all server-owned: the brief is rebuilt here and
 * `executePlannedAction()` re-validates everything immediately before its
 * explicit per-action handler runs. A client-supplied `planned` result is
 * structurally unusable (no plan input exists). Failures keep the
 * executor's generic messages and statuses, mapped to HTTP codes below.
 */
export async function handleAssistantExecute(req, res) {
  if (!checkRateLimit(rateKeyFor(req))) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again shortly.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) {
    return res.status(400).json({ ok: false, error: 'Request body must be an object with an action id.' });
  }
  // Accept only `{ actionId }` — extra fields fail closed here and again
  // inside the executor. They are never forwarded, stripped, or interpreted.
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'actionId') {
    return res.status(400).json({ ok: false, error: 'Request body must contain only an action id.' });
  }
  let brief;
  try {
    brief = await buildAssistantBrief();
  } catch {
    return res.status(503).json({ ok: false, error: 'unavailable', message: 'Admin evidence is currently unavailable.' });
  }
  const rawId = typeof body.actionId === 'string' ? body.actionId.replace(/\s+/g, ' ').trim() : null;
  const plan = rawId ? getPlannedAction(rawId) : null;
  const capability = plan ? getAdminCapability(plan.capabilityId) : null;
  const result = executePlannedAction({ actionId: body.actionId }, {
    isAdmin: isAdminUser(req.user) === true,
    capability,
    unavailableSections: Array.isArray(brief?.unavailableSections) ? brief.unavailableSections : []
  }, { brief });

  if (result.ok) {
    return res.json({ ok: true, ...result });
  }
  if (result.status === 'unavailable' && result.reason === 'unknown-action') {
    return res.status(422).json({ ok: false, ...result });
  }
  if (result.status === 'unavailable') {
    return res.status(400).json({ ok: false, ...result });
  }
  if (result.status === 'blocked' && result.reason === 'unauthorized') {
    return res.status(403).json({ ok: false, ...result });
  }
  return res.status(503).json({ ok: false, ...result });
}

/** Register the endpoints on the app. Called once from `src/server.js`. */
export function registerAdminAssistantRoutes(app) {
  app.get('/api/admin/assistant/brief', requireApiAuth, requireAdmin, handleAssistantBrief);
  app.get('/api/admin/assistant/capabilities', requireApiAuth, requireAdmin, handleAssistantCapabilities);
  app.get('/api/admin/nanobot/digest', requireApiAuth, requireAdmin, handleNanobotDigest);
  app.post('/api/admin/assistant/query', requireApiAuth, requireAdmin, requireSameOrigin, handleAssistantQuery);
  app.post('/api/admin/assistant/execute', requireApiAuth, requireAdmin, requireSameOrigin, handleAssistantExecute);
}
