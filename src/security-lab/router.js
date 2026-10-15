/**
 * Security Lab API (Admin-only).
 *
 * Registers:
 *   GET  /api/admin/security-lab/tools[?q=&category=&riskLevel=&limit=]
 *   GET  /api/admin/security-lab/status (install state for the executable
 *     tools only — safe metadata, no commands or paths; rate-limited like
 *     execution because each request spawns version probes)
 *   POST /api/admin/security-lab/execute (per-tool adapters in
 *     `./executor.js`, no generic runner)
 *
 * Guards: `requireApiAuth` + `requireAdmin` on all three; `requireSameOrigin`
 * on POST (existing CSRF convention); per-user rate limit on the two
 * process-spawning endpoints. The executor re-checks admin ownership,
 * the registry allowlist, exact input schemas, scan-root confinement, and
 * target scope before spawning. No shell, no Docker, no sudo, no arbitrary
 * binaries or commands. Responses never carry argv, env, secrets, or
 * absolute server paths.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireApiAuth, requireAdmin, requireSameOrigin } from '../auth/middleware.js';
import { isAdminUser } from '../auth/admin.js';
import {
  SECURITY_LAB_CAPS,
  searchSecurityLabTools
} from './tool-registry.js';
import {
  SECURITY_LAB_EXEC_CAPS,
  runSecurityLabTool,
  getSecurityLabStatus
} from './executor.js';

/** Rate limits shared by the process-spawning endpoints. Exported for tests. */
export const SECURITY_LAB_API_LIMITS = {
  RATE_WINDOW_MS: 60_000,
  RATE_MAX_REQUESTS: 10,
  RATE_MAX_KEYS: 1000
};

// In-memory per-user buckets, lazily expired and size-capped. No timers.
const executeRateBuckets = new Map();

/** Test seam: clear execution rate-limit state between tests. */
export function resetSecurityLabRateLimits() {
  executeRateBuckets.clear();
}

function checkExecuteRateLimit(key) {
  const now = Date.now();
  if (executeRateBuckets.size >= SECURITY_LAB_API_LIMITS.RATE_MAX_KEYS) {
    const oldest = executeRateBuckets.keys().next().value;
    if (oldest !== undefined) executeRateBuckets.delete(oldest);
  }
  const bucket = executeRateBuckets.get(key);
  if (!bucket || now - bucket.start >= SECURITY_LAB_API_LIMITS.RATE_WINDOW_MS) {
    executeRateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  if (bucket.count >= SECURITY_LAB_API_LIMITS.RATE_MAX_REQUESTS) return false;
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

// Project root: `src/security-lab/` is two levels below it.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED_QUERY_KEYS = new Set(['q', 'category', 'riskLevel', 'limit']);

function toSafeTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    description: tool.description,
    sourceUrl: tool.sourceUrl,
    platforms: [...tool.platforms],
    riskLevel: tool.riskLevel,
    executionAllowed: tool.executionAllowed === true,
    readOnly: true
  };
}

/** GET handler: bounded, deterministic, fail-closed tool listing. */
export function handleSecurityLabTools(req, res) {
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      return res.status(400).json({ ok: false, error: 'Unknown query parameter.' });
    }
  }
  let result;
  try {
    result = searchSecurityLabTools({
      q: query.q,
      category: query.category,
      riskLevel: query.riskLevel,
      limit: query.limit
    });
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }
  const tools = result.tools.map(toSafeTool);
  if (tools.length > SECURITY_LAB_CAPS.MAX_RESULTS) {
    return res.status(500).json({ ok: false, error: 'unavailable' });
  }
  return res.json({ ok: true, count: tools.length, tools });
}

/**
 * POST handler: run one allowlisted tool (`{ toolId, input }` and nothing
 * else). Validation failures are 400/422 with fixed messages; executed
 * outcomes (success, failure, timeout, not-installed) are 200 payloads.
 */
export async function handleSecurityLabExecute(req, res) {
  if (!checkExecuteRateLimit(rateKeyFor(req))) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again shortly.' });
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) {
    return res.status(400).json({ ok: false, error: 'Request body must be an object with a tool id and input.' });
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('toolId') || !keys.includes('input')) {
    return res.status(400).json({ ok: false, error: 'Request body must contain only a tool id and input.' });
  }
  let result;
  try {
    result = await runSecurityLabTool(
      { toolId: body.toolId, input: body.input },
      { isAdmin: isAdminUser(req.user) === true },
      { root: PROJECT_ROOT }
    );
  } catch {
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
  if (result.status === 'blocked' && result.reason === 'unauthorized') {
    return res.status(403).json({ ok: false, error: result.message });
  }
  if (result.status === 'blocked') {
    return res.status(422).json({ ok: false, error: result.message, reason: result.reason });
  }
  if (result.status === 'unavailable') {
    return res.status(400).json({ ok: false, error: result.message, reason: result.reason });
  }
  if (typeof result.stdout === 'string' && result.stdout.length > SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS) {
    return res.status(500).json({ ok: false, error: 'unavailable' });
  }
  return res.json({ ok: result.ok, result });
}

/**
 * GET handler: install/readiness state for the executable tools only.
 * Safe metadata per tool (`toolId`, `executionAllowed`, `installed`,
 * `status`, optional `version`) — no paths, env, commands, argv, stderr,
 * or secrets. Unknown query keys fail closed with 400.
 */
export async function handleSecurityLabStatus(req, res) {
  if (!checkExecuteRateLimit(rateKeyFor(req))) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again shortly.' });
  }
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  if (Object.keys(query).length > 0) {
    return res.status(400).json({ ok: false, error: 'Unknown query parameter.' });
  }
  let status;
  try {
    status = await getSecurityLabStatus();
  } catch {
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
  if (!status || status.ok !== true || !Array.isArray(status.tools)) {
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
  return res.json(status);
}

/** Register the endpoints on the app. Called once from `src/server.js`. */
export function registerSecurityLabRoutes(app) {
  app.get('/api/admin/security-lab/tools', requireApiAuth, requireAdmin, handleSecurityLabTools);
  app.get('/api/admin/security-lab/status', requireApiAuth, requireAdmin, handleSecurityLabStatus);
  app.post('/api/admin/security-lab/execute', requireApiAuth, requireAdmin, requireSameOrigin, handleSecurityLabExecute);
}
