/**
 * Step 1 — Isolated Security Lab tool registry (declarative only).
 *
 * Reference: `https://github.com/AKCodez/hackingtool-plugin`
 * (wrapping `https://github.com/Z4nzu/hackingtool`).
 *
 * Safe/read-only subset for a future Admin-only Security Lab:
 * DNS/recon, HTTP/TLS inspection, security headers/WAF fingerprinting,
 * web discovery, secret scanning, dependency/security scanning, and
 * forensics/analysis. Offensive execution is deliberately excluded:
 * no phishing, credential attacks, DDoS, RAT/C2, payload generation,
 * exploit frameworks, or destructive actions appear here.
 *
 * Step 1 is metadata only. There is no shell, no Docker,
 * no network, no DB, no timers, no imports, no writes. `executionAllowed`
 * stays false until an explicit later step allowlists execution for a tool.
 * (Step 3 allowlists exactly: gitleaks, trivy, httpx. All others stay false.)
 * Not wired into any route.
 *
 * Each tool declares:
 *   id, name, category, description, sourceUrl, platforms,
 *   riskLevel, executionAllowed.
 *
 * All functions are pure and deterministic: same input yields same output.
 * All output is bounded via `SECURITY_LAB_CAPS`.
 */

/** Hard caps for registry input/output. */
export const SECURITY_LAB_CAPS = {
  MAX_QUERY_CHARS: 120,
  MAX_RESULTS: 25,
  MAX_ID_CHARS: 64,
  MAX_NAME_CHARS: 80,
  MAX_DESCRIPTION_CHARS: 280
};

/** Known categories for the Step 1 safe subset. */
export const SECURITY_LAB_CATEGORIES = [
  'dns-recon',
  'http-tls-inspection',
  'security-headers',
  'web-discovery',
  'secret-scanning',
  'security-scanning',
  'forensics-analysis'
];

/** Allowed risk levels for the Step 1 subset (no high-risk entries). */
export const SECURITY_LAB_RISK_LEVELS = ['low', 'medium'];

/**
 * Step 9 evaluation record — tools intentionally left disabled, with the
 * reason why. This is documentation, not behavior: these ids have
 * `executionAllowed: false`, no executor adapter, and no UI controls.
 *
 * - nuclei: template-driven engine. Upstream templates can use the `code`
 *   protocol (executes system commands) and the `file` protocol (reads
 *   local server files), so any custom or compromised template is remote
 *   code execution / file disclosure on the server. Safe enablement would
 *   require a pinned, reviewed template subset with those protocols
 *   prohibited — explicitly deferred. Blocked until such a design is
 *   approved.
 * - trufflehog: overlaps the enabled gitleaks adapter for repo/filesystem
 *   secret scanning. Its differentiator is live credential verification,
 *   which performs outbound calls to third-party APIs using scan findings
 *   (egress + credential-reuse oracle); gitleaks is purely local and
 *   redacts findings (`--redact`). Deferred until verified-secrets triage
 *   is explicitly required. Candidate future shape (not implemented):
 *   `filesystem` mode with `--results=verified`, `--no-update`, `--fail`
 *   (exit 183 = findings), and a concurrency cap — pending approval.
 */
export const SECURITY_LAB_BLOCKED_TOOLS = Object.freeze([
  Object.freeze({
    id: 'nuclei',
    reason: 'Template engine with code-execution (code protocol) and local-file-read (file protocol) capabilities; safe use needs a pinned template subset with those protocols prohibited. Intentionally blocked.'
  }),
  Object.freeze({
    id: 'trufflehog',
    reason: 'Overlaps the enabled gitleaks adapter; its live-verification differentiator requires outbound third-party API calls. Deferred until verified-secrets triage is explicitly required.'
  })
]);

/** Allowed platform tokens used in `platforms` metadata. */
export const SECURITY_LAB_PLATFORMS = ['linux', 'macos', 'windows-wsl', 'docker'];

/**
 * Static registry: 13 safe/read-only tools from the HackingTool catalog.
 * Frozen at module load; accessors return clones so callers cannot mutate it.
 * `executionAllowed` is true only for the Step 3 + Step 6 + Step 7 + Step 8
 * allowlist (gitleaks, trivy, httpx, binwalk, subfinder, theharvester,
 * amass, testssl, wafw00f, gobuster, dirsearch); nuclei and trufflehog stay
 * false (fail-closed), as does every other entry.
 */
