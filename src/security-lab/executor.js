/**
 * Step 3 + Step 6 + Step 7 + Step 8 — Controlled execution for exactly
 * eleven allowlisted tools: gitleaks, trivy, httpx, binwalk, subfinder,
 * theharvester, amass, testssl, wafw00f, gobuster, dirsearch.
 * Admin-only via the router in `./router.js`.
 *
 * This is NOT a generic runner. There is no `exec(command)`, no
 * user-supplied command string, no shell interpolation, no Docker, no sudo,
 * no privilege escalation, no arbitrary binaries, and no arbitrary flags:
 *
 * - Each tool has an explicit input schema (exact keys, string types,
 *   length caps). Unknown fields and malformed input are rejected before
 *   anything runs.
 * - Each tool has an explicit adapter that builds a FIXED argv array from
 *   validated values only. The only variable argv element is the validated
 *   scan path or target, passed as a single argv item (never interpolated).
 * - Processes spawn via `execFile` (no shell) with a binary allowlist, a
 *   process timeout, and a bounded buffer. Stdout/stderr are truncated.
 * - The execution gate is fail-closed: the tool id must have an adapter
 *   AND the registry must explicitly allow it (`isSecurityLabExecutionAllowed`)
 *   AND the caller must be an admin. Anything else never spawns.
 * - Results are normalized to success | failure | timeout | not-installed.
 *   Errors are fixed templates: no environment variables, no secrets, no
 *   raw command lines, no absolute server paths (the scan root is replaced
 *   with `[scan-root]` in tool output).
 *
 * Scope rules enforced here:
 * - gitleaks/trivy/binwalk scan only repo-relative paths confined to the
 *   permitted scan roots (`queries`, `src`) with traversal, absolute-path,
 *   drive, UNC, symlink-escape, and existence checks. This keeps scans away
 *   from server secrets such as the project `.env` or `.git` directory.
 *   binwalk runs analysis only (no extraction flags).
 * - httpx accepts exactly one validated target: a public hostname or IP
 *   literal. No schemes, ports, paths, queries, userinfo, whitespace, or
 *   non-public/loopback/link-local addresses.
 * - subfinder/theharvester/amass accept exactly one validated domain: a
 *   public hostname with a dot (no IP literals, ports, schemes, or paths).
 *   subfinder runs passive sources only (no active resolution); theHarvester
 *   runs keyless P0 passive sources only (`crtsh,certspotter`, no DNS
 *   brute-force, resolution, takeover, or report-file options); amass runs
 *   the single `enum -d` mode only (no intel/viz/db modes or extra flags).
 * - testssl/wafw00f accept exactly one validated target (public hostname or
 *   IP literal, same model as httpx): testssl checks the default TLS port
 *   with no cipher/scan options; wafw00f fingerprints with no extra
 *   options. Schemes and ports are rejected by validation, so both tools
 *   receive a bare host and negotiate HTTP/HTTPS themselves.
 * - gobuster/dirsearch accept exactly one validated target (same model):
 *   the adapter builds a single `http://` URL from the bare host (bracketed
 *   for IPv6) — schemes, ports, and paths can never reach argv. gobuster
 *   runs `dir` mode only, at 10 threads, quiet, with a 10s tool timeout and
 *   the server-bundled wordlist (`wordlists/gobuster-common.txt`, fixed
 *   entries, existence-checked before spawn; no user wordlists, no
 *   extensions, no recursion flags — dir mode does not recurse). dirsearch
 *   runs its default non-recursive scan with its built-in wordlist at 20
 *   threads (no `-r`, no custom wordlist, no report-file flags).
 */
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as nodeFs } from 'node:fs';
import { isSecurityLabExecutionAllowed } from './tool-registry.js';

/** Bounds for execution input/output. Exported for tests. */
export const SECURITY_LAB_EXEC_CAPS = {
  TIMEOUT_MS: 30_000,
  MIN_TIMEOUT_MS: 1_000,
  MAX_TIMEOUT_MS: 120_000,
  MAX_BUFFER_BYTES: 1_000_000,
  MAX_STDOUT_CHARS: 8000,
  MAX_STDERR_CHARS: 2000,
  MAX_TARGET_CHARS: 253,
  MAX_PATH_CHARS: 512
};

