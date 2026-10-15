import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getUserViewedItemPaths,
  getFolderLeafItemPaths,
  calculateFolderProgressMap,
  getFolderProgressForUser
} from '../src/library/folder-progress.js';
import { buildTree, filterTreeForUser } from '../src/library/tree.js';
import { hasNotesPermission } from '../src/auth/content-permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.resolve(__dirname, '..', 'src', 'views');

test('getUserViewedItemPaths aggregates viewed item paths from existing tables', async () => {
  const mockPool = {
    query: async (sql, params) => {
      const s = sql.toLowerCase();
      if (s.includes('content_seen') && s.includes('recently_viewed')) {
        return {
          rows: [
            { item_path: 'Guidewire/Gosu/Query1.txt' },
            { item_path: 'Guidewire/Gosu/Query2.txt' },
            { item_path: 'Guidewire/Billing/Invoice.pdf' }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const viewed = await getUserViewedItemPaths(101, mockPool);
  assert.equal(viewed instanceof Set, true);
  assert.equal(viewed.size, 3);
  assert.equal(viewed.has('Guidewire/Gosu/Query1.txt'), true);
  assert.equal(viewed.has('Guidewire/Gosu/Query2.txt'), true);
  assert.equal(viewed.has('Guidewire/Billing/Invoice.pdf'), true);
  assert.equal(viewed.has('Guidewire/Gosu/Query3.txt'), false);
});

test('getUserViewedItemPaths returns empty Set for invalid or unauthenticated users', async () => {
  assert.equal((await getUserViewedItemPaths(null)).size, 0);
  assert.equal((await getUserViewedItemPaths(undefined)).size, 0);
  assert.equal((await getUserViewedItemPaths('abc')).size, 0);
  assert.equal((await getUserViewedItemPaths(-1)).size, 0);
});

test('getFolderLeafItemPaths accurately collects all leaf item paths in folder subtree', () => {
  const files = [
    { path: 'Guidewire/Gosu/q1.txt', type: 'file' },
    { path: 'Guidewire/Gosu/q2.txt', type: 'file' }
  ];
  const videos = [
    { path: 'Guidewire/Gosu/Intro.mp4', type: 'video' }
  ];
  const items = [
    { path: 'Guidewire/Billing/guide.pdf', type: 'pdf' }
  ];
  const folders = ['Guidewire', 'Guidewire/Gosu', 'Guidewire/Billing', 'EmptyFolder'];

  const tree = buildTree(files, videos, folders, items);

  const gosuFolder = tree.children.get('Guidewire').children.get('Gosu');
  const gosuPaths = getFolderLeafItemPaths(gosuFolder);
  assert.equal(gosuPaths.length, 3);
  assert.equal(gosuPaths.includes('Guidewire/Gosu/q1.txt'), true);
  assert.equal(gosuPaths.includes('Guidewire/Gosu/q2.txt'), true);
  assert.equal(gosuPaths.includes('Guidewire/Gosu/Intro.mp4'), true);

  const emptyFolder = tree.children.get('EmptyFolder');
  assert.deepEqual(getFolderLeafItemPaths(emptyFolder), []);
});

test('calculateFolderProgressMap calculates "X of Y items viewed" and percentage correctly', () => {
  const files = [
    { path: 'Guidewire/Gosu/q1.txt', type: 'file' },
    { path: 'Guidewire/Gosu/q2.txt', type: 'file' },
    { path: 'Guidewire/Gosu/q3.txt', type: 'file' },
    { path: 'Guidewire/Gosu/q4.txt', type: 'file' }
  ];
  const items = [
    { path: 'Guidewire/Billing/b1.pdf', type: 'pdf' },
    { path: 'Guidewire/Billing/b2.pdf', type: 'pdf' }
  ];
  const folders = ['Guidewire', 'Guidewire/Gosu', 'Guidewire/Billing', 'EmptyFolder'];

  const tree = buildTree(files, [], folders, items);

  const viewedPaths = new Set([
    'Guidewire/Gosu/q1.txt',
    'Guidewire/Gosu/q2.txt',
    'Guidewire/Gosu/q3.txt',
    'Guidewire/Billing/b1.pdf'
  ]);

  const map = calculateFolderProgressMap(tree, viewedPaths);

  // Gosu folder: 3 of 4 viewed = 75%
  assert.equal(map['Guidewire/Gosu'].total, 4);
  assert.equal(map['Guidewire/Gosu'].viewed, 3);
  assert.equal(map['Guidewire/Gosu'].percent, 75);
  assert.equal(map['Guidewire/Gosu'].text, '3 of 4 items viewed');
  assert.equal(map['Guidewire/Gosu'].percentText, '75%');
  assert.equal(map['Guidewire/Gosu'].label, '3 of 4 items viewed (75%)');

  // Billing folder: 1 of 2 viewed = 50%
  assert.equal(map['Guidewire/Billing'].total, 2);
  assert.equal(map['Guidewire/Billing'].viewed, 1);
  assert.equal(map['Guidewire/Billing'].percent, 50);
  assert.equal(map['Guidewire/Billing'].label, '1 of 2 items viewed (50%)');

  // Guidewire parent folder: 4 of 6 viewed = 67%
  assert.equal(map['Guidewire'].total, 6);
  assert.equal(map['Guidewire'].viewed, 4);
  assert.equal(map['Guidewire'].percent, 67);
  assert.equal(map['Guidewire'].label, '4 of 6 items viewed (67%)');

  // Empty folder: 0 of 0 viewed = 0%
  assert.equal(map['EmptyFolder'].total, 0);
  assert.equal(map['EmptyFolder'].viewed, 0);
  assert.equal(map['EmptyFolder'].percent, 0);
  assert.equal(map['EmptyFolder'].label, '0 of 0 items viewed (0%)');
});

test('getFolderProgressForUser restricts progress display based on Notes role', async () => {
  const files = [
    { path: 'Guidewire/Gosu/q1.txt', type: 'file' }
  ];
  const folders = ['Guidewire', 'Guidewire/Gosu'];
  const tree = buildTree(files, [], folders, []);

  // Standard user WITHOUT Notes role: disabled
  const standardUser = { id: 1, email: 'learner@example.com', app_role: 'USER' };
  const mockDbNoNotes = {
    query: async () => ({ rows: [] })
  };
  const standardResult = await getFolderProgressForUser(standardUser, tree, mockDbNoNotes);
  assert.equal(standardResult.enabled, false);
  assert.deepEqual(standardResult.progressMap, {});

  // User WITH Notes role: enabled
  const notesUser = { id: 2, email: 'notes_user@example.com', notes_available: true };
  const mockDbWithSeen = {
    query: async (sql) => {
      if (sql.toLowerCase().includes('content_seen')) {
        return { rows: [{ item_path: 'Guidewire/Gosu/q1.txt' }] };
      }
      return { rows: [] };
    }
  };
  const notesResult = await getFolderProgressForUser(notesUser, tree, mockDbWithSeen);
  assert.equal(notesResult.enabled, true);
  assert.equal(notesResult.progressMap['Guidewire/Gosu'].total, 1);
  assert.equal(notesResult.progressMap['Guidewire/Gosu'].viewed, 1);
  assert.equal(notesResult.progressMap['Guidewire/Gosu'].percent, 100);
});

test('Progress calculation respects access control filtering', () => {
  const files = [
    { path: 'Guidewire/Public/q1.txt', type: 'file' },
    { path: 'Guidewire/Restricted/secret.txt', type: 'file' }
  ];
  const folders = ['Guidewire', 'Guidewire/Public', 'Guidewire/Restricted'];
  const tree = buildTree(files, [], folders, []);

  // User can only access Public folder
  const user = { id: 5, app_role: 'USER' };
  const canAccessFn = (u, p) => !p.startsWith('Guidewire/Restricted');

  const filteredTree = filterTreeForUser(tree, user, canAccessFn);

  // Even if user's history somehow has the restricted item, progress on filtered tree respects access control
  const viewedPaths = new Set(['Guidewire/Public/q1.txt', 'Guidewire/Restricted/secret.txt']);
  const progressMap = calculateFolderProgressMap(filteredTree, viewedPaths);

  // Guidewire folder total is 1 (only Public), NOT 2
  assert.equal(progressMap['Guidewire'].total, 1);
  assert.equal(progressMap['Guidewire'].viewed, 1);
  assert.equal(progressMap['Guidewire'].percent, 100);
  assert.equal(progressMap['Guidewire/Public'].total, 1);
  assert.equal(progressMap['Guidewire/Public'].viewed, 1);
});

test('library.ejs template renders progress indicators when showFolderProgress is true', async () => {
  const files = [
    { path: 'Guidewire/q1.txt', type: 'file' }
  ];
  const folders = ['Guidewire'];
  const tree = buildTree(files, [], folders, []);

  const folderProgress = {
    'Guidewire': {
      total: 10,
      viewed: 3,
      percent: 30,
      text: '3 of 10 items viewed',
      percentText: '30%',
      label: '3 of 10 items viewed (30%)'
    }
  };

  // Render library with showFolderProgress = true
  const htmlWithProgress = await ejs.renderFile(path.join(VIEWS_DIR, 'library.ejs'), {
    user: { id: 10, name: 'Alice', email: 'alice@example.com' },
    tree,
    folder: null,
    path: '',
    displayName: (p) => p,
    categoryForPath: () => 'General',
    contentRouteForPath: () => '/query/',
    showFolderProgress: true,
    folderProgress,
    recentlyViewed: [],
    newContent: [],
    newContentCount: 0,
    showAd: false,
    knowledgeEnabled: true,
    paidPlansEnabled: false
  });

  assert.equal(htmlWithProgress.includes('3 of 10 items viewed (30%)'), true);
  assert.equal(htmlWithProgress.includes('folder-progress'), true);

  // Render library with showFolderProgress = false
  const htmlWithoutProgress = await ejs.renderFile(path.join(VIEWS_DIR, 'library.ejs'), {
    user: { id: 11, name: 'Bob', email: 'bob@example.com' },
    tree,
    folder: null,
    path: '',
    displayName: (p) => p,
    categoryForPath: () => 'General',
    contentRouteForPath: () => '/query/',
    showFolderProgress: false,
    folderProgress: {},
    recentlyViewed: [],
    newContent: [],
    newContentCount: 0,
    showAd: false,
    knowledgeEnabled: true,
    paidPlansEnabled: false
  });

  assert.equal(htmlWithoutProgress.includes('items viewed'), false);
  assert.equal(htmlWithoutProgress.includes('folder-progress'), false);
});