const REGISTRY = Object.freeze([
  Object.freeze({
    id: 'subfinder',
    name: 'Subfinder',
    category: 'dns-recon',
    description: 'Fast passive subdomain enumeration for authorized domains.',
    sourceUrl: 'https://github.com/projectdiscovery/subfinder',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'amass',
    name: 'Amass',
    category: 'dns-recon',
    description: 'Attack-surface mapping and subdomain enumeration for owned scope.',
    sourceUrl: 'https://github.com/owasp-amass/amass',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'theharvester',
    name: 'theHarvester',
    category: 'dns-recon',
    description: 'Passive OSINT collection of emails, names, and subdomains.',
    sourceUrl: 'https://github.com/laramies/theHarvester',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'httpx',
    name: 'httpx',
    category: 'http-tls-inspection',
    description: 'Fast HTTP probing of live hosts, status, titles, and TLS data.',
    sourceUrl: 'https://github.com/projectdiscovery/httpx',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'testssl',
    name: 'testssl.sh',
    category: 'http-tls-inspection',
    description: 'TLS/SSL cipher, protocol, and certificate checks against owned hosts.',
    sourceUrl: 'https://github.com/drwetter/testssl.sh',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'wafw00f',
    name: 'wafw00f',
    category: 'security-headers',
    description: 'Fingerprint web application firewalls from safe HTTP responses.',
    sourceUrl: 'https://github.com/EnableSecurity/wafw00f',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'gobuster',
    name: 'Gobuster',
    category: 'web-discovery',
    description: 'Directory, file, DNS, and vhost discovery on authorized targets.',
    sourceUrl: 'https://github.com/OJ/gobuster',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'medium',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'dirsearch',
    name: 'dirsearch',
    category: 'web-discovery',
    description: 'Web path discovery for directories and files on owned sites.',
    sourceUrl: 'https://github.com/maurosoria/dirsearch',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'medium',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'gitleaks',
    name: 'Gitleaks',
    category: 'secret-scanning',
    description: 'Detect hardcoded passwords, API keys, and tokens in git repos.',
    sourceUrl: 'https://github.com/gitleaks/gitleaks',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'trufflehog',
    name: 'TruffleHog',
    category: 'secret-scanning',
    description: 'Find and verify leaked credentials across repos and filesystems.',
    sourceUrl: 'https://github.com/trufflesecurity/trufflehog',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: false
  }),
  Object.freeze({
    id: 'nuclei',
    name: 'Nuclei',
    category: 'security-scanning',
    description: 'Template-based vulnerability checks for authorized targets.',
    sourceUrl: 'https://github.com/projectdiscovery/nuclei',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'medium',
    executionAllowed: false
  }),
  Object.freeze({
    id: 'trivy',
    name: 'Trivy',
    category: 'security-scanning',
    description: 'Vulnerability scanner for containers, filesystems, and IaC.',
    sourceUrl: 'https://github.com/aquasecurity/trivy',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  }),
  Object.freeze({
    id: 'binwalk',
    name: 'Binwalk',
    category: 'forensics-analysis',
    description: 'Analyze and extract firmware images for offline forensics.',
    sourceUrl: 'https://github.com/ReFirmLabs/binwalk',
    platforms: Object.freeze(['linux', 'macos', 'docker']),
    riskLevel: 'low',
    executionAllowed: true
  })
]);

function cloneTool(entry) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    sourceUrl: entry.sourceUrl,
    platforms: [...entry.platforms],
    riskLevel: entry.riskLevel,
    executionAllowed: entry.executionAllowed
  };
}

function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return text.slice(0, SECURITY_LAB_CAPS.MAX_QUERY_CHARS);
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SECURITY_LAB_CAPS.MAX_RESULTS;
  return Math.min(Math.max(Math.floor(n), 1), SECURITY_LAB_CAPS.MAX_RESULTS);
}

/** List every registered tool (cloned, registry order). */
export function listSecurityLabTools() {
  return REGISTRY.map(cloneTool);
}

/** Fetch one tool by exact id. Returns a clone or null (fail-closed). */
export function getSecurityLabTool(id) {
  if (typeof id !== 'string') return null;
  const found = REGISTRY.find((entry) => entry.id === id);
  return found ? cloneTool(found) : null;
}

/** True only for an exact registry id. All other input returns false. */
export function isSecurityLabToolAllowlisted(id) {
  if (typeof id !== 'string') return false;
  return REGISTRY.some((entry) => entry.id === id);
}

/**
 * Fail-closed execution gate: true only if the id is allowlisted AND its
 * record explicitly sets `executionAllowed: true`. Steps 3, 6, 7, and 8 set
 * this for exactly gitleaks, trivy, httpx, binwalk, subfinder, theharvester,
 * amass, testssl, wafw00f, gobuster, and dirsearch; nuclei, trufflehog, and
 * every other id return false, as does any unknown or malformed input.
 */
export function isSecurityLabExecutionAllowed(id) {
  const found = getSecurityLabTool(id);
  if (!found) return false;
  return found.executionAllowed === true;
}

/**
 * Deterministic filter over tool metadata (ANDed).
 * Options: `{ q, category, riskLevel, executionAllowed, limit }`.
 * Returns `{ count, tools }` bounded by `MAX_RESULTS`.
 * Unknown categories/risk levels match nothing (fail-closed).
 */
export function searchSecurityLabTools(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const q = normalizeQuery(opts.q);
  const category = typeof opts.category === 'string' ? opts.category.trim().toLowerCase() : '';
  const riskLevel = typeof opts.riskLevel === 'string' ? opts.riskLevel.trim().toLowerCase() : '';
  const limit = clampLimit(opts.limit);
  const executionAllowed =
    opts.executionAllowed === undefined ? undefined : opts.executionAllowed === true;

  const matches = [];
  for (const entry of REGISTRY) {
    if (category && entry.category !== category) continue;
    if (riskLevel && entry.riskLevel !== riskLevel) continue;
    if (executionAllowed !== undefined && entry.executionAllowed !== executionAllowed) continue;
    if (q) {
      const blob = `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase();
      if (!blob.includes(q)) continue;
    }
    matches.push(cloneTool(entry));
    if (matches.length >= limit) break;
  }
  return { count: matches.length, tools: matches };
}