/**
 * Clamp an injected timeout into the supported window. A zero/negative
 * timeout would disable the kill timer and an unbounded one would defer
 * it; both fail toward the fixed default instead.
 */
function clampTimeoutMs(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  if (value < SECURITY_LAB_EXEC_CAPS.MIN_TIMEOUT_MS) return SECURITY_LAB_EXEC_CAPS.MIN_TIMEOUT_MS;
  if (value > SECURITY_LAB_EXEC_CAPS.MAX_TIMEOUT_MS) return SECURITY_LAB_EXEC_CAPS.MAX_TIMEOUT_MS;
  return value;
}

/** Tools with an explicit adapter. Nothing else can execute. */
export const SECURITY_LAB_EXECUTABLE_TOOLS = ['gitleaks', 'trivy', 'httpx', 'binwalk', 'subfinder', 'theharvester', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch'];

/** Top-level repo directories scans are confined to. */
export const SECURITY_LAB_SCAN_ROOT_NAMES = ['queries', 'src'];

/** Binary allowlist: bare names resolved via PATH by execFile (no shell). */
const TOOL_BINARIES = {
  gitleaks: 'gitleaks',
  trivy: 'trivy',
  httpx: 'httpx',
  binwalk: 'binwalk',
  subfinder: 'subfinder',
  theharvester: 'theHarvester',
  amass: 'amass',
  testssl: 'testssl.sh',
  wafw00f: 'wafw00f',
  gobuster: 'gobuster',
  dirsearch: 'dirsearch'
};

/** Local-only version probes reused for the status API (no second runner). */
const TOOL_VERSION_ARGV = {
  gitleaks: ['version'],
  trivy: ['version'],
  httpx: ['-version'],
  binwalk: ['--help'],
  subfinder: ['-version'],
  theharvester: ['-h'],
  amass: ['-h'],
  testssl: ['--help'],
  wafw00f: ['--help'],
  gobuster: ['--version'],
  dirsearch: ['--help']
};

/**
 * Server-controlled discovery wordlist for the gobuster adapter.
 * Fixed minimal entries (bounds every scan); gobuster v3.7+ treats `#`
 * lines as entries, so this file contains pure entries only. Verified to
 * exist before every spawn — a missing wordlist fails closed.
 */
const GOBUSTER_WORDLIST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'wordlists',
  'gobuster-common.txt'
);

/** Test seam: resolve the effective gobuster wordlist (overridable via deps). */
export function getGobusterWordlistPath(overrides = {}) {
  return typeof overrides.wordlistPath === 'string' && overrides.wordlistPath
    ? overrides.wordlistPath
    : GOBUSTER_WORDLIST_PATH;
}

/** Bounds for version probes. */
const STATUS_PROBE_TIMEOUT_MS = 10_000;
const STATUS_PROBE_MAX_BYTES = 65_536;
const STATUS_VERSION_MAX_CHARS = 120;

/** Exit codes that count as a completed scan (gitleaks uses 1 for findings). */
const TOOL_SUCCESS_EXIT_CODES = {
  gitleaks: [0, 1],
  trivy: [0],
  httpx: [0],
  binwalk: [0],
  subfinder: [0],
  theharvester: [0],
  amass: [0],
  testssl: [0],
  wafw00f: [0],
  gobuster: [0],
  dirsearch: [0]
};

/**
 * Build the single discovery URL for gobuster/dirsearch from a validated
 * bare target. The scheme is server-chosen (`http`); IPv6 literals are
 * bracketed. Validators guarantee the input holds no scheme, port, path,
 * whitespace, or userinfo, so this concatenation cannot smuggle flags.
 */
