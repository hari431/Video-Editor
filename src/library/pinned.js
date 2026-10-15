import { stat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isValidExternalUrl, extractYouTubeId, isBloggerUrl, isDriveUrl, isSafeLibraryPath, resolveLibraryRelPath, getLibraryRoot, isExternalFileName, companionPathForItem, isCompanionMetadataFilename, isCompanionableParentFilename } from './local.js';

function isValidPinnedUrl(url){
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  if (!t) return false;
  if (isValidExternalUrl(t)) return true;
  // Local website paths like /query/..., /video/..., /item/..., /browse/..., /external/...
  if (t.startsWith('/')){
    // allow URL-encoded paths, reject javascript: etc. which isValidExternalUrl already covers
    // Consider valid if it looks like a safe internal route
    try{
      const decoded = decodeURIComponent(t);
      // basic check: starts with / and not containing spaces or control chars
      if (/^\/[^\s]*$/.test(t) && !t.includes('\\')) return true;
      // also check isSafeLibraryPath for the path without leading /
      const withoutLeading = t.replace(/^\//,'').split('?')[0].split('#')[0];
      if (withoutLeading && isSafeLibraryPath(withoutLeading)) return true;
    }catch{
      // if decode fails, still consider valid if starts with /
      if (/^\/[^\s]*$/.test(t)) return true;
    }
  }
  return false;
}

function fallbackTitleForUrl(url){
  try{
    if (url.trim().startsWith('/')){
      // For local paths, use last segment as fallback
      const parts = url.trim().split('/').filter(Boolean);
      const last = parts[parts.length-1] || 'Reference';
      try{ return decodeURIComponent(last.replace(/\.[^.]+$/,'')) || 'Reference'; }catch{ return last || 'Reference'; }
    }
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (extractYouTubeId(url)) return 'YouTube Video';
    if (isBloggerUrl(url)) return 'Blogger Post';
    if (isDriveUrl(url)) return 'Drive File';
    if (host) return host.replace(/^www\./,'');
    return 'Reference';
  }catch{
    // fallback for local paths that failed URL parsing
    if (url.trim().startsWith('/')){
      const parts = url.trim().split('/').filter(Boolean);
      const last = parts[parts.length-1] || 'Reference';
      return last;
    }
    return 'Reference';
  }
}

/**
 * Parse Pinned: lines from file content.
 * Returns { cleanContent, pinned } where pinned is array of { title, url, access } in source order.
 * The "Pinned" prefix accepts BOTH separators (identical meaning after the prefix):
 *  - Canonical: Pinned: <...>  (colon form)
 *  - Forgiving: Pinned | <...>  (pipe form; "Pinned | Premium | Title | URL"
 *    parses exactly like "Pinned: Premium | Title | URL")
 * Supports:
 *  - Legacy: Pinned: <Title> | <URL>  (access=normal)
 *  - Legacy: Pinned: <URL> (access=normal, title fallback)
 *  - New 3-field: Pinned: <Access> | <Title> | <URL> where <Access> is Premium/Null/blank (case-insensitive, trimmed)
 *    - Premium (any case/whitespace) => access="premium"
 *    - Null, blank, or missing => access="normal"
 *    - Any other first field => treat as legacy 2-field to avoid breaking titles
 * - Trims, ignores blank, validates URL via isValidPinnedUrl
 * - Does not fetch or scrape external URLs
 * - Title fallback based on URL type
 */
export function parsePinnedReferences(content){
  if (!content || typeof content !== 'string') return { cleanContent: content || '', pinned: [] };
  const lines = content.split(/\r?\n/);
  const pinned = [];
  const cleanLines = [];
  for (const raw of lines){
    const trimmed = raw.trim();
    const m = trimmed.match(/^pinned\s*[:|]\s*(.*)$/i);
    if (m){
      const rest = m[1].trim();
      if (!rest) continue; // blank Pinned line (both `Pinned:` and `Pinned |`)
      const parts = rest.split('|').map(p=>p.trim());
      let access = 'normal';
      let title = null;
      let url = null;
      if (parts.length >= 3){
        const firstLower = parts[0].toLowerCase();
        if (firstLower === 'premium'){
          access = 'premium';
          title = parts[1] || null;
          url = parts.slice(2).join('|').trim();
        } else if (firstLower === 'null' || firstLower === ''){
          access = 'normal';
          title = parts[1] || null;
          url = parts.slice(2).join('|').trim();
        } else {
          // Unknown first field, preserve legacy: title is first two parts joined with " | ", url is last part
          // e.g. "SomethingElse | Video Name | /video/path" => title "SomethingElse | Video Name", url "/video/path"
          access = 'normal';
          title = (parts[0] + ' | ' + parts[1]).trim();
          if (!title) title = null;
          url = parts.slice(2).join('|').trim();
        }
        if (!title) title = null;
        if (!url) continue;
      } else if (parts.length === 2){
        // Legacy 2-field: Title | URL
        title = parts[0] || null;
        url = parts[1] || '';
        if (!url) continue;
        access = 'normal';
        if (!title) title = null;
      } else if (parts.length === 1){
        url = parts[0] || '';
        if (!url) continue;
        access = 'normal';
      } else {
        continue;
      }
      if (!isValidPinnedUrl(url)) continue;
      if (!title) title = fallbackTitleForUrl(url);
      // Normalize access
      if (access !== 'premium') access = 'normal';
      pinned.push({ title, url, access });
    } else {
      cleanLines.push(raw);
    }
  }
  return { cleanContent: cleanLines.join('\n'), pinned };
}

/**
 * For External - *.txt files, the file contains the main external URL
 * plus optional Pinned: references. This helper separates them.
 * Returns { externalUrl, pinned, cleanContent } where cleanContent is the file
 * without Pinned lines (so raw Pinned syntax is not displayed).
 * externalUrl is the first non-empty, non-Pinned line that is a valid URL.
 * If no valid externalUrl found, returns { externalUrl:'', pinned, cleanContent }.
 */
export function parseExternalFileContent(rawContent){
  if (!rawContent || typeof rawContent !== 'string') return { externalUrl: '', pinned: [], cleanContent: rawContent || '' };
  const { cleanContent, pinned } = parsePinnedReferences(rawContent);
  // Find first valid URL among non-Pinned lines (cleanContent lines)
  const lines = cleanContent.split(/\r?\n/);
  let externalUrl = '';
  for (const line of lines){
    const t = line.trim();
    if (!t) continue;
    if (isValidExternalUrl(t)){
      externalUrl = t;
      break;
    }
  }
  // If no valid URL found in cleanContent (e.g. file only had Pinned lines), fallback to first pinned URL? No, keep empty
  return { externalUrl, pinned, cleanContent };
}

// === V2 GENERALIZED PINS (read-only) ===
// Single canonical syntax (parsePinnedReferences above) reused for:
//  - TXT/MD: embedded Pin lines read as UTF-8 text
//  - DOCX: embedded Pin lines via mammoth.extractRawText + sidecar fallback
//    (unioned, deduped, order preserved; never modified)
//  - Every other companionable binary (pdf, doc, xls/xlsx/csv, ppt/pptx,
//    images, archives, ...): sidecar "<stem>_1.txt" companion only.
//    Binaries are never parsed for Pins and never modified.
// External behavior is unchanged and handled elsewhere; this module never
// touches External files (callers must exclude them).
//
// Caps: companion 64KB, text 256KB, docx raw 200k chars, max 50 refs.
// Failures always resolve to [] so pages still render without a Pinned section.

export const PIN_V1_MAX_COMPANION_BYTES = 64 * 1024;
export const PIN_V1_MAX_TEXT_BYTES = 256 * 1024;
export const PIN_V1_MAX_DOCX_CHARS = 200000;
export const PIN_V1_MAX_REFS = 50;
const PIN_V1_CACHE_TTL_MS = 60 * 1000;
const pinV1Cache = new Map();

export function _clearPinV1Cache() {
  pinV1Cache.clear();
}

export function dedupePinnedRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || typeof r.url !== 'string') continue;
    const key = `${r.title || ''}\u0000${r.url}\u0000${r.access || 'normal'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= PIN_V1_MAX_REFS) break;
  }
  return out;
}

// Strip Pin paragraphs from mammoth HTML previews so the canonical syntax
// does not leak into the rendered preview. Operates on the converted HTML
// string only; the source .docx bytes are never modified.
export function stripPinnedParagraphsFromHtml(html) {
  if (!html || typeof html !== 'string') return html || '';
  const stripped = html.replace(/<p[^>]*>\s*pinned\s*[:|].*?<\/p>/gis, '');
  // Collapse emptied paragraphs left behind (e.g. <p><strong></strong></p> is kept).
  return stripped.replace(/<p[^>]*>\s*(?:<br\s*\/?>\s*)*<\/p>/gi, '');
}

async function readTextCapped(absPath, maxBytes) {
  const st = await stat(absPath);
  if (!st.isFile()) return '';
  if (st.size <= 0 || st.size > 8 * 1024 * 1024) return '';
  const raw = await readFile(absPath, 'utf8');
  if (typeof raw !== 'string' || !raw) return '';
  // Truncate on line boundary to avoid splitting a Pin line.
  if (raw.length <= maxBytes) return raw;
  const slice = raw.slice(0, maxBytes);
  const nl = slice.lastIndexOf('\n');
  return nl > 0 ? slice.slice(0, nl) : slice;
}

function parseTextToPins(text) {
  if (!text || typeof text !== 'string') return [];
  // Cheap pre-check before full parse (both `Pinned:` and `Pinned |` forms).
  if (!/pinned\s*[:|]/i.test(text)) return [];
  try {
    const { pinned } = parsePinnedReferences(text);
    return Array.isArray(pinned) ? pinned : [];
  } catch {
    return [];
  }
}

// Locate the sidecar's bytes: exact-case first, then a case-insensitive
// same-directory scan so "GUIDE.PDF" + "Guide_1.txt" still resolves on Linux.
// Returns { abs, mtimeMs } or null. Containment enforced by
// resolveLibraryRelPath — never escapes the root.
async function statCompanionWithRoot(companionRel, rootAbs) {
  const direct = resolveLibraryRelPath(companionRel, rootAbs);
  if (direct) {
    try {
      const st = await stat(direct);
      if (st.isFile()) return { abs: direct, mtimeMs: st.mtimeMs || 0 };
    } catch {
      // fall through to the case-insensitive scan
    }
  }
  try {
    const normalized = companionRel.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const dir = slash === -1 ? '' : normalized.slice(0, slash);
    const base = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dirAbs = !dir ? getLibraryRootForPinsRoot(rootAbs) : resolveLibraryRelPath(dir, rootAbs);
    if (!dirAbs) return null;
    const entries = await readdir(dirAbs, { withFileTypes: true });
    const want = base.toLowerCase();
    for (const e of entries) {
      if (!e.isFile() || e.name.toLowerCase() !== want) continue;
      const foundRel = dir ? `${dir}/${e.name}` : e.name;
      const abs = resolveLibraryRelPath(foundRel, rootAbs);
      if (!abs) continue;
      try {
        const st = await stat(abs);
        if (st.isFile()) return { abs, mtimeMs: st.mtimeMs || 0 };
      } catch {
        // keep scanning
      }
    }
  } catch {
    // unreadable directory — no sidecar
  }
  return null;
}

function getLibraryRootForPinsRoot(rootAbs) {
  if (rootAbs) return rootAbs;
  return getLibraryRootForPins();
}

async function readCompanionPinsWithRoot(itemRelPath, rootAbs) {
  const companionRel = companionPathForItem(itemRelPath);
  if (!companionRel) return { pinned: [], companionRel: null, companionMtimeMs: 0 };
  try {
    const found = await statCompanionWithRoot(companionRel, rootAbs);
    if (!found) return { pinned: [], companionRel, companionMtimeMs: 0 };
    const text = await readTextCapped(found.abs, PIN_V1_MAX_COMPANION_BYTES);
    if (!text) return { pinned: [], companionRel, companionMtimeMs: found.mtimeMs };
    return { pinned: parseTextToPins(text), companionRel, companionMtimeMs: found.mtimeMs };
  } catch {
    return { pinned: [], companionRel, companionMtimeMs: 0 };
  }
}

async function readEmbeddedTextPins(absPath) {
  try {
    const text = await readTextCapped(absPath, PIN_V1_MAX_TEXT_BYTES);
    if (!text) return [];
    return parseTextToPins(text);
  } catch {
    return [];
  }
}

async function readEmbeddedDocxPins(absPath) {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size <= 0 || st.size > 32 * 1024 * 1024) return [];
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ path: absPath });
    const text = result && typeof result.value === 'string' ? result.value : '';
    if (!text) return [];
    const capped = text.length > PIN_V1_MAX_DOCX_CHARS ? text.slice(0, PIN_V1_MAX_DOCX_CHARS) : text;
    return parseTextToPins(capped);
  } catch (err) {
    try { console.warn('[pins-v1] DOCX extraction failed:', err && err.message ? err.message : err); } catch {}
    return [];
  }
}

// Testable core: rootAbs lets tests use a temp dir instead of queries/.
export async function getPinnedForItemWithRoot(relPath, rootAbs) {
  if (typeof relPath !== 'string' || !relPath) return [];
  if (!isSafeLibraryPath(relPath)) return [];
  const base = relPath.split('/').pop() || '';
  if (!base || isExternalFileName(base)) return [];
  if (isCompanionMetadataFilename(base)) return [];
  const abs = resolveLibraryRelPath(relPath, rootAbs);
  if (!abs) return [];
  const ext = path.extname(base).toLowerCase();
  const isDocx = ext === '.docx';
  const isEmbeddedText = ext === '.md' || ext === '.txt';
  // v2: every other companionable binary resolves pins from its sidecar only.
  const readsSidecar = isDocx || (!isEmbeddedText && isCompanionableParentFilename(base));

  // Cache lookup (validated by mtime of main + companion files).
  let mainMtimeMs = 0;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return [];
    mainMtimeMs = st.mtimeMs || 0;
  } catch {
    return [];
  }
  const cacheKey = `${rootAbs || '<lib>'}::${relPath.toLowerCase()}`;
  const now = Date.now();
  const cached = pinV1Cache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    try {
      let companionMtimeMs = 0;
      const companionRel = companionPathForItem(relPath);
      if (companionRel && readsSidecar) {
        const found = await statCompanionWithRoot(companionRel, rootAbs);
        companionMtimeMs = found ? found.mtimeMs : 0;
      }
      if (cached.mainMtimeMs === mainMtimeMs && cached.companionMtimeMs === companionMtimeMs) {
        return cached.pinned;
      }
    } catch {
      // fall through to fresh read
    }
  }

  let pinned = [];
  let companionMtimeMs = 0;
  try {
    if (isDocx) {
      // DOCX special case (v1 preserved): embedded + sidecar, unioned.
      const [embedded, sidecar] = await Promise.all([
        readEmbeddedDocxPins(abs),
        readCompanionPinsWithRoot(relPath, rootAbs),
      ]);
      companionMtimeMs = sidecar.companionMtimeMs || 0;
      pinned = dedupePinnedRefs([...(embedded || []), ...(sidecar.pinned || [])]);
    } else if (isEmbeddedText) {
      pinned = dedupePinnedRefs(await readEmbeddedTextPins(abs));
    } else if (readsSidecar) {
      // v2: sidecar only. Binaries are never parsed or modified.
      const sidecar = await readCompanionPinsWithRoot(relPath, rootAbs);
      companionMtimeMs = sidecar.companionMtimeMs || 0;
      pinned = dedupePinnedRefs(sidecar.pinned || []);
    } else {
      pinned = [];
    }
  } catch {
    pinned = [];
  }

  try {
    pinV1Cache.set(cacheKey, {
      pinned,
      mainMtimeMs,
      companionMtimeMs,
      expiresAt: now + PIN_V1_CACHE_TTL_MS,
    });
  } catch {}
  return pinned;
}

// Production entry: resolves against the real queries/ root.
export async function getPinnedForItem(relPath) {
  try {
    return await getPinnedForItemWithRoot(relPath, null);
  } catch {
    return [];
  }
}

export function getLibraryRootForPins() {
  try { return getLibraryRoot(); } catch { return null; }
}
