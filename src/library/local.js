import { readdir, readFile, stat as fsStat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFileType, isViewable, isDownloadable, requiresStreaming, getMimeType, fileTypeRegistry } from './file-types.js';
import { pool } from '../db/pool.js';
import { isAdminUser } from '../auth/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = path.resolve(__dirname, '..', '..', 'queries');

export function getLibraryRoot() {
  return LIBRARY_ROOT;
}
const LIBRARY_METADATA_PATH = path.resolve(__dirname, '..', 'config', 'library-metadata.json');

// ---------- exports ----------

export const hiddenFolders = process.env.HIDDEN_FOLDERS
  ? process.env.HIDDEN_FOLDERS
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  : [];

export const SUPPORTED_TEXT_EXTENSIONS = new Set(['.txt', '.md']);

// === LIBRARY METADATA (Option D — explicit, durable across Git checkout/Render) ===
// File: src/config/library-metadata.json  { "<relPath>": { addedAt:"YYYY-MM-DD", updatedAt:"YYYY-MM-DD" } }
// Loaded once, cached, no per-item DB/stat/Git calls.
let libraryMetadataCache = null;
export function loadLibraryMetadata() {
  if (libraryMetadataCache) return libraryMetadataCache;
  try {
    if (existsSync(LIBRARY_METADATA_PATH)) {
      const raw = readFileSync(LIBRARY_METADATA_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      libraryMetadataCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } else {
      libraryMetadataCache = {};
    }
  } catch (err) {
    console.warn('[library-metadata] Failed to load:', err.message);
    libraryMetadataCache = {};
  }
  return libraryMetadataCache;
}
export function getLibraryMetadataForPath(relPath) {
  const map = loadLibraryMetadata();
  return map[relPath] || null;
}
export function invalidateLibraryMetadataCache() {
  libraryMetadataCache = null;
}

// === FILE TYPE REGISTRY: single source of truth ===
//
// The registry defines all supported file types with their extensions,
// MIME types, viewable/downloadable behavior, and browser rendering flags.
// This is imported from ./file-types.js and re-used here.
//
// Do not scatter extension checks throughout server.js - use
// getFileType(extension), isViewable(typeName), isDownloadable(typeName),
// requiresStreaming(typeName), and getMimeType(typeName) instead.

// === PATH SAFETY ===

export function isSafeLibraryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (value.includes('\\')) return false;
  if (path.posix.isAbsolute(value)) return false;
  if (!hasSafeSegments(value)) return false;

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  if (decoded === value) return true;
  if (decoded.includes('\\') || path.posix.isAbsolute(decoded)) return false;
  return hasSafeSegments(decoded);
}

