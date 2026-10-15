import { writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { fileTypeRegistry } from '../src/library/file-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const OUTPUT_FILE = resolve(ROOT_DIR, 'src', 'config', 'content-manifest.json');
const LIBRARY_METADATA_FILE = resolve(ROOT_DIR, 'src', 'config', 'library-metadata.json');
const QUERIES_DIR = resolve(ROOT_DIR, 'queries');

/**
 * Generates src/config/content-manifest.json using Git commit timestamps.
 * If git is not available or directory is not a git repo, preserves existing manifest or writes empty object.
 */
export function generateContentManifest() {
  const manifest = {};
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'] });
    const logOutput = execSync('git log --format="format:COMMIT_TIME:%ct" --name-only queries/', {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    let currentTimestamp = null;
    const lines = logOutput.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('COMMIT_TIME:')) {
        const sec = parseInt(trimmed.substring('COMMIT_TIME:'.length), 10);
        if (Number.isFinite(sec)) currentTimestamp = sec * 1000;
      } else if (currentTimestamp && trimmed.startsWith('queries/')) {
        const itemRelPath = trimmed.replace(/^queries\//, '').replace(/\\/g, '/');
        if (itemRelPath && manifest[itemRelPath] === undefined) manifest[itemRelPath] = currentTimestamp;
      }
    }
  } catch (err) {
    if (existsSync(OUTPUT_FILE)) return manifest;
  }
  try {
    writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (writeErr) {
    console.warn('[content-manifest] Failed to write manifest file:', writeErr.message);
  }
  return manifest;
}

// --- Library metadata helpers ---

function isExternalFileName(name){
  return typeof name==='string' && name.trim().toLowerCase().startsWith('external - ');
}
// v2 Pins: companion metadata files ("<stem>_1.txt") are hidden from normal
// listings when a companionable parent exists next to them. Mirrors
// src/library/local.js companion helpers (kept local to avoid ESM import
// cycles in this script context). Companionable = registry-known, non-text,
// non-video (pdf, office docs, images, archives, ...). No new file types.
const COMPANIONABLE_EXTS = (() => {
  const out = [];
  for (const [typeName, reg] of Object.entries(fileTypeRegistry)){
    if (typeName === 'text' || typeName === 'markdown' || typeName === 'video' || typeName === 'unknown') continue;
    if (!reg || !reg.extensions) continue;
    for (const e of reg.extensions){
      const ext = String(e).toLowerCase();
      if (ext && ext !== '.' && !out.includes(ext)) out.push(ext);
    }
  }
  return out;
})();
export function isCompanionMetadataName(name){
  if (typeof name !== 'string') return false;
  if (isExternalFileName(name)) return false;
  return /_1\.txt$/i.test(name.trim());
}
export function hasCompanionTargetSync(dir, base){
  const stem = base.replace(/_1\.txt$/i, '');
  if (!stem) return false;
  // Exact-case fast path.
  for (const ext of COMPANIONABLE_EXTS){
    try {
      if (existsSync(join(dir, stem + ext))) return true;
    } catch {}
  }
  // Case-insensitive fallback (Linux "GUIDE.PDF" next to "Guide_1.txt").
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const stemLower = stem.toLowerCase();
    for (const e of entries){
      if (!e.isFile()) continue;
      if (e.name.length <= stem.length) continue;
      if (e.name.slice(0, stem.length).toLowerCase() !== stemLower) continue;
      const rest = e.name.slice(stem.length);
      if (!rest.startsWith('.')) continue;
      if (COMPANIONABLE_EXTS.includes(rest.toLowerCase())) return true;
    }
  } catch {}
  return false;
}
function isSupportedLibraryFile(name){
  if (isExternalFileName(name)) return true;
  const ext = extname(name.toLowerCase());
  if (ext === '.txt' || ext === '.md') return true;
  for (const type of Object.keys(fileTypeRegistry)){
    const reg = fileTypeRegistry[type];
    if (reg && reg.extensions && reg.extensions.has(ext)) return true;
  }
  return false;
}
function walkLibraryFiles(){
  const out=[];
  function walk(dir, rel){
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries){
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()){
        walk(abs, relPath);
      } else if (e.isFile()){
        if (!isSupportedLibraryFile(e.name)) continue;
        // v2 Pins: skip active companions (they render on the parent item).
        // Orphan "_1.txt" files (no target) stay normal library files.
        if (isCompanionMetadataName(e.name) && hasCompanionTargetSync(dir, e.name)) continue;
        out.push(relPath.replace(/\\/g,'/'));
      }
    }
  }
  if (existsSync(QUERIES_DIR)) walk(QUERIES_DIR, '');
  return out.sort((a,b)=>a.localeCompare(b));
}
function toIsoUtc(dateInput){
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
function todayIsoUtc(){
  return new Date().toISOString();
}
function normalizeToIso(maybeDate){
  if (!maybeDate || typeof maybeDate !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(maybeDate.trim())){
    return `${maybeDate.trim()}T00:00:00.000Z`;
  }
  const d = new Date(maybeDate);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}
function getGitFirstAddedIso(relPath){
  try {
    const out = execSync(`git log --follow --diff-filter=A --format=%aI -- "queries/${relPath}"`, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
    const lines = out.split('\n').map(s=>s.trim()).filter(Boolean);
    if (lines.length===0) return null;
    const iso = new Date(lines[0]).toISOString();
    if (!Number.isNaN(new Date(iso).getTime())) return iso;
  } catch {}
  return null;
}
function getGitLastUpdatedIso(relPath){
  try {
    const out = execSync(`git log -1 --format=%aI -- "queries/${relPath}"`, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
    const trimmed = out.trim();
    if (!trimmed) return null;
    const iso = new Date(trimmed).toISOString();
    if (!Number.isNaN(new Date(iso).getTime())) return iso;
  } catch {}
  return null;
}
function isGitAvailable(){
  try { execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT_DIR, stdio: ['ignore','pipe','ignore'] }); return true; } catch { return false; }
}
function getFilesystemTimestamps(relPath){
  try {
    const abs = join(QUERIES_DIR, relPath);
    const st = statSync(abs);
    const mtimeIso = st.mtime ? new Date(st.mtime).toISOString() : null;
    let birthtimeIso = null;
    if (st.birthtime && st.birthtime.getTime() !== 0 && !Number.isNaN(st.birthtime.getTime())) {
      birthtimeIso = new Date(st.birthtime).toISOString();
    } else if (st.ctime) {
      birthtimeIso = new Date(st.ctime).toISOString();
    }
    if (birthtimeIso && mtimeIso && new Date(birthtimeIso) > new Date(mtimeIso)) birthtimeIso = mtimeIso;
    return { birthtimeIso, mtimeIso };
  } catch { return { birthtimeIso: null, mtimeIso: null }; }
}
function isFileDirty(relPath){
  try {
    const out = execSync(`git status --porcelain -- "queries/${relPath}"`, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
    return out.trim().length > 0;
  } catch { return false; }
}

export function generateLibraryMetadata(){
  const startMs = Date.now();
  let existing = {};
  try {
    if (existsSync(LIBRARY_METADATA_FILE)){
      existing = JSON.parse(readFileSync(LIBRARY_METADATA_FILE,'utf8'));
      if (!existing || typeof existing!=='object' || Array.isArray(existing)) existing = {};
    }
  } catch (e){
    console.warn('[library-metadata] Failed to read existing metadata:', e.message);
    existing = {};
  }
  // Load content-manifest for precise Git timestamps (Unix ms -> ISO) to prefer over date-only
  let contentManifest = {};
  try {
    if (existsSync(OUTPUT_FILE)){
      contentManifest = JSON.parse(readFileSync(OUTPUT_FILE,'utf8'));
    }
  } catch {}
  const currentFiles = walkLibraryFiles();
  const currentSet = new Set(currentFiles);
  const gitAvailable = isGitAvailable();
  if (!gitAvailable) console.warn('[library-metadata] Git not available — new files will use filesystem timestamps, existing addedAt preserved');
  const next = {};
  let added=0, updated=0, preserved=0, removed=0;
  for (const rel of currentFiles){
    const prev = existing[rel];
    const absExists = existsSync(join(QUERIES_DIR, rel));
    let fsTimes = null;
    if (absExists) fsTimes = getFilesystemTimestamps(rel);
    const dirty = gitAvailable ? isFileDirty(rel) : true; // if git unavailable, treat as dirty to allow fs mtime
    if (prev && prev.addedAt && prev.updatedAt){
      // migrate date-only to ISO if needed
      let prevAddedIso = normalizeToIso(prev.addedAt) || prev.addedAt;
      let prevUpdatedIso = normalizeToIso(prev.updatedAt) || prev.updatedAt;
      // prefer precise content-manifest ms for updatedAt if existing was date-only and manifest has precise
      if (/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(prevUpdatedIso) && contentManifest[rel]){
        const ms = contentManifest[rel];
        if (Number.isFinite(ms)){
          const precise = new Date(ms).toISOString();
          if (precise !== prevUpdatedIso) {
            prevUpdatedIso = precise;
            // don't count as updated yet, just migration
          }
        }
      }
      // addedAt never overwritten
      let newUpdatedIso = prevUpdatedIso;
      let candidate = null;
      if (gitAvailable){
        const gitLast = getGitLastUpdatedIso(rel);
        if (gitLast) candidate = gitLast;
      }
      // For uncommitted modifications, filesystem mtime is authoritative
      if (dirty && fsTimes && fsTimes.mtimeIso){
        if (!candidate || new Date(fsTimes.mtimeIso) > new Date(candidate)){
          candidate = fsTimes.mtimeIso;
        }
      }
      // Also consider content-manifest precise ms as candidate (already covers gitLast, but keep)
      if (contentManifest[rel]){
        const cmIso = new Date(contentManifest[rel]).toISOString();
        if (!candidate || new Date(cmIso) > new Date(candidate)) candidate = cmIso;
      }
      if (candidate && new Date(candidate) > new Date(prevUpdatedIso)){
        newUpdatedIso = candidate;
        updated++;
      } else {
        preserved++;
      }
      next[rel] = { addedAt: prevAddedIso, updatedAt: newUpdatedIso };
    } else {
      // new file
      let addIso = null, updIso = null;
      if (gitAvailable){
        const first = getGitFirstAddedIso(rel);
        const last = getGitLastUpdatedIso(rel);
        if (first) addIso = new Date(first).toISOString();
        if (last) updIso = new Date(last).toISOString();
      }
      // For uncommitted new files, git may be empty, use filesystem
      if (!addIso || !updIso){
        if (fsTimes){
          if (!addIso) addIso = fsTimes.birthtimeIso || fsTimes.mtimeIso || todayIsoUtc();
          if (!updIso) updIso = fsTimes.mtimeIso || todayIsoUtc();
          if (dirty) console.log(`[library-metadata] Uncommitted new/modified "${rel}" using filesystem timestamps`);
        } else {
          const today = todayIsoUtc();
          addIso = addIso || today;
          updIso = updIso || today;
        }
      }
      if (!addIso) addIso = todayIsoUtc();
      if (!updIso) updIso = todayIsoUtc();
      if (new Date(updIso) < new Date(addIso)) updIso = addIso;
      next[rel] = { addedAt: addIso, updatedAt: updIso };
      added++;
    }
  }
  for (const key of Object.keys(existing)){
    if (!currentSet.has(key)) removed++;
  }
  const sortedKeys = Object.keys(next).sort((a,b)=>a.localeCompare(b));
  const sortedOut = {};
  for (const k of sortedKeys) sortedOut[k]=next[k];
  try {
    writeFileSync(LIBRARY_METADATA_FILE, JSON.stringify(sortedOut, null, 2)+'\n','utf8');
  } catch (e){
    console.warn('[library-metadata] Failed to write:', e.message);
    return next;
  }
  const elapsed = Date.now()-startMs;
  console.log(`[library-metadata] added:${added} updated:${updated} preserved:${preserved} removed:${removed} total:${sortedKeys.length} in ${elapsed}ms`);
  if (removed>0) console.log(`[library-metadata] Removed ${removed} stale entries`);
  if (!gitAvailable) console.log('[library-metadata] Note: .git unavailable — existing historical dates preserved, new files use filesystem timestamps');
  return sortedOut;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateContentManifest();
  generateLibraryMetadata();
}
