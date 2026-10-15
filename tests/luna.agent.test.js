import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, findFile } from '../src/library/tree.js';
import { askLuna } from '../src/luna/agent.js';

test('Luna feature flag is disabled by default', async () => {
  const previous = process.env.LUNA_ENABLED;
  delete process.env.LUNA_ENABLED;
  const { isLunaEnabled } = await import('../src/luna/config.js?test=' + Date.now());
  assert.equal(isLunaEnabled(), false);
  if (previous === undefined) delete process.env.LUNA_ENABLED;
  else process.env.LUNA_ENABLED = previous;
});

test('Luna feature flag enables only on literal true', async () => {
  const previous = process.env.LUNA_ENABLED;
  process.env.LUNA_ENABLED = 'true';
  const { isLunaEnabled } = await import('../src/luna/config.js?test=' + Date.now());
  assert.equal(isLunaEnabled(), true);
  process.env.LUNA_ENABLED = previous;
});

test('Tree node resolver finds generic item types like pdf or docx', () => {
  // Mock items list representing generic documents
  const items = [
    {
      path: 'Certification Dumps/Professional Exam.pdf',
      name: 'Professional Exam.pdf',
      type: 'pdf'
    }
  ];
  
  const tree = buildTree([], [], [], items);
  
  // Verify findFile successfully locates the pdf leaf node
  const fileNode = findFile(tree, 'Certification Dumps/Professional Exam.pdf');
  assert.ok(fileNode);
  assert.equal(fileNode.type, 'pdf');
  assert.equal(fileNode.path, 'Certification Dumps/Professional Exam.pdf');
});

