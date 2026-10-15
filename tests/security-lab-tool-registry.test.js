import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SECURITY_LAB_CAPS,
  SECURITY_LAB_CATEGORIES,
  SECURITY_LAB_RISK_LEVELS,
  SECURITY_LAB_PLATFORMS,
  listSecurityLabTools,
  getSecurityLabTool,
  isSecurityLabToolAllowlisted,
  isSecurityLabExecutionAllowed,
  searchSecurityLabTools
} from '../src/security-lab/tool-registry.js';

const OFFENSIVE_DENYLIST = [
  'sqlmap',
  'hydra',
  'john',
  'hashcat',
  'aircrack',
  'wifite',
  'bettercap',
  'metasploit',
  'msfvenom',
  'beef',
  'thefatrat',
  'setoolkit',
  'evilginx',
  'blackeye',
  'shellphish',
  'slowloris',
  'goldeneye',
  'ufonet',
  'havoc',
  'sliver',
  'mythic',
  'responder',
  'bloodhound',
  'mimikatz',
  'pyshell',
  'routersploit',
  'commix',
  'websploit'
];

// Step 3–Step 8 execution allowlist: exactly these registry ids may execute.
const EXECUTION_ENABLED_IDS = new Set(['gitleaks', 'trivy', 'httpx', 'binwalk', 'subfinder', 'theharvester', 'amass', 'testssl', 'wafw00f', 'gobuster', 'dirsearch']);

test('registry shape: 10-15 tools with required metadata fields', () => {
  const all = listSecurityLabTools();
  assert.ok(all.length >= 10 && all.length <= 15, `expected 10-15 tools, got ${all.length}`);
  const ids = new Set();
  for (const tool of all) {
    assert.ok(typeof tool.id === 'string' && tool.id.length > 0 && tool.id.length <= SECURITY_LAB_CAPS.MAX_ID_CHARS);
    assert.ok(!ids.has(tool.id), `duplicate id ${tool.id}`);
    ids.add(tool.id);
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= SECURITY_LAB_CAPS.MAX_NAME_CHARS);
    assert.ok(
      typeof tool.description === 'string' &&
        tool.description.length > 0 &&
        tool.description.length <= SECURITY_LAB_CAPS.MAX_DESCRIPTION_CHARS
    );
    assert.ok(SECURITY_LAB_CATEGORIES.includes(tool.category), tool.id);
    assert.ok(typeof tool.sourceUrl === 'string' && tool.sourceUrl.startsWith('https://'), tool.id);
    assert.ok(Array.isArray(tool.platforms) && tool.platforms.length > 0, tool.id);
    for (const platform of tool.platforms) {
      assert.ok(SECURITY_LAB_PLATFORMS.includes(platform), `${tool.id}: ${platform}`);
    }
    assert.ok(SECURITY_LAB_RISK_LEVELS.includes(tool.riskLevel), tool.id);
    // Step 3: exactly gitleaks, trivy, httpx allow execution; all others deny.
    assert.equal(tool.executionAllowed, EXECUTION_ENABLED_IDS.has(tool.id), tool.id);
    // No execution surface of any kind.
    assert.equal(Object.hasOwn(tool, 'runCommands'), false);
    assert.equal(Object.hasOwn(tool, 'installCommands'), false);
    assert.equal(Object.hasOwn(tool, 'command'), false);
    assert.equal(Object.hasOwn(tool, 'shell'), false);
  }
});

test('allowlist: only registry ids pass, no offensive tools present', () => {
  const all = listSecurityLabTools();
  for (const tool of all) {
    assert.equal(isSecurityLabToolAllowlisted(tool.id), true);
    const blob = `${tool.id} ${tool.name} ${tool.description}`.toLowerCase();
    for (const denied of OFFENSIVE_DENYLIST) {
      assert.ok(!blob.includes(denied), `${tool.id} mentions denied tool ${denied}`);
    }
  }
  for (const bad of [null, undefined, 123, '', 'SUBFINDER', 'missing-tool', 'sqlmap']) {
    assert.equal(isSecurityLabToolAllowlisted(bad), false);
  }
  const categories = new Set(all.map((tool) => tool.category));
  for (const required of ['dns-recon', 'secret-scanning', 'security-scanning']) {
    assert.ok(categories.has(required), `missing category ${required}`);
  }
});

