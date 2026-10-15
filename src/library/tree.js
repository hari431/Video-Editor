export function buildTree(files, videos = [], folders = [], items = []) {
  const root = { name: '', path: '', type: 'folder', children: new Map() };

  const ensureFolder = folderPath => {
    let node = root;
    for (const part of folderPath.split('/').filter(Boolean)) {
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          type: 'folder',
          children: new Map()
        });
      }
      node = node.children.get(part);
    }
  };

  for (const folderPath of folders) ensureFolder(folderPath);

  const addLeaf = (node, part, index, parts, type, record) => {
    const isFile = index === parts.length - 1;
    if (!node.children.has(part)) {
      node.children.set(part, {
        name: part,
        path: parts.slice(0, index + 1).join('/'),
        type: isFile ? type : 'folder',
        children: isFile ? undefined : new Map(),
        file: isFile ? record : undefined
      });
    }
    return node.children.get(part);
  };

  for (const video of videos) {
    const parts = video.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      node = addLeaf(node, part, index, parts, 'video', video);
    });
  }

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      node = addLeaf(node, part, index, parts, file.type, file);
    });
  }

  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      node = addLeaf(node, part, index, parts, item.type, item);
    });
  }

  return root;
}

export function folderAt(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    node = node.children?.get(part);
    if (!node || node.type !== 'folder') return null;
  }
  return node;
}

export function findFile(root, path) {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  const folder = folderAt(root, parts.join('/'));
  const file = folder?.children?.get(filename);
  if (!file) return null;
  if (file.type !== 'folder' && file.type !== 'video' && file.type !== 'external') {
    return file;
  }
  return null;
}

export function findVideo(root, path) {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  const folder = folderAt(root, parts.join('/'));
  const node = folder?.children?.get(filename);
  return node?.type === 'video' ? node : null;
}

export function findExternal(root, path) {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  const folder = folderAt(root, parts.join('/'));
  const node = folder?.children?.get(filename);
  return node?.type === 'external' ? node : null;
}

export function findExternalOrFile(root, path) {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  const folder = folderAt(root, parts.join('/'));
  const node = folder?.children?.get(filename);
  if (!node) return null;
  if (node.type !== 'folder') return node;
  return null;
}

export function allFiles(root) {
  const output = [];
  function walk(node) {
    if (node.type === 'folder') {
      if (node.children) {
        for (const child of node.children.values()) walk(child);
      }
    } else if (node.type !== 'video') {
      if (node.file) output.push(node.file);
    }
  }
  walk(root);
  return output;
}

export function searchFiles(root, term) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  return allFiles(root).filter(file => `${file.path}\n${file.content}`.toLowerCase().includes(q));
}

/** Deep-clone a tree, dropping branches that fail the access check. */
export function filterTreeForUser(root, user, canAccessFn) {
  function clone(node) {
    if (node.type !== 'folder') {
      if (node.path && !canAccessFn(user, node.path)) return null;
      return { ...node };
    }
    const children = new Map();
    if (node.children) {
      for (const [key, child] of node.children) {
        const filtered = clone(child);
        if (filtered) children.set(key, filtered);
      }
    }
    // Keep an inaccessible folder only as a breadcrumb to permitted content.
    if (node.path && !canAccessFn(user, node.path) && children.size === 0) return null;
    return { ...node, children };
  }
  return clone(root);
}

/** Search with per-result permission filtering. */
export function searchFilesFiltered(root, term, user, canAccessFn) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  return allFiles(root)
    .filter(file => canAccessFn(user, file.path))
    .filter(file => `${file.path}\n${file.content}`.toLowerCase().includes(q));
}

// Legacy URL safety-net: before the hierarchy was introduced, query content
// lived directly under PC/ (queries/PC/...). Now that it lives under
// Guidewire/Gosu/PC/..., old /browse/PC/* and /query/PC/* links would 404.
// When no entry exists at the requested path but one exists at the prefixed
// location, return the nested path so the server can redirect the old URL.
// Returns null when there is nothing to redirect (kept internal: PC is the only
// historical top-level segment).
export function legacyQueryPath(tree, pathValue) {
  if (pathValue !== 'PC' && !pathValue.startsWith('PC/')) return null;
  const mapped = `Guidewire/Gosu/${pathValue}`;
  if (folderAt(tree, mapped) || findFile(tree, mapped)) return mapped;
  return null;
}