import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'queries/Reviews/Premium Knowledge/Guidewire/APD Senior Interview Questions and Answers.txt');
const viewPath = path.join(repoRoot, 'src/views/query.ejs');

test('APD Senior Interview Questions and Answers is a separate Premium rich guide', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const view = fs.readFileSync(viewPath, 'utf8');

  assert.ok(view.includes('APD Senior Interview Questions and Answers'));
  assert.ok(source.includes('# Guidewire Advanced Product Designer (APD) — Senior Interview Questions & Answers'));
  assert.ok(source.includes('# 1. What is Advanced Product Designer (APD), and where does it fit in the PolicyCenter product-development lifecycle?'));
  assert.ok(source.includes('# 50. Give a concise senior-level explanation of APD in an interview.'));
  assert.ok(source.includes('# Senior Interview Revision Checklist'));
  assert.ok(source.includes('# 51. What is Lifecycle Manager in the APD delivery flow?'));
  assert.ok(source.includes('# 60. What would you explain if an interviewer asks, "How does your APD change finally reach another environment?"'));
  assert.ok(source.includes('Planets and parallel developer workspaces'));
  assert.ok(source.includes('Export Product and Editions'));
  assert.ok(source.includes('project-specific'));
  assert.equal((source.match(/\`\`\`/g) || []).length % 2, 0);
  assert.equal((source.match(/^# /gm) || []).length, 62);
  assert.ok(!source.includes('public_data/'));
});
