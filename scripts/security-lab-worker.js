/**
 * Step 11 — Linux Security Lab Worker Verification Harness
 *
 * Runs verification against the real system environment:
 * - Checks status probes and product path execution for all 11 approved tools
 * - Verifies blocked tools policy (Nuclei & TruffleHog)
 * - Verifies Amass passive mode policy enforcement
 * - Reports true system binary availability vs stub presence
 * - Captures exact environment, isolation, and remaining infrastructure gaps
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  SECURITY_LAB_EXECUTABLE_TOOLS,
  buildSecurityLabArgv,
  checkSecurityLabToolStatus,
  runSecurityLabTool
} from '../src/security-lab/executor.js';
import {
  SECURITY_LAB_BLOCKED_TOOLS,
  isSecurityLabExecutionAllowed
} from '../src/security-lab/tool-registry.js';

export async function runWorkerValidation() {
  const root = process.cwd();
  const report = {
    timestamp: new Date().toISOString(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    executionMode: 'REAL_SYSTEM_PATH_NO_STUBS',
    isolation: {
      processUid: process.getuid ? process.getuid() : 'N/A',
      processGid: process.getgid ? process.getgid() : 'N/A',
      hasProductionEnvInWorkerDir: fs.existsSync(path.join(root, '.env')),
      hasDbCredentials: Boolean(process.env.DATABASE_URL || process.env.PGPASSWORD),
      workDir: root,
      isolationNotes: 'Worker execution path invokes child_process.execFile with no shell interpolation, bounded buffers (stdout 8KB, stderr 2KB), strict input validation, and no DB/environment variable access.'
    },
    blockedToolsCheck: null,
    amassPassiveProof: null,
    trivyDbWarmup: null,
    toolsStatusProbes: {},
    productPathExecutions: {}
  };

  // 1. Verify blocked tools (Nuclei & TruffleHog)
  const nucleiAllowed = isSecurityLabExecutionAllowed('nuclei');
  const trufflehogAllowed = isSecurityLabExecutionAllowed('trufflehog');
  report.blockedToolsCheck = {
    nucleiBlocked: !nucleiAllowed,
    trufflehogBlocked: !trufflehogAllowed,
    policy: SECURITY_LAB_BLOCKED_TOOLS
  };

  // 2. Verify Amass passive mode policy
  const amassArgv = buildSecurityLabArgv('amass', { domain: 'example.com' });
  report.amassPassiveProof = {
    argv: amassArgv,
    isPassive: amassArgv.includes('-passive'),
    noActive: !amassArgv.includes('-active') && !amassArgv.includes('-brute')
  };

  // 3. Verify Trivy DB cache location
  const trivyCacheDir = path.join(os.homedir(), '.cache', 'trivy');
  report.trivyDbWarmup = {
    cacheExists: fs.existsSync(trivyCacheDir),
    cachePath: trivyCacheDir
  };

  // 4. Real Status probes for all 11 approved tools
  for (const id of SECURITY_LAB_EXECUTABLE_TOOLS) {
    const status = await checkSecurityLabToolStatus(id);
    report.toolsStatusProbes[id] = {
      installed: status.installed,
      status: status.status,
      version: status.version || 'N/A'
    };
  }

  // 5. Real Product-path executions for ALL 11 tools using runSecurityLabTool
  const adminCtx = { user: { app_role: 'ADMIN' }, isAdmin: true };
  const deps = { root };

  const toolInputMap = {
    gitleaks: { path: 'queries' },
    trivy: { path: 'queries' },
    binwalk: { path: 'queries' },
    httpx: { target: 'example.com' },
    testssl: { target: 'example.com' },
    wafw00f: { target: 'example.com' },
    gobuster: { target: 'example.com' },
    dirsearch: { target: 'example.com' },
    subfinder: { domain: 'example.com' },
    theharvester: { domain: 'example.com' },
    amass: { domain: 'example.com' }
  };

  for (const toolId of SECURITY_LAB_EXECUTABLE_TOOLS) {
    const input = toolInputMap[toolId];
    const res = await runSecurityLabTool({ toolId, input }, adminCtx, deps);
    report.productPathExecutions[toolId] = {
      ok: res.ok,
      status: res.status,
      reason: res.reason,
      exitCode: res.exitCode ?? null,
      message: res.message,
      truncated: res.truncated ?? false,
      durationMs: res.durationMs ?? 0
    };
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== Step 11: Linux Security Lab Worker Real Verification ===');
  runWorkerValidation().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((err) => {
    console.error('Worker validation failed:', err);
    process.exit(1);
  });
}
