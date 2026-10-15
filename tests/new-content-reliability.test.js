import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNewContentForUser, FRESHNESS_WINDOW_MS } from '../src/library/new-content.js';
import { invalidatePermissionCache } from '../src/library/local.js';
import { pool } from '../src/db/pool.js';

test('1. Build-time Git manifest timestamps are used as primary source', async () => {
  const now = Date.now();
  const baseline = new Date(now - 3 * 86400_000); // User created 3 days ago
  const user = { id: 101, first_login_at: baseline, app_role: 'user', roles: [] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['note.txt', { type: 'file', path: 'Guidewire/note.txt', file: { name: 'note.txt', path: 'Guidewire/note.txt' } }]
    ])
  };

  const commitTime = now - 86400_000; // 1 day ago (newer than baseline)
  const manifest = {
    'Guidewire/note.txt': commitTime
  };

  const items = await getNewContentForUser(user, tree, {
    manifest,
    canAccess: () => true,
    seenPaths: new Set()
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'Guidewire/note.txt');
  assert.equal(items[0].addedAt.getTime(), commitTime);
});

test('2. Filesystem checkout/deployment mtime reset does NOT cause false new content for Git-tracked files with old commit date', async () => {
  const now = Date.now();
  const baseline = new Date(now - 3 * 86400_000); // User created 3 days ago
  const user = { id: 102, first_login_at: baseline, app_role: 'user', roles: [] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['old_doc.pdf', { type: 'item', path: 'Guidewire/old_doc.pdf' }]
    ])
  };

  // Commit time was 30 days ago (older than user baseline and older than 14-day freshness window)
  const oldCommitTime = now - 30 * 86400_000;
  const manifest = {
    'Guidewire/old_doc.pdf': oldCommitTime
  };

  // Simulated deployment checkout reset mtime to "now"
  const statFn = async () => ({
    isFile: () => true,
    mtime: new Date(now)
  });

  const items = await getNewContentForUser(user, tree, {
    manifest,
    statFn,
    canAccess: () => true,
    seenPaths: new Set()
  });

  // Must NOT be included because manifest commit time is authoritative
  assert.equal(items.length, 0, 'Old Git commit must not appear as new content even if deployment mtime is fresh');
});

test('3. Newly available detection: granting a role unlocks previously inaccessible old content as New Content', async () => {
  const now = Date.now();
  const baseline = new Date(now - 10 * 86400_000); // User created 10 days ago
  // User has role 42
  const user = { id: 103, first_login_at: baseline, app_role: 'user', roles: [42] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['premium_video.mp4', { type: 'video', path: 'Premium/premium_video.mp4' }]
    ])
  };

  // File was committed 50 days ago
  const manifest = {
    'Premium/premium_video.mp4': now - 50 * 86400_000
  };

  // Role 42 was granted to the user 2 days ago (within freshness window and after user baseline)
  const roleGrantDate = new Date(now - 2 * 86400_000);
  const userRoleGrants = new Map([[42, roleGrantDate]]);

  // Mock pool query to load folder_permissions
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (/folder_permissions/.test(sql)) {
      return {
        rows: [
          { folder_path: 'Premium', access_level: 'role', role_id: 42, ads_available: false }
        ]
      };
    }
    return { rows: [] };
  };

  invalidatePermissionCache();

  try {
    const items = await getNewContentForUser(user, tree, {
      manifest,
      userRoleGrants,
      canAccess: (u, p) => p.startsWith('Premium') && u.roles.includes(42),
      seenPaths: new Set()
    });

    assert.equal(items.length, 1, 'Newly granted role makes old content eligible as new content');
    assert.equal(items[0].path, 'Premium/premium_video.mp4');
    assert.equal(items[0].addedAt.getTime(), roleGrantDate.getTime(), 'addedAt reflects the role grant date');
  } finally {
    pool.query = originalQuery;
    invalidatePermissionCache();
  }
});

test('4. Genuinely newly granted role vs. ungranted role and RBAC filtering', async () => {
  const now = Date.now();
  const baseline = new Date(now - 10 * 86400_000);
  const userWithRole = { id: 104, first_login_at: baseline, app_role: 'user', roles: [10] };
  const userWithoutRole = { id: 105, first_login_at: baseline, app_role: 'user', roles: [99] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['secret.pdf', { type: 'item', path: 'Restricted/secret.pdf' }]
    ])
  };

  const manifest = {
    'Restricted/secret.pdf': now - 1 * 86400_000 // Added 1 day ago
  };

  // User without role must NOT see it (RBAC gatekeeping)
  const itemsWithout = await getNewContentForUser(userWithoutRole, tree, {
    manifest,
    canAccess: (u, p) => u.roles.includes(10),
    seenPaths: new Set()
  });
  assert.equal(itemsWithout.length, 0, 'User without role must not see restricted content');

  // User with role sees it
  const itemsWith = await getNewContentForUser(userWithRole, tree, {
    manifest,
    canAccess: (u, p) => u.roles.includes(10),
    seenPaths: new Set()
  });
  assert.equal(itemsWith.length, 1, 'User with role sees restricted content');
  assert.equal(itemsWith[0].path, 'Restricted/secret.pdf');
});

test('5. 14-day freshness window excludes content older than 14 days', async () => {
  const now = Date.now();
  const baseline = new Date(now - 30 * 86400_000); // User created 30 days ago
  const user = { id: 106, first_login_at: baseline, app_role: 'user', roles: [] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['fifteen_days_old.txt', { type: 'file', path: 'Guidewire/fifteen_days_old.txt', file: { name: 'fifteen_days_old.txt', path: 'Guidewire/fifteen_days_old.txt' } }],
      ['five_days_old.txt', { type: 'file', path: 'Guidewire/five_days_old.txt', file: { name: 'five_days_old.txt', path: 'Guidewire/five_days_old.txt' } }]
    ])
  };

  const manifest = {
    'Guidewire/fifteen_days_old.txt': now - 15 * 86400_000,
    'Guidewire/five_days_old.txt': now - 5 * 86400_000
  };

  const items = await getNewContentForUser(user, tree, {
    manifest,
    canAccess: () => true,
    seenPaths: new Set()
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'Guidewire/five_days_old.txt');
});

test('6. Seen and dismissed items are excluded from New Content', async () => {
  const now = Date.now();
  const baseline = new Date(now - 3 * 86400_000);
  const user = { id: 107, first_login_at: baseline, app_role: 'user', roles: [] };

  const tree = {
    type: 'folder',
    children: new Map([
      ['item1.pdf', { type: 'item', path: 'Guidewire/item1.pdf' }],
      ['item2.pdf', { type: 'item', path: 'Guidewire/item2.pdf' }]
    ])
  };

  const manifest = {
    'Guidewire/item1.pdf': now - 86400_000,
    'Guidewire/item2.pdf': now - 86400_000
  };

  // item1 is already marked seen
  const seenPaths = new Set(['Guidewire/item1.pdf']);

  const items = await getNewContentForUser(user, tree, {
    manifest,
    canAccess: () => true,
    seenPaths
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'Guidewire/item2.pdf');
});