test('determinism: list/get/search return isolated clones in stable order', () => {
  const first = listSecurityLabTools();
  const second = listSecurityLabTools();
  assert.deepEqual(first, second);
  first[0].name = 'mutated';
  first[0].platforms.push('mutated');
  const third = listSecurityLabTools();
  assert.notEqual(third[0].name, 'mutated');
  assert.ok(!third[0].platforms.includes('mutated'));

  const found = getSecurityLabTool('nuclei');
  assert.ok(found);
  assert.equal(found.category, 'security-scanning');
  found.name = 'mutated';
  assert.notEqual(getSecurityLabTool('nuclei').name, 'mutated');

  assert.deepEqual(searchSecurityLabTools({ category: 'secret-scanning' }), searchSecurityLabTools({ category: 'secret-scanning' }));
});

test('bounds: search filters with AND semantics and clamped limits', () => {
  const byQ = searchSecurityLabTools({ q: 'subdomain' });
  assert.ok(byQ.count >= 1);
  assert.ok(byQ.tools.every((tool) => `${tool.id} ${tool.name} ${tool.description}`.toLowerCase().includes('subdomain')));

  const byCategory = searchSecurityLabTools({ category: 'secret-scanning' });
  assert.equal(byCategory.count, 2);

  const combined = searchSecurityLabTools({ q: 'secret', category: 'secret-scanning' });
  assert.equal(combined.count, 2);

  const miss = searchSecurityLabTools({ q: 'subdomain', category: 'secret-scanning' });
  assert.equal(miss.count, 0);
  assert.deepEqual(miss.tools, []);

  const byRisk = searchSecurityLabTools({ riskLevel: 'medium' });
  assert.ok(byRisk.count >= 1);
  assert.ok(byRisk.tools.every((tool) => tool.riskLevel === 'medium'));

  const noisy = searchSecurityLabTools({ q: '  TLS  ' });
  assert.ok(noisy.count >= 1);

  const huge = searchSecurityLabTools({ q: `x${'y'.repeat(5000)}`, limit: 99 });
  assert.ok(huge.count <= SECURITY_LAB_CAPS.MAX_RESULTS);

  assert.equal(searchSecurityLabTools({ limit: 2 }).tools.length, 2);
  assert.equal(searchSecurityLabTools({ limit: 0 }).tools.length, 1);
  assert.ok(searchSecurityLabTools({ limit: 'nope' }).tools.length <= SECURITY_LAB_CAPS.MAX_RESULTS);

  assert.deepEqual(searchSecurityLabTools(null).tools, listSecurityLabTools());
  assert.deepEqual(searchSecurityLabTools('q').tools, listSecurityLabTools());
});

test('fail-closed: unknown ids, unknown filters, and execution gate deny', () => {
  for (const bad of [null, undefined, 123, '', 'MISSING', 'subfinder ']) {
    assert.equal(getSecurityLabTool(bad), null);
    assert.equal(isSecurityLabToolAllowlisted(bad), false);
    assert.equal(isSecurityLabExecutionAllowed(bad), false);
  }
  // Steps 3–8: only the execution allowlist permits execution; all others deny.
  for (const tool of listSecurityLabTools()) {
    assert.equal(isSecurityLabExecutionAllowed(tool.id), EXECUTION_ENABLED_IDS.has(tool.id), tool.id);
  }
  assert.deepEqual(
    searchSecurityLabTools({ executionAllowed: true }).tools.map((tool) => tool.id).sort(),
    ['amass', 'binwalk', 'dirsearch', 'gitleaks', 'gobuster', 'httpx', 'subfinder', 'testssl', 'theharvester', 'trivy', 'wafw00f']
  );
  // Unknown category/risk matches nothing instead of everything.
  assert.equal(searchSecurityLabTools({ category: 'exploit-framework' }).count, 0);
  assert.equal(searchSecurityLabTools({ riskLevel: 'critical' }).count, 0);
  // Execution-allowed filter partitions the registry 11 / rest.
  assert.equal(searchSecurityLabTools({ executionAllowed: true }).count, 11);
  assert.equal(searchSecurityLabTools({ executionAllowed: false }).count, listSecurityLabTools().length - 11);
});

test('registry module is dependency-free with no execution surface (source boundary)', async () => {
  const source = await readFile(new URL('../src/security-lab/tool-registry.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bfrom\s+['"]/);
  assert.doesNotMatch(code, /child_process|execSync|spawn\(|execFile|fork\(/i);
  assert.doesNotMatch(code, /\bapp\.(get|post|use|listen)\b|express\(|Router\(/i);
  assert.doesNotMatch(code, /process\.env|fetch\(|setInterval|setTimeout|SELECT|INSERT|UPDATE|DELETE\b/i);
  assert.doesNotMatch(code, /\bsqlmap\b|\bhydra\b|\bmetasploit\b|\baircrack\b|\bwifite\b|\bbeef\b/i);
});
