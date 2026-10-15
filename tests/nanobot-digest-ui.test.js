import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routerSource = await readFile(new URL('../src/admin-assistant/router.js', import.meta.url), 'utf8');
const adminView = await readFile(new URL('../src/views/admin-ai.ejs', import.meta.url), 'utf8');

test('Phase 4.1: Nanobot digest API is server-side Admin/Owner protected', () => {
  assert.match(routerSource, /app\.get\('\/api\/admin\/nanobot\/digest',\s*requireApiAuth,\s*requireAdmin,\s*handleNanobotDigest\)/);
  assert.match(routerSource, /composeDigest/);
  assert.match(routerSource, /searchLibraryTool/);
  assert.match(routerSource, /readQueryLibrary/);
  assert.match(routerSource, /buildNanobotDigestLibraryEvidence/);
  assert.match(routerSource, /evidencePack: pack/);
  assert.doesNotMatch(routerSource, /requireOwner.*nanobot\/digest/);
});

test('Phase 4.1: Admin UI exposes the read-only Nanobot digest validation card', () => {
  assert.match(adminView, /data-testid="nanobot-digest"/);
  assert.match(adminView, /Admin \/ Owner · Read-only/);
  assert.match(adminView, /\/api\/admin\/nanobot\/digest/);
  assert.match(adminView, /No scheduling or delivery is active yet/);
});

test('Phase 4.1: digest UI uses text-only rendering and no polling timers', () => {
  const start = adminView.indexOf('data-testid="nanobot-digest"');
  const end = adminView.indexOf('</section>', start);
  const block = adminView.slice(start, end + 10);
  assert.doesNotMatch(block, /innerHTML/);
  assert.doesNotMatch(block, /setInterval|setTimeout/);
});
