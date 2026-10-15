import { contentRouteForPath, getTypeDisplayName, isSafeLibraryPath, canAccessLibraryPath } from './local.js';
import { folderAt } from './tree.js';

export const MAX_RELATED = 6;

const AREA_SEGMENTS = new Set(['PC', 'BC', 'CC']);

function encodeLibraryPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function defaultCategoryForPath(filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Uncategorized';
}

function parentFolderOf(itemPath) {
  const parts = String(itemPath).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function areaRootForPath(itemPath) {
  const parts = String(itemPath).split('/').filter(Boolean);
  const idx = parts.findIndex(seg => AREA_SEGMENTS.has(seg));
  if (idx === -1) return null;
  return parts.slice(0, idx + 1).join('/');
}

function collectLeaves(node, out) {
  if (!node) return;
  if (node.type !== 'folder') {
    out.push(node);
    return;
  }
  if (node.children) {
    for (const child of node.children.values()) collectLeaves(child, out);
  }
}

function kindForLeaf(node) {
  if (node.type === 'video') return 'video';
  if (node.type === 'file') return 'text';
  return node.type;
}

function typeLabelForKind(kind) {
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  return getTypeDisplayName(kind);
}

function titleForName(name) {
  return String(name).replace(/\.[^.]+$/i, '');
}

function toRelatedItem(leafPath, leafName, leafKind, routeFor, categoryFor) {
  const kind = leafKind;
  return {
    path: leafPath,
    name: leafName,
    title: titleForName(leafName),
    kind,
    typeLabel: typeLabelForKind(kind),
    href: routeFor(leafPath) + encodeLibraryPath(leafPath),
    category: categoryFor(leafPath)
  };
}

// Determine related content using the existing library hierarchy only.
// Tier 1: all leaves under the same immediate folder (recursive, so nested
//   subfolders of the immediate category count).
// Tier 2: other leaves under the same broader Guidewire area (PC/BC/CC).
// Tier 3: any other leaves in the library (fills to max so sparse folders
//   still show something useful).
// Deterministic: every tier is sorted by path (localeCompare). No AI,
// no embeddings, no vector search, no DB table.
// Filters: excludes current item, folders (leaves only), unsafe paths,
// inaccessible paths (canAccess), and missing/deleted files (existsAsync).
// Only walks subtrees that are needed: area and full-library walks are
// skipped when earlier tiers already satisfy max after filtering.
export async function getRelatedContent(tree, currentPath, user, opts = {}) {
  const max = opts.max ?? MAX_RELATED;
  if (!tree || typeof currentPath !== 'string' || !currentPath) return [];
  const isSafe = opts.isSafe ?? isSafeLibraryPath;
  const canAccess = opts.canAccess ?? canAccessLibraryPath;
  const existsAsync = opts.existsAsync ?? (async () => true);
  const routeFor = opts.routeFor ?? contentRouteForPath;
  const categoryFor = opts.categoryFor ?? defaultCategoryForPath;

  if (!isSafe(currentPath)) return [];

  const seen = new Set([currentPath]);
  const picked = [];

  async function consider(nodes) {
    const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
    for (const node of sorted) {
      if (picked.length >= max) break;
      const p = node.path;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (!isSafe(p)) continue;
      let allowed = false;
      try {
        allowed = canAccess(user, p);
      } catch {
        allowed = false;
      }
      if (!allowed) continue;
      let exists = false;
      try {
        exists = await existsAsync(p);
      } catch {
        exists = false;
      }
      if (!exists) continue;
      picked.push(toRelatedItem(p, node.name, kindForLeaf(node), routeFor, categoryFor));
    }
  }

  // Tier 1: same immediate folder (efficient: single folderAt + subtree walk).
  const parent = parentFolderOf(currentPath);
  if (parent) {
    const folder = folderAt(tree, parent);
    if (folder) {
      const siblings = [];
      collectLeaves(folder, siblings);
      await consider(siblings);
      if (picked.length >= max) return picked.slice(0, max);
    }
  }

  // Tier 2: same broader Guidewire area (PC/BC/CC) where appropriate.
  const areaRoot = areaRootForPath(currentPath);
  if (areaRoot && areaRoot !== parent) {
    const areaNode = folderAt(tree, areaRoot);
    if (areaNode) {
      const areaLeaves = [];
      collectLeaves(areaNode, areaLeaves);
      await consider(areaLeaves);
      if (picked.length >= max) return picked.slice(0, max);
    }
  }

  // Tier 3: remainder of the library (only when earlier tiers were sparse).
  const all = [];
  collectLeaves(tree, all);
  await consider(all);

  return picked.slice(0, max);
}

export { parentFolderOf };