export function toSecurityLabDiscoveryUrl(target) {
  const host = target.includes(':') && !target.startsWith('[') ? `[${target}]` : target;
  return `http://${host}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Resolve a caller-supplied scan path against the project root.
 * Returns `{ ok: true, resolved }` or `{ ok: false }` (no details leak).
 */
export function resolveSecurityLabScanPath(inputPath, root) {
  if (typeof inputPath !== 'string' || typeof root !== 'string' || !root) return { ok: false };
  if (inputPath.includes('\0')) return { ok: false };
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed.length > SECURITY_LAB_EXEC_CAPS.MAX_PATH_CHARS) return { ok: false };
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return { ok: false };
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return { ok: false };
  if (trimmed.startsWith('~')) return { ok: false };
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return { ok: false };
  if (segments.includes('..') || segments.includes('.')) return { ok: false };
  if (!SECURITY_LAB_SCAN_ROOT_NAMES.includes(segments[0])) return { ok: false };
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, ...segments);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return { ok: false };
  return { ok: true, resolved };
}

function isPublicIPv4(target) {
  const octets = target.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 0) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIPv6(target) {
  if (target === '::' || target === '::1') return false;
  if (target.startsWith(':')) return false;
  if (target.includes('::ffff:')) return false;
  const first = target.split(':')[0].toLowerCase();
  if (!first) return false;
  if (/^fe[89ab]/i.test(first)) return false;
  if (/^f[c-d]/i.test(first)) return false;
  if (/^ff/i.test(first)) return false;
  return true;
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate an httpx target: public hostname or IP literal only.
 * Returns `{ ok: true, target }` (normalized) or `{ ok: false }`.
 */
export function validateSecurityLabTarget(value) {
  if (typeof value !== 'string' || value.includes('\0')) return { ok: false };
  let target = value.trim().toLowerCase();
  if (!target || target.length > SECURITY_LAB_EXEC_CAPS.MAX_TARGET_CHARS) return { ok: false };
  if (/[\s/?#@]/.test(target) || target.includes('://')) return { ok: false };
  if (/^[a-z][a-z0-9+.-]*:/.test(target)) return { ok: false };
  if (target.endsWith('.')) target = target.slice(0, -1);
  if (!target || target === 'localhost') return { ok: false };
  const ipVersion = isIP(target);
  if (ipVersion === 4) return isPublicIPv4(target) ? { ok: true, target } : { ok: false };
  if (ipVersion === 6) return isPublicIPv6(target) ? { ok: true, target } : { ok: false };
  if (ipVersion !== 0 || target.includes(':')) return { ok: false };
  const labels = target.split('.');
  if (labels.length < 2) return { ok: false };
  for (const label of labels) {
    if (!HOST_LABEL.test(label)) return { ok: false };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false };
  return { ok: true, target };
}

/**
 * Validate a recon domain for subfinder/theharvester: public hostname only.
 * Domain-only (no IP literals), dot required, no localhost, no schemes,
 * ports, paths, or numeric TLDs.
 * Returns `{ ok: true, domain }` (normalized) or `{ ok: false }`.
 */
export function validateSecurityLabDomain(value) {
  if (typeof value !== 'string' || value.includes('\0')) return { ok: false };
  let domain = value.trim().toLowerCase();
  if (!domain || domain.length > SECURITY_LAB_EXEC_CAPS.MAX_TARGET_CHARS) return { ok: false };
  if (/[\s/?#@]/.test(domain) || domain.includes('://')) return { ok: false };
  if (/^[a-z][a-z0-9+.-]*:/.test(domain)) return { ok: false };
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || domain === 'localhost') return { ok: false };
  if (isIP(domain) !== 0 || domain.includes(':')) return { ok: false };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false };
  for (const label of labels) {
    if (!HOST_LABEL.test(label)) return { ok: false };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false };
  return { ok: true, domain };
}

/**
 * Build the fixed argv array for a tool from validated values only.
 * Returns the argv array, or null for unknown tools. Callers must only
 * pass values produced by the validators above.
 */
export function buildSecurityLabArgv(toolId, validated) {
  if (toolId === 'gitleaks' && typeof validated?.scanPath === 'string') {
    return ['dir', validated.scanPath, '--no-banner', '--no-color', '--redact'];
  }
  if (toolId === 'trivy' && typeof validated?.scanPath === 'string') {
    return ['fs', '--quiet', '--no-progress', validated.scanPath];
  }
  if (toolId === 'httpx' && typeof validated?.target === 'string') {
    return ['-u', validated.target, '-silent', '-no-color', '-disable-update-check', '-timeout', '10'];
  }
  if (toolId === 'binwalk' && typeof validated?.scanPath === 'string') {
    return [validated.scanPath];
  }
  if (toolId === 'subfinder' && typeof validated?.domain === 'string') {
    return ['-d', validated.domain, '-silent', '-nc', '-duc'];
  }
  if (toolId === 'theharvester' && typeof validated?.domain === 'string') {
    return ['-d', validated.domain, '-b', 'crtsh,certspotter'];
  }
  if (toolId === 'amass' && typeof validated?.domain === 'string') {
    return ['enum', '-passive', '-d', validated.domain];
  }
  if ((toolId === 'testssl' || toolId === 'wafw00f') && typeof validated?.target === 'string') {
    return [validated.target];
  }
  if (toolId === 'gobuster' && typeof validated?.targetUrl === 'string' && typeof validated?.wordlistPath === 'string') {
    return ['dir', '-u', validated.targetUrl, '-w', validated.wordlistPath, '-t', '10', '-q', '--no-error', '--timeout', '10s'];
  }
  if (toolId === 'dirsearch' && typeof validated?.targetUrl === 'string') {
    return ['-u', validated.targetUrl, '-t', '20'];
  }
  return null;
}

/**
 * Default spawn implementation over execFile (no shell, ever).
 * stdin is closed (`ignore`) so tools that accept piped input can never
 * block waiting on it; stdout/stderr stay piped for bounded capture.
 * Resolves (never rejects) to `{ exitCode, stdout, stderr, timedOut, notInstalled }`.
 */
export function defaultSecurityLabSpawn(binary, argv, { timeoutMs, maxBytes } = {}) {
  return new Promise((resolve) => {
    execFile(
      binary,
      argv,
      {
        timeout: clampTimeoutMs(timeoutMs, SECURITY_LAB_EXEC_CAPS.TIMEOUT_MS),
        maxBuffer: maxBytes ?? SECURITY_LAB_EXEC_CAPS.MAX_BUFFER_BYTES,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve({ exitCode: null, stdout: out, stderr: err, timedOut: false, notInstalled: true });
          }
          if (error.killed) {
            return resolve({ exitCode: null, stdout: out, stderr: err, timedOut: true, notInstalled: false });
          }
          const code = Number.isInteger(error.code) ? error.code : 1;
          return resolve({ exitCode: code, stdout: out, stderr: err, timedOut: false, notInstalled: false });
        }
        return resolve({ exitCode: 0, stdout: out, stderr: err, timedOut: false, notInstalled: false });
      }
    );
  });
}

function truncate(text, max) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  if (str.length <= max) return { text: str, cut: false };
  return { text: str.slice(0, max), cut: true };
}

function sanitizeOutput(text, root) {
  if (!text) return '';
  let out = String(text);
  if (root) {
    const needle = String(root);
    if (needle && out.includes(needle)) out = out.split(needle).join('[scan-root]');
  }
  return out;
}

/**
 * Check one executable tool's install status via its local-only version
 * probe. Reuses the single spawn implementation above — no second runner,
 * no shell, no install attempts. Returns safe metadata only:
 * `{ toolId, executionAllowed, installed, status, version? }` where status
 * is ready | not-installed | unavailable. Unknown or non-enabled tools
 * report unavailable without spawning.
 */
export async function checkSecurityLabToolStatus(toolId, deps = {}) {
  if (
    typeof toolId !== 'string' ||
    !SECURITY_LAB_EXECUTABLE_TOOLS.includes(toolId) ||
    !isSecurityLabExecutionAllowed(toolId)
  ) {
    return { toolId: typeof toolId === 'string' ? toolId : null, executionAllowed: false, installed: false, status: 'unavailable' };
  }
  const spawnFn = typeof deps.spawnFn === 'function' ? deps.spawnFn : defaultSecurityLabSpawn;
  const timeoutMs = clampTimeoutMs(deps.timeoutMs, STATUS_PROBE_TIMEOUT_MS);
  let probed;
  try {
    probed = await spawnFn(TOOL_BINARIES[toolId], TOOL_VERSION_ARGV[toolId], {
      timeoutMs,
      maxBytes: STATUS_PROBE_MAX_BYTES
    });
  } catch {
    return { toolId, executionAllowed: true, installed: false, status: 'unavailable' };
  }
  if (probed?.notInstalled) {
    return { toolId, executionAllowed: true, installed: false, status: 'not-installed' };
  }
  if (probed?.timedOut || !Number.isInteger(probed?.exitCode) || probed.exitCode !== 0) {
    return { toolId, executionAllowed: true, installed: false, status: 'unavailable' };
  }
  const firstLine = String(probed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) || '';
  const version = firstLine.replace(/[\x00-\x1f\x7f]/g, '').slice(0, STATUS_VERSION_MAX_CHARS);
  const result = { toolId, executionAllowed: true, installed: true, status: 'ready' };
  if (version) result.version = version;
  return result;
}

/**
 * Status for every executable tool, in adapter order. Deterministic shape;
 * individual probes never reject (failures become `unavailable`).
 */
export async function getSecurityLabStatus(deps = {}) {
  const tools = await Promise.all(SECURITY_LAB_EXECUTABLE_TOOLS.map((toolId) => checkSecurityLabToolStatus(toolId, deps)));
  return { ok: true, tools };
}
/**
 * Run one allowlisted tool. Fail-closed at every gate; never spawns unless
 * the adapter exists, the registry allows the tool, the caller is an admin,
 * and the input validates exactly.
 *
 * `context`: `{ isAdmin }`. `deps`: `{ root, spawnFn, statFn, realpathFn,
 * timeoutMs }` (injectable for tests; the router supplies production values).
 */
export async function runSecurityLabTool(request, context = {}, deps = {}) {
  if (!hasExactKeys(request, ['toolId', 'input'])) {
    return { ok: false, status: 'unavailable', reason: 'invalid-request', message: 'Request must contain only a tool id and input.' };
  }
  const { toolId, input } = request;
  if (typeof toolId !== 'string' || !SECURITY_LAB_EXECUTABLE_TOOLS.includes(toolId)) {
    return { ok: false, status: 'blocked', reason: 'unknown-tool', message: 'Unknown or disabled tool.' };
  }
  if (context?.isAdmin !== true) {
    return { ok: false, status: 'blocked', reason: 'unauthorized', message: 'Admin access required.' };
  }
  if (!isSecurityLabExecutionAllowed(toolId)) {
    return { ok: false, status: 'blocked', reason: 'not-enabled', message: 'Execution is not enabled for this tool.' };
  }

  const root = typeof deps.root === 'string' && deps.root ? deps.root : null;
  const spawnFn = typeof deps.spawnFn === 'function' ? deps.spawnFn : defaultSecurityLabSpawn;
  const statFn = typeof deps.statFn === 'function' ? deps.statFn : nodeFs.stat;
  const realpathFn = typeof deps.realpathFn === 'function' ? deps.realpathFn : nodeFs.realpath;
  const timeoutMs = clampTimeoutMs(deps.timeoutMs, SECURITY_LAB_EXEC_CAPS.TIMEOUT_MS);
  if (!root) {
    return { ok: false, status: 'unavailable', reason: 'misconfigured', message: 'Scan root is not configured.' };
  }

  let validated = null;
  if (toolId === 'gitleaks' || toolId === 'trivy' || toolId === 'binwalk') {
    if (!hasExactKeys(input, ['path'])) {
      return { ok: false, status: 'unavailable', reason: 'invalid-input', message: 'Input must contain only a scan path.' };
    }
    const resolved = resolveSecurityLabScanPath(input.path, root);
    if (!resolved.ok) {
      return { ok: false, status: 'unavailable', reason: 'invalid-path', message: 'Invalid scan path.' };
    }
    let statOk = false;
    try {
      await statFn(resolved.resolved);
      statOk = true;
    } catch {
      statOk = false;
    }
    if (!statOk) {
      return { ok: false, status: 'unavailable', reason: 'invalid-path', message: 'Invalid scan path.' };
    }
    let real = null;
    try {
      real = await realpathFn(resolved.resolved);
    } catch {
      real = null;
    }
    const rootResolved = path.resolve(root);
    if (typeof real !== 'string' || (real !== rootResolved && !real.startsWith(rootResolved + path.sep))) {
      return { ok: false, status: 'unavailable', reason: 'invalid-path', message: 'Invalid scan path.' };
    }
    validated = { scanPath: resolved.resolved };
  } else if (toolId === 'httpx' || toolId === 'testssl' || toolId === 'wafw00f') {
    if (!hasExactKeys(input, ['target'])) {
      return { ok: false, status: 'unavailable', reason: 'invalid-input', message: 'Input must contain only a target.' };
    }
    const checked = validateSecurityLabTarget(input.target);
    if (!checked.ok) {
      return { ok: false, status: 'unavailable', reason: 'invalid-target', message: 'Invalid target.' };
    }
    validated = { target: checked.target };
  } else if (toolId === 'gobuster' || toolId === 'dirsearch') {
    if (!hasExactKeys(input, ['target'])) {
      return { ok: false, status: 'unavailable', reason: 'invalid-input', message: 'Input must contain only a target.' };
    }
    const checked = validateSecurityLabTarget(input.target);
    if (!checked.ok) {
      return { ok: false, status: 'unavailable', reason: 'invalid-target', message: 'Invalid target.' };
    }
    validated = { targetUrl: toSecurityLabDiscoveryUrl(checked.target) };
    if (toolId === 'gobuster') {
      const wordlistPath = getGobusterWordlistPath(deps);
      let wordlistOk = false;
      try {
        await statFn(wordlistPath);
        wordlistOk = true;
      } catch {
        wordlistOk = false;
      }
      if (!wordlistOk) {
        return { ok: false, status: 'unavailable', reason: 'misconfigured', message: 'Discovery wordlist is unavailable.' };
      }
      validated.wordlistPath = wordlistPath;
    }
  } else if (toolId === 'subfinder' || toolId === 'theharvester' || toolId === 'amass') {
    if (!hasExactKeys(input, ['domain'])) {
      return { ok: false, status: 'unavailable', reason: 'invalid-input', message: 'Input must contain only a domain.' };
    }
    const checked = validateSecurityLabDomain(input.domain);
    if (!checked.ok) {
      return { ok: false, status: 'unavailable', reason: 'invalid-domain', message: 'Invalid domain.' };
    }
    validated = { domain: checked.domain };
  }

  const argv = buildSecurityLabArgv(toolId, validated);
  if (!argv) {
    return { ok: false, status: 'unavailable', reason: 'invalid-input', message: 'Invalid input.' };
  }

  const started = Date.now();
  let spawned;
  try {
    spawned = await spawnFn(TOOL_BINARIES[toolId], argv, {
      timeoutMs,
      maxBytes: SECURITY_LAB_EXEC_CAPS.MAX_BUFFER_BYTES
    });
  } catch {
    return {
      ok: false,
      status: 'failure',
      reason: 'spawn-error',
      toolId,
      message: 'Tool could not be started.',
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: Date.now() - started
    };
  }
  const durationMs = Date.now() - started;

  if (spawned?.notInstalled) {
    return {
      ok: false,
      status: 'not-installed',
      reason: 'not-installed',
      toolId,
      message: 'This tool is not installed on the server.',
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs
    };
  }
  if (spawned?.timedOut) {
    const out = truncate(sanitizeOutput(spawned.stdout, root), SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);
    const err = truncate(sanitizeOutput(spawned.stderr, root), SECURITY_LAB_EXEC_CAPS.MAX_STDERR_CHARS);
    return {
      ok: false,
      status: 'timeout',
      reason: 'timeout',
      toolId,
      message: 'Tool timed out before completing.',
      stdout: out.text,
      stderr: err.text,
      truncated: out.cut || err.cut,
      durationMs
    };
  }

  const exitCode = Number.isInteger(spawned?.exitCode) ? spawned.exitCode : 1;
  const out = truncate(sanitizeOutput(spawned?.stdout, root), SECURITY_LAB_EXEC_CAPS.MAX_STDOUT_CHARS);
  const err = truncate(sanitizeOutput(spawned?.stderr, root), SECURITY_LAB_EXEC_CAPS.MAX_STDERR_CHARS);
  const succeeded = TOOL_SUCCESS_EXIT_CODES[toolId].includes(exitCode);
  const message =
    succeeded && toolId === 'gitleaks' && exitCode === 1
      ? 'Scan completed with findings.'
      : succeeded
        ? 'Tool completed successfully.'
        : 'Tool exited with an error.';
  return {
    ok: succeeded,
    status: succeeded ? 'success' : 'failure',
    reason: succeeded ? 'completed' : 'exit-error',
    toolId,
    message,
    exitCode,
    stdout: out.text,
    stderr: err.text,
    truncated: out.cut || err.cut,
    durationMs
  };
}