export function resolveLibraryPath(relPath) {
  if (!isSafeLibraryPath(relPath)) return null;
  const abs = path.resolve(LIBRARY_ROOT, relPath);
  const rel = path.relative(LIBRARY_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

export function isPathRestricted(relPath) {
  if (!hiddenFolders.length || typeof relPath !== 'string' || !relPath) return false;
  return isRestrictedPath(relPath);
}

// === FOLDER PERMISSIONS (RBAC, DB-backed, cached) ===
//
// Resolution order:
//   1. HIDDEN_FOLDERS → absolute block (checked before DB)
//   2. Admin bypass → isAdminUser() always allowed
//   3. No folder_permissions row for path → denied
//   4. access_level = 'all' → allowed
//   5. access_level = 'admin' → admin-only (already handled in step 2, but explicit)
//   6. access_level = 'role' → user must hold at least one of the granted role_ids

let permCache = { expiresAt: 0, map: new Map() };

async function loadFolderPermissions() {
  const now = Date.now();
  if (permCache.map.size > 0 && now < permCache.expiresAt) return permCache.map;
  try {
    const result = await pool.query(
      `SELECT fp.folder_path, fp.access_level, fr.role_id, COALESCE(r.ads_available, FALSE) as ads_available
       FROM folder_permissions fp
      LEFT JOIN folder_roles fr ON fr.folder_path = fp.folder_path
      LEFT JOIN roles r ON r.id = fr.role_id`
    );
    const map = new Map();
    for (const row of result.rows) {
      let entry = map.get(row.folder_path);
      if (!entry) {
        entry = { accessLevel: row.access_level, roleIds: [], roleAdsMap: {} };
        map.set(row.folder_path, entry);
      }
      if (row.role_id != null) {
        const rid = Number(row.role_id);
        entry.roleIds.push(rid);
        entry.roleAdsMap[rid] = Boolean(row.ads_available);
      }
    }
    permCache = { expiresAt: now + 30_000, map };
  } catch {
    // table may not exist yet (migration pending) — treat as no overrides
    permCache = { expiresAt: now + 10_000, map: new Map() };
  }
  return permCache.map;
}

/** Synchronous: uses the last-fetched cache. Returns null if no override. */
export function getCachedPermission(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const map = permCache.map;
  if (!map.size) return null;
  const segments = relPath.split('/').filter(Boolean);
  for (let i = segments.length; i >= 1; i--) {
    const candidate = segments.slice(0, i).join('/');
    if (map.has(candidate)) return map.get(candidate);
  }
  return null;
}

/** Async: loads from DB if cache is cold, then resolves. */
async function resolveFolderPermission(relPath) {
  const map = await loadFolderPermissions();
  const segments = relPath.split('/').filter(Boolean);
  for (let i = segments.length; i >= 1; i--) {
    const candidate = segments.slice(0, i).join('/');
    if (map.has(candidate)) return map.get(candidate);
  }
  return null;
}

function userHasPermission(user, permEntry) {
  if (!permEntry) return false;
  const { accessLevel, roleIds } = permEntry;
  if (accessLevel === 'all') return true;
  if (accessLevel === 'admin') return isAdminUser(user);
  if (accessLevel === 'role') {
    if (isAdminUser(user)) return true;
    if (!user) return false;
    const allRoles = new Set([
      ...(user.roles || []),
      ...(user.paidProductRoleIds || [])
    ]);
    return roleIds.some(id => allRoles.has(id));
  }
  return false;
}

export async function canAccessLibraryPathAsync(user, relPath) {
  if (!user) return false;
  if (isPathRestricted(relPath)) return false;
  if (isAdminUser(user)) return true;
  const perm = await resolveFolderPermission(relPath);
  return userHasPermission(user, perm);
}

export function canAccessLibraryPath(user, relPath) {
  if (!user) return false;
  if (isPathRestricted(relPath)) return false;
  if (isAdminUser(user)) return true;
  const perm = getCachedPermission(relPath);
  return userHasPermission(user, perm);
}

export { loadFolderPermissions, resolveFolderPermission };

export function invalidatePermissionCache() {
  permCache = { expiresAt: 0, map: new Map() };
}

// === PIN COMPANION HELPERS (v2: generic hidden sidecar metadata) ===
// Convention: "<stem>_1.txt" next to a supported binary parent, e.g.
// "Guide.pdf" -> "Guide_1.txt", "Slides.pptx" -> "Slides_1.txt".
// Pure path helpers unless noted. External files ("External - ...") are
// never companions. Companionable parents are derived from the centralized
// file-type registry — no per-extension lists, no new file types.
export function isCompanionMetadataFilename(entryName) {
  if (typeof entryName !== 'string') return false;
  if (isExternalFileName(entryName)) return false;
  return /_1\.txt$/i.test(entryName.trim());
}

// A parent filename can own a hidden companion iff it is a recognized,
// non-text, non-video library item (pdf, office docs/spreadsheets/
// presentations, images, archives, ...). TXT/MD use embedded Pins and video
// pages never render Pins, so a "_1.txt" next to those stays a normal
// visible file (v1 behavior preserved). Unknown extensions are never parents.
export function isCompanionableParentFilename(entryName) {
  if (typeof entryName !== 'string') return false;
  const base = entryName.trim();
  if (!base || isExternalFileName(base)) return false;
  if (isCompanionMetadataFilename(base)) return false;
  const ext = path.extname(base).toLowerCase();
  if (!ext) return false;
  const { type } = getFileType(ext);
  if (type === 'unknown' || type === 'text' || type === 'markdown' || type === 'video') return false;
  return true;
}

// Every companionable extension, derived once from the registry in stable
// order (pdf, document, spreadsheet, presentation, image, archive).
let companionableExtCache = null;
export function companionableExtensions() {
  if (companionableExtCache) return companionableExtCache;
  const out = [];
  for (const [typeName, typeInfo] of Object.entries(fileTypeRegistry)) {
    if (typeName === 'text' || typeName === 'markdown' || typeName === 'video' || typeName === 'unknown') continue;
    if (!typeInfo || !typeInfo.extensions) continue;
    for (const ext of typeInfo.extensions) {
      const e = String(ext).toLowerCase();
      if (e && e !== '.' && !out.includes(e)) out.push(e);
    }
  }
  companionableExtCache = out;
  return out;
}

export function companionableExtensionSet() {
  return new Set(companionableExtensions());
}

// Root-aware resolver shared by pin code and tests: rootAbs=null resolves
// against the real queries/ root. Always contained — never escapes the root.
export function resolveLibraryRelPath(relPath, rootAbs) {
  if (rootAbs) {
    if (!isSafeLibraryPath(relPath)) return null;
    const abs = path.resolve(rootAbs, relPath);
    const rel = path.relative(rootAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
  }
  return resolveLibraryPath(relPath);
}

export function getCompanionLibraryRoot(rootAbs) {
  if (rootAbs) return rootAbs;
  return LIBRARY_ROOT;
}

// "A/B/Guide.pptx" -> "A/B/Guide_1.txt" for any extension; spaces and
// multiple dots preserved ("My Guide.pdf" -> "My Guide_1.txt",
// "Guidewire.PC.Rating.xlsx" -> "Guidewire.PC.Rating_1.txt").
// Returns null when not applicable. Rejects unsafe paths (traversal-safe)
// and never maps a companion to "Guide_1_1.txt".
export function companionPathForItem(itemRelPath) {
  if (typeof itemRelPath !== 'string' || !itemRelPath) return null;
  if (!isSafeLibraryPath(itemRelPath)) return null;
  const normalized = itemRelPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = slash === -1 ? '' : normalized.slice(0, slash);
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (!base || isExternalFileName(base)) return null;
  if (isCompanionMetadataFilename(base)) return null;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  if (!stem) return null;
  const companion = `${stem}_1.txt`;
  return dir ? `${dir}/${companion}` : companion;
}

// Reverse: "A/B/Guide_1.txt" -> ["A/B/Guide.pdf", "A/B/Guide.doc", ...] over
// every companionable registry extension. [] when not a companion filename.
export function companionTargetCandidates(companionRelPath) {
  if (typeof companionRelPath !== 'string' || !companionRelPath) return [];
  const normalized = companionRelPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = slash === -1 ? '' : normalized.slice(0, slash);
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (!isCompanionMetadataFilename(base)) return [];
  const stem = base.replace(/_1\.txt$/i, '');
  if (!stem) return [];
  return companionableExtensions().map(ext => (dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`));
}

// Walk-time predicate: hide a companion iff a candidate target exists in the
// discovered path set (lowercased, so Windows/local and Linux/Render agree).
// Callers build the set from all discovered file paths: O(1) per companion,
// no extra fs access, no full-filesystem scans.
export function isHiddenCompanionPath(companionRelPath, lowerPathSet) {
  const cands = companionTargetCandidates(companionRelPath);
  if (!cands.length || !lowerPathSet) return false;
  return cands.some(c => lowerPathSet.has(c.toLowerCase()));
}

// Shared disk scan: return the existing companionable parent's rel path, or
// null. Exact-case stats first (fast path), then a case-insensitive parent-
// directory scan so "GUIDE.PDF" still activates "Guide_1.txt" on Linux.
// Root-aware for tests; containment enforced by resolveLibraryRelPath.
export async function findCompanionParentOnDiskWithRoot(companionRelPath, rootAbs) {
  if (typeof companionRelPath !== 'string' || !companionRelPath) return null;
  if (!isSafeLibraryPath(companionRelPath)) return null;
  const normalized = companionRelPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = slash === -1 ? '' : normalized.slice(0, slash);
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (!isCompanionMetadataFilename(base)) return null;
  const stem = base.replace(/_1\.txt$/i, '');
  if (!stem) return null;
  const exts = companionableExtensions();
  for (const ext of exts) {
    const cand = dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`;
    const abs = resolveLibraryRelPath(cand, rootAbs);
    if (!abs) continue;
    try {
      const st = await fsStat(abs);
      if (st.isFile()) return cand;
    } catch {
      // missing — try next candidate, then the case-insensitive scan
    }
  }
  try {
    const dirAbs = !dir ? getCompanionLibraryRoot(rootAbs) : resolveLibraryRelPath(dir, rootAbs);
    if (!dirAbs) return null;
    const entries = await readdir(dirAbs, { withFileTypes: true });
    const stemLower = stem.toLowerCase();
    const extSet = companionableExtensionSet();
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (isExternalFileName(e.name)) continue;
      if (e.name.length <= stem.length) continue;
      if (e.name.slice(0, stem.length).toLowerCase() !== stemLower) continue;
      const rest = e.name.slice(stem.length);
      if (!rest.startsWith('.')) continue;
      if (!extSet.has(rest.toLowerCase())) continue;
      return dir ? `${dir}/${e.name}` : e.name;
    }
  } catch {
    // unreadable directory — not active
  }
  return null;
}

// Request-time check: hide a companion iff a companionable parent exists on
// disk. Used by route guards so direct /query|/item|/file|/download access to
// an active companion returns 404 even when the library tree cache is stale.
// Orphans (no parent) stay normal visible files.
export async function isHiddenCompanionOnDisk(companionRelPath) {
  return (await findCompanionParentOnDiskWithRoot(companionRelPath, null)) !== null;
}

// === EXTERNAL RESOURCE HELPERS ===
// Convention: filename starts with "External - " (case-insensitive, Windows-safe) → external resource
// Friendly name is text after prefix, extension stripped; content is URL.

export function isExternalFileName(entryName) {
  if (typeof entryName !== 'string') return false;
  return entryName.trim().toLowerCase().startsWith('external - ');
}

export function getExternalFriendlyName(entryName) {
  if (typeof entryName !== 'string') return 'External Resource';
  let name = entryName.replace(/^external - /i, '').trim();
  // Strip extension (e.g., .txt)
  name = name.replace(/\.[^.]+$/i, '').trim();
  return name || 'External Resource';
}

export function isValidExternalUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractYouTubeId(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    // youtu.be/<id>
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const id = u.pathname.slice(1).split('/')[0].split('?')[0].split('&')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
      return null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com') || host.endsWith('m.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['embed', 'shorts', 'v'].includes(p.toLowerCase()));
      if (idx !== -1 && parts[idx + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[idx + 1])) return parts[idx + 1];
    }
  } catch {
    return null;
  }
  return null;
}

