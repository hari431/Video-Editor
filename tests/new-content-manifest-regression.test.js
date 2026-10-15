import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNewContentForUser, loadContentManifest, resetManifestCache } from '../src/library/new-content.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, '..', 'src', 'config', 'content-manifest.json');

test('regression: content-manifest.json must be populated for banner to work', async () => {
  // This test captures the regression where src/config/content-manifest.json was "{}"
  // causing getNewContentForUser to return no items even for newly added content
  // within the 14-day freshness window. A populated manifest is required.
  assert.equal(existsSync(MANIFEST_PATH), true, 'manifest file must exist');
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);
  const keys = Object.keys(manifest);
  assert.ok(keys.length > 0, 'manifest must not be empty (previously "{}" caused banner regression)');
  // At least one recent commit timestamp should be within freshness window for a user created 30 days ago
  const now = Date.now();
  const recentCount = keys.filter(k => typeof manifest[k] === 'number' && manifest[k] >= now - 14 * 24 * 60 * 60 * 1000).length;
  // After the Sep 11 Premium content commit, there should be recent entries
  assert.ok(recentCount > 0, `manifest should contain recent entries within 14 days, got ${recentCount}`);
});

test('regression: empty manifest yields no banner even though content exists on disk', async () => {
  const now = Date.now();
  const baseline = new Date(now - 30 * 86400_000);
  const user = { id: 9991, first_login_at: baseline, app_role: 'user', roles: [] };
  const tree = {
    type: 'folder',
    children: new Map([
      ['note.txt', { type: 'file', path: 'Guidewire/note.txt', file: { name: 'note.txt', path: 'Guidewire/note.txt' } }]
    ])
  };

  // Simulate production: empty manifest, no stat fallback (no statFn, not test env for fallback)
  // We force production-like by providing empty manifest and canAccess true.
  // The function should return 0 items when manifest is empty (the bug manifest caused banner disappearance)
  const emptyItems = await getNewContentForUser(user, tree, {
    manifest: {},
    canAccess: () => true,
    seenPaths: new Set(),
    now: new Date(now)
  });
  assert.equal(emptyItems.length, 0, 'empty manifest must yield 0 items (this was the regression)');

  // With a populated manifest entry within window, banner should appear
  const populatedManifest = { 'Guidewire/note.txt': now - 2 * 86400_000 };
  const populatedItems = await getNewContentForUser(user, tree, {
    manifest: populatedManifest,
    canAccess: () => true,
    seenPaths: new Set(),
    now: new Date(now)
  });
  assert.equal(populatedItems.length, 1, 'populated manifest should yield new content');
  assert.equal(populatedItems[0].path, 'Guidewire/note.txt');
});

test('regression: loadContentManifest reads the on-disk manifest (not empty)', async () => {
  resetManifestCache();
  const manifest = loadContentManifest();
  assert.ok(manifest && typeof manifest === 'object', 'loadContentManifest should return object');
  assert.ok(Object.keys(manifest).length > 0, 'loaded manifest should not be empty');
  resetManifestCache();
});
