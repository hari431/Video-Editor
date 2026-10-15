import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'queries/Reviews/Premium Knowledge/Guidewire/Creating Products From APD.txt');
const viewPath = path.join(repoRoot, 'src/views/query.ejs');

test('Creating Products From APD is allowlisted for the Premium rich reader', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.ok(view.includes('Creating Products From APD|APD Senior Interview Questions and Answers|Cloud API Consumer'));
  assert.ok(source.includes('# Guidewire Advanced Product Designer App — Creating Products'));
  assert.ok(source.includes('# Working with mind maps'));
  assert.ok(source.includes('# Conceptualizing products'));
  assert.ok(source.includes('# Product editions'));
  assert.ok(source.includes('\`\`\`gosu'));
  assert.ok(source.includes('EditionRulesContainerInternal'));
  assert.ok(source.includes('Release 2024.11'));
  assert.ok(source.includes('Document revision: 10-November-2025.'));
});

test('Creating Products From APD source has balanced rich-reader fences', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.ok(source.length > 150000);
  assert.equal((source.match(/\`\`\`/g) || []).length % 2, 0);
});