export function isBloggerUrl(url) {
  if (!isValidExternalUrl(url)) return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'blogspot.com' || host.endsWith('.blogspot.com');
  } catch {
    return false;
  }
}

export function extractDriveFileId(url) {
  if (!isValidExternalUrl(url)) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:') return null;
    if (u.hostname.toLowerCase() !== 'drive.google.com') return null;
    const m = u.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(view|preview))?\/?$/);
    if (!m) return null;
    const id = m[1];
    if (id.length < 10 || id.length > 128) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

export function isDriveUrl(url) {
  return !!extractDriveFileId(url);
}

// Helper for Pinned fallback title (reused for both query and external)
function fallbackPinnedTitle(url){
  try{
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (extractYouTubeId(url)) return 'YouTube Video';
    if (isBloggerUrl(url)) return 'Blogger Post';
    if (isDriveUrl(url)) return 'Drive File';
    if (host) return host.replace(/^www\./,'');
    return 'Reference';
  }catch{ return 'Reference'; }
}

// Helper for pinned URLs: allow http/https or local /path
function isValidPinnedUrlLocal(url){
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  if (!t) return false;
  if (isValidExternalUrl(t)) return true;
  if (t.startsWith('/')){
    try{
      const decoded = decodeURIComponent(t);
      if (/^\/[^\s]*$/.test(t) && !t.includes('\\')) return true;
      const withoutLeading = t.replace(/^\//,'').split('?')[0].split('#')[0];
      if (withoutLeading && isSafeLibraryPath(withoutLeading)) return true;
    }catch{
      if (/^\/[^\s]*$/.test(t)) return true;
    }
  }
  return false;
}

// Per-video watermark directive for External - files: a `Watermark: <value>`
// line where value is true/false (also 1/0, yes/no, on/off, case-insensitive).
// Returns true/false, or null when absent/unrecognized (today's behavior).
export function parseExternalWatermarkValue(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

// Parse External - file raw content: first valid URL is externalUrl, Pinned: lines are references
// Returns { externalUrl, pinned, cleanContent, watermark } where cleanContent is file without
// Pinned lines (so raw Pinned syntax is not displayed). Valid Watermark: lines are likewise
// consumed (never displayed); unrecognized values are left visible, exactly as today.
// Supports 3-field Premium: Pinned: Premium | Title | URL  and legacy 2-field
// watermark is null when no valid Watermark: line exists (URL-only files behave as before).
export function parseExternalFileContent(rawContent){
  if (!rawContent || typeof rawContent !== 'string') return { externalUrl: '', pinned: [], cleanContent: rawContent || '', watermark: null };
  const lines = rawContent.split(/\r?\n/);
  const pinned = [];
  const cleanLines = [];
  let externalUrl = '';
  let watermark = null;
  for (const raw of lines){
    const trimmed = raw.trim();
    const m = trimmed.match(/^pinned\s*:\s*(.*)$/i);
    if (m){
      const rest = m[1].trim();
      if (!rest) continue;
      const parts = rest.split('|').map(p=>p.trim());
      let access='normal', title=null, url=null;
      if (parts.length >= 3){
        const firstLower = parts[0].toLowerCase();
        if (firstLower === 'premium'){
          access='premium';
          title = parts[1] || null;
          url = parts.slice(2).join('|').trim();
        } else if (firstLower === 'null' || firstLower === ''){
          access='normal';
          title = parts[1] || null;
          url = parts.slice(2).join('|').trim();
        } else {
          access='normal';
          title = (parts[0] + ' | ' + parts[1]).trim();
          if (!title) title=null;
          url = parts.slice(2).join('|').trim();
        }
        if (!title) title=null;
        if (!url) continue;
      } else if (parts.length === 2){
        title = parts[0] || null;
        url = parts[1] || '';
        if (!url) continue;
        access='normal';
        if (!title) title=null;
      } else if (parts.length === 1){
        url = parts[0] || '';
        if (!url) continue;
        access='normal';
      } else continue;
      if (!isValidPinnedUrlLocal(url)) continue;
      if (!title) title = fallbackPinnedTitle(url);
      if (access !== 'premium') access='normal';
      pinned.push({ title, url, access });
    } else {
      const wm = trimmed.match(/^watermark\s*:\s*(.+)$/i);
      if (wm) {
        const value = parseExternalWatermarkValue(wm[1]);
        if (value === null) {
          cleanLines.push(raw);
        } else if (watermark === null) {
          watermark = value;
        }
        continue;
      }
      if (!externalUrl && trimmed && isValidExternalUrl(trimmed)){
        externalUrl = trimmed;
      }
      cleanLines.push(raw);
    }
  }
  const cleanContent = cleanLines.join('\n');
  return { externalUrl, pinned, cleanContent, watermark };
}

// === INTERNAL HELPERS ===

function isRestrictedPath(value) {
  if (!hiddenFolders.length || typeof value !== 'string' || !value) return false;
  return hiddenFolders.some(restricted => {
    if (value === restricted) return true;
    return value.startsWith(restricted + '/');
  });
}

function hasSafeSegments(value) {
  return !value.split('/').some(part => part === '' || part === '.' || part === '..');
}

// === FILE CLASSIFICATION ===

function classifyFile(entryName, relPath, hasContent) {
  const lowerName = entryName.toLowerCase();
  const ext = path.extname(lowerName);

  // .txt files are classified as 'file' type for backward compatibility
  if (ext === '.txt') {
    return {
      path: relPath.replace(/\\/g, '/'),
      name: entryName,
      type: 'file',
      mimeType: 'text/plain',
      viewable: true,
      downloadable: true,
      requiresStreaming: false,
      extension: ext,
      ...(hasContent && { content: '' })
    };
  }

  const type = getFileType(ext).type;
  const mimeType = getMimeType(type);
  const v = isViewable(type);
  const d = isDownloadable(type);
  const rs = requiresStreaming(type);

  return {
    path: relPath.replace(/\\/g, '/'),
    name: entryName,
    type,
    mimeType,
    viewable: v,
    downloadable: d,
    requiresStreaming: rs,
    extension: ext
  };
}

// Returns true if the entry is a known video type
export function isVideoFileName(entryName) {
  const lower = entryName.toLowerCase();
  return fileTypeRegistry.video.extensions.has(path.extname(lower));
}

// Returns the correct content route prefix for a library path.
// Mirrors the routing logic in library.ejs: folder→/browse, video→/watch,
// .txt query file→/query, external→/external/, all other files→/item.
export function contentRouteForPath(itemPath) {
  const filename = path.basename(itemPath || '');
  if (isExternalFileName(filename)) return '/external/';
  const ext = path.extname(itemPath).toLowerCase();
  if (!ext) return '/browse/';
  if (fileTypeRegistry.video.extensions.has(ext)) return '/watch/';
  if (ext === '.txt') return '/query/';
  return '/item/';
}

// Returns the display name for a type
export function getTypeDisplayName(type) {
  if (type === 'external') return 'External';
  return fileTypeRegistry[type] ? fileTypeRegistry[type].label : 'Unknown';
}

// === LIBRARY WALK ===

export async function readQueryLibrary() {
  // .txt query files (content read for search) - backward compatible 'files' array
  const queryFiles = [];
  // Other discovered files (.md, .pdf, images, etc.)
  const discoveredFiles = [];
  const videos = [];
  const folders = [];

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        folders.push(relPath.replace(/\\/g, '/'));
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        // External - convention – filename starts with "External - " (case-insensitive, Windows-safe)
        // Must be checked before normal .txt handling
        if (isExternalFileName(entry.name)) {
          try {
            const raw = await readFile(abs, 'utf8');
            const { externalUrl: url, pinned, cleanContent, watermark } = parseExternalFileContent(raw);
            const friendly = getExternalFriendlyName(entry.name);
            const ytId = extractYouTubeId(url);
            const external = {
              path: relPath.replace(/\\/g, '/'),
              name: entry.name,
              friendlyName: friendly,
              type: 'external',
              mimeType: 'text/x-external',
              viewable: true,
              downloadable: false,
              requiresStreaming: false,
              extension: path.extname(entry.name).toLowerCase(),
              externalUrl: url,
              pinned,
              cleanContent,
              watermark: watermark ?? null,
              youtubeId: ytId,
              isYouTube: !!ytId,
              isValidUrl: isValidExternalUrl(url),
              content: `${friendly} ${url}`,
            };
            discoveredFiles.push(external);
          } catch {
            const friendly = getExternalFriendlyName(entry.name);
            discoveredFiles.push({
              path: relPath.replace(/\\/g, '/'),
              name: entry.name,
              friendlyName: friendly,
              type: 'external',
              mimeType: 'text/x-external',
              viewable: true,
              downloadable: false,
              requiresStreaming: false,
              extension: path.extname(entry.name).toLowerCase(),
              externalUrl: '',
              youtubeId: null,
              isYouTube: false,
              isValidUrl: false,
              watermark: null,
              content: friendly,
            });
          }
          continue;
        }

        const lowerName = entry.name.toLowerCase();
        const ext = path.extname(lowerName);

        // .txt files: read content for search (query files)
        if (ext === '.txt') {
          try {
            const content = await readFile(abs, 'utf8');
            const classified = classifyFile(entry.name, relPath, true);
            classified.content = content;
            queryFiles.push(classified);
          } catch {
            const classified = classifyFile(entry.name, relPath, false);
            classified.content = '';
            queryFiles.push(classified);
          }
        } else if (ext === '.md') {
          // Markdown: classify but don't read binary content
          const classified = classifyFile(entry.name, relPath, false);
          discoveredFiles.push(classified);
        } else if (isVideoFileName(entry.name)) {
          // Video files: no content read, type forced to 'video'
          const classified = classifyFile(entry.name, relPath, false);
          classified.type = 'video';
          videos.push(classified);
        } else {
          // Other supported types (pdf, doc, xls, ppt, images, zip, etc.):
          // classify but don't read binary content during discovery;
          // unknown extensions are silently ignored
          const typeInfo = getFileType(ext);
          if (typeInfo.type !== 'unknown') {
            const classified = classifyFile(entry.name, relPath, false);
            discoveredFiles.push(classified);
          }
          // Unknown extensions: silently ignored
        }
      }
    }
  }

  await walk(LIBRARY_ROOT, '');
  // v2 Pins: hide active companion metadata files ("<stem>_1.txt" next to an
  // existing companionable parent: pdf, office docs, images, archives, ...).
  // Companions never appear as standalone library items; their Pin content is
  // read on demand for the parent item. A "_1.txt" WITHOUT an existing target
  // stays a normal .txt file (fail-closed, no data hiding).
  if (queryFiles.length) {
    const lowerSet = new Set();
    for (const f of queryFiles) lowerSet.add(String(f.path || '').toLowerCase());
    for (const it of discoveredFiles) lowerSet.add(String(it.path || '').toLowerCase());
    for (const v of videos) lowerSet.add(String(v.path || '').toLowerCase());
    const kept = [];
    for (const f of queryFiles) {
      const base = String(f.path || '').split('/').pop() || '';
      if (isCompanionMetadataFilename(base) && isHiddenCompanionPath(f.path, lowerSet)) continue;
      kept.push(f);
    }
    queryFiles.length = 0;
    queryFiles.push(...kept);
  }
  // Return legacy structure plus newly discovered non-txt, non-video items
  // (pdf, doc, xls, ppt, images, etc.) so they enter the library tree.
  return { files: queryFiles, videos, folders, items: discoveredFiles };
}

// Legacy: backward-compatible return structure
// Returns { files, videos, folders } where files contains only .txt query files
export function getLegacyStructure(state) {
  const { files, videos, folders } = state;
  return { files, videos, folders };
}