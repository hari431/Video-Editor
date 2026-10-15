#!/usr/bin/env node
/**
 * Phase 3 Step 2 — launch the nanobot sidecar with the repository MCP bridge.
 *
 * This launcher does not mint identity and does not accept identity from CLI
 * arguments. The caller must provide both secrets in the environment:
 *   NANOBOT_MCP_TOKEN
 *   NANOBOT_MCP_SESSION_TOKEN
 *
 * Nanobot itself owns the agent process; this script only validates the
 * required environment and starts the configured nanobot command.
 *
 * Example:
 *   NANOBOT_MCP_TOKEN=... NANOBOT_MCP_SESSION_TOKEN=... \
 *     node scripts/run-nanobot-sidecar.js
 *
 * On Windows PowerShell:
 *   $env:NANOBOT_MCP_TOKEN='...'
 *   $env:NANOBOT_MCP_SESSION_TOKEN='...'
 *   node scripts/run-nanobot-sidecar.js
 */

import { spawn } from 'node:child_process';

const required = ['NANOBOT_MCP_TOKEN', 'NANOBOT_MCP_SESSION_TOKEN'];
const missing = required.filter(name => !String(process.env[name] || '').trim());
if (missing.length) {
  console.error(`Nanobot sidecar unavailable: missing ${missing.join(', ')}.`);
  process.exit(2);
}

const configPath = process.env.NANOBOT_CONFIG || 'config/nanobot-sidecar.example.json';
const args = ['gateway', '--config', configPath, '--verbose'];

const child = spawn(process.env.NANOBOT_BIN || 'nanobot', args, {
  env: { ...process.env },
  stdio: 'inherit'
});

child.on('error', error => {
  console.error(`Failed to start nanobot: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Nanobot stopped by signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
