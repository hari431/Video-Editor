import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeLibraryPath } from './local.js';

// Per-video branding watermark configuration (enabled + style + opacity + color).
// File-backed store only — no database, no migration. Viewer-specific data
// (name, masked email, session code) stays runtime-generated and is never
// persisted here. Only Admin/Owner writers via the protected API route.
//
// `enabled` (default true) lets an admin hide the site brand overlay for a
// video that already carries a burned-in watermark, avoiding a duplicate.
// The viewer-identity pill is unaffected (separate protection layer).
//
// Branding styles (presentation of the separate "Learn with me" overlay;
// the corner pill and viewer watermark are unaffected):
//   2 = Diagonal + Logo (large rotated brand mark)
//   3 = Centered Large (large centered brand mark, the default)
export const BRANDING_STYLE_DIAGONAL = 2;
export const BRANDING_STYLE_CENTERED = 3;
export const BRANDING_STYLES = new Set([BRANDING_STYLE_DIAGONAL, BRANDING_STYLE_CENTERED]);

// Default brand color: dark blue, visible on light Guidewire screens.
export const DEFAULT_BRANDING_COLOR = '#1E3A5F';

export const DEFAULT_BRANDING = Object.freeze({ enabled: true, style: BRANDING_STYLE_CENTERED, opacity: 8, color: DEFAULT_BRANDING_COLOR });

const MIN_OPACITY = 1;
const MAX_OPACITY = 100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function brandingFilePath() {
  if (process.env.VIDEO_BRANDING_FILE) return process.env.VIDEO_BRANDING_FILE;
  return path.resolve(__dirname, '..', 'config', 'video-branding.json');
}

function isValidStyle(value) {
  return Number.isInteger(value) && BRANDING_STYLES.has(value);
}

function isValidOpacity(value) {
  return Number.isInteger(value) && value >= MIN_OPACITY && value <= MAX_OPACITY;
}

// Strict color allowlist: only #RGB / #RRGGBB hex. Anything else (named
// colors, rgb(), url(), expression(), ...) is rejected so stored values can
// never become an arbitrary-CSS injection vector. Returns the normalized
// uppercase #RRGGBB form, or null.
export function normalizeBrandingColor(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  const m = t.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let hex = m[1].toUpperCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const style = Number(raw.style);
  const opacity = Number(raw.opacity);
  if (!isValidStyle(style) || !isValidOpacity(opacity)) return null;
  // Entries written before the toggle existed stay enabled (today's behavior).
  let enabled = true;
  if (raw.enabled !== undefined && raw.enabled !== null && raw.enabled !== '') {
    if (typeof raw.enabled !== 'boolean') return null;
    enabled = raw.enabled;
  }
  // Entries written before color existed keep their style/opacity and gain
  // the default color; malformed colors invalidate the entry (→ defaults).
  if (raw.color === undefined || raw.color === null || raw.color === '') {
    return { enabled, style, opacity, color: DEFAULT_BRANDING_COLOR };
  }
  const color = normalizeBrandingColor(raw.color);
  if (!color) return null;
  return { enabled, style, opacity, color };
}

// In-memory cache with mtime revalidation: config reads stay cheap per
// video-page view without re-reading the file on every request.
let brandingCache = { mtimeMs: 0, map: {}, path: '' };

function loadBrandingMap() {
  const file = brandingFilePath();
  if (brandingCache.path === file && brandingCache.map) {
    try {
      if (existsSync(file)) {
        const mtimeMs = statSync(file).mtimeMs;
        if (mtimeMs === brandingCache.mtimeMs) return brandingCache.map;
      } else if (brandingCache.mtimeMs === 0) {
        return brandingCache.map;
      }
    } catch {
      return brandingCache.map;
    }
  }
  let map = {};
  let mtimeMs = 0;
  try {
    if (existsSync(file)) {
      mtimeMs = statSync(file).mtimeMs;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const clean = sanitizeEntry(value);
          if (clean && typeof key === 'string' && key) map[key] = clean;
        }
      }
    }
  } catch (err) {
    console.warn('[video-branding] Failed to load:', err.message);
    map = {};
    mtimeMs = 0;
  }
  brandingCache = { mtimeMs, map, path: file };
  return map;
}

export function _resetVideoBrandingCache() {
  brandingCache = { mtimeMs: 0, map: {}, path: '' };
}

// Effective brand-overlay visibility for a page render. An explicit file
// directive (External Watermark:false) hides the overlay even when the
// stored branding entry is enabled — the entry itself is untouched, so the
// admin config UI keeps showing the stored value. Anything else follows the
// stored entry (default enabled).
export function resolveBrandOverlayVisible({ fileWatermark = null, brandingEnabled = true } = {}) {
  if (fileWatermark === false) return false;
  return brandingEnabled !== false;
}

// Effective branding for a video: stored entry or the default
// (Option 3 Centered Large at 8% opacity, dark blue). Never throws.
export function getVideoBranding(itemPath) {
  try {
    if (typeof itemPath !== 'string' || !itemPath) return { ...DEFAULT_BRANDING };
    const map = loadBrandingMap();
    const entry = sanitizeEntry(map[itemPath]);
    return entry ? { ...entry } : { ...DEFAULT_BRANDING };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

// Admin-only writer. Validates everything; throws Error on invalid input.
// Persists the single entry (read-modify-write) and refreshes the cache.
// A missing color falls back to the default (older callers stay working);
// a missing enabled flag stays enabled (older callers stay working).
export function setVideoBranding(itemPath, style, opacity, color, enabled = true) {
  const relPath = String(itemPath || '').trim();
  if (!relPath || !isSafeLibraryPath(relPath)) {
    throw new Error('Invalid item path.');
  }
  const clean = sanitizeEntry({ style: Number(style), opacity: Number(opacity), color, enabled });
  if (!clean) {
    throw new Error('Invalid branding: style must be 2 or 3, opacity 1–100, color must be #RGB or #RRGGBB, enabled must be true/false.');
  }
  const file = brandingFilePath();
  let map = {};
  try {
    map = { ...loadBrandingMap() };
  } catch {
    map = {};
  }
  map[relPath] = clean;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(map, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error('Unable to save branding configuration.');
  }
  try {
    brandingCache = { mtimeMs: statSync(file).mtimeMs, map, path: file };
  } catch {
    brandingCache = { mtimeMs: 0, map, path: file };
  }
  return { ...clean };
}
