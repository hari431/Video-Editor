// src/library/ad-eligibility.js — Phase 5 content-level ad eligibility
// Reusable, server-side mechanism for marking content/folders as ADS_ENABLED / ADS_DISABLED
// - Folder inheritance: child inherits nearest ancestor setting unless explicitly overridden.
// - ADS_DISABLED takes precedence for restricted/private content (HIDDEN_FOLDERS etc).
// - Defaults: Gosu queries/logic/learning content (txt/md/video) => ADS_ENABLED; PDFs and reference/download material => ADS_DISABLED.
// - No client trust, no Google Ads scripts.
// - Explicit configuration model, not hard-coded filenames; defaults are file-type based.
// - No per-request DB writes; load is cached (30s), similar to folder_permissions.
//

import path from 'node:path';
import { pool } from '../db/pool.js';
import { isSafeLibraryPath, isPathRestricted } from './local.js';
import { getFileType } from './file-types.js';
import { getReqId as getReqIdAd } from '../utils/perf.js';

export const ADS_ENABLED = 'ADS_ENABLED';
export const ADS_DISABLED = 'ADS_DISABLED';

const VALID_STATES = new Set([ADS_ENABLED, ADS_DISABLED]);

let adCache = { expiresAt: 0, map: new Map() };

export function isValidAdState(value) {
  return VALID_STATES.has(value);
}

const perfDiagnosticsEnabledAd = String(process.env.PERF_DIAGNOSTICS || 'false').toLowerCase() === 'true';

// Load ad_settings from DB (cached). Safe to call frequently.
export async function loadAdSettings() {
  const now = Date.now();
  if (now < adCache.expiresAt) {
    if (perfDiagnosticsEnabledAd) {
      const reqId = getReqIdAd();
      console.log(`PERF loadAdSettings reqId=${reqId} cacheHit=1 total=0ms dbQuery=0ms`);
    }
    return adCache.map;
  }
  let tDb = 0;
  if (perfDiagnosticsEnabledAd) tDb = Date.now();
  try {
    const result = await pool.query(`SELECT path, ad_state FROM ad_settings`);
    const dbMs = perfDiagnosticsEnabledAd ? Date.now() - tDb : 0;
    const map = new Map();
    for (const row of result.rows) {
      if (isValidAdState(row.ad_state)) map.set(row.path, row.ad_state);
    }
    adCache = { expiresAt: now + 30_000, map };
    if (perfDiagnosticsEnabledAd) {
      const total = Date.now() - now;
      const reqId = getReqIdAd();
      console.log(`PERF loadAdSettings reqId=${reqId} cacheHit=0 total=${total}ms dbQuery=${dbMs}ms`);
    }
  } catch {
    const dbMs = perfDiagnosticsEnabledAd ? Date.now() - tDb : 0;
    // table may not exist yet (migration pending) — treat as no overrides
    adCache = { expiresAt: now + 10_000, map: new Map() };
    if (perfDiagnosticsEnabledAd) {
      const total = Date.now() - now;
      const reqId = getReqIdAd();
      console.log(`PERF loadAdSettings reqId=${reqId} cacheHit=0 total=${total}ms dbQuery=${dbMs}ms error=1`);
    }
  }
  return adCache.map;
}

// Synchronous cache lookup with inheritance: walk up path segments to find nearest ancestor.
export function getAdSettingFromCache(targetPath) {
  if (!isSafeLibraryPath(targetPath)) return null;
  const map = adCache.map;
  if (!map || map.size === 0) return null;
  const segments = targetPath.split('/').filter(Boolean);
  // include full path plus each parent folder
  for (let i = segments.length; i >= 1; i--) {
    const candidate = segments.slice(0, i).join('/');
    if (map.has(candidate)) return map.get(candidate);
  }
  return null;
}

// Default ad state based on file type (explicit configuration preferred).
// Gosu learning content (txt/md/video) => ENABLED; PDFs/reference/download => DISABLED.
export function getDefaultAdStateForPath(targetPath) {
  if (!isSafeLibraryPath(targetPath)) return ADS_DISABLED;
  const ext = path.extname(targetPath).toLowerCase();
  // Folder (no extension) — default ENABLED but restricted check will override for private folders.
  if (!ext) return ADS_ENABLED;
  // Text/markdown are learning content
  if (ext === '.txt' || ext === '.md') return ADS_ENABLED;
  // Video learning content
  if (ext === '.mp4' || ext === '.webm' || ext === '.mov') return ADS_ENABLED;
  // All other known types (pdf, doc, xls, ppt, image, archive) are reference/download => DISABLED
  // Unknown extensions also DISABLED (safe default)
  return ADS_DISABLED;
}

// Effective ad state: explicit/inherited setting if present, otherwise default.
export function getEffectiveAdState(targetPath) {
  if (!isSafeLibraryPath(targetPath)) return ADS_DISABLED;
  const explicit = getAdSettingFromCache(targetPath);
  if (explicit) return explicit;
  return getDefaultAdStateForPath(targetPath);
}

// Server-side check whether ads are allowed for a content path.
// - Restricted/private content always DISABLED (takes precedence)
// - Unknown/missing paths DISABLED
// - Otherwise based on effective setting
export function isAdAllowedForPath(targetPath) {
  if (!isSafeLibraryPath(targetPath)) return false;
  if (isPathRestricted(targetPath)) return false;
  const effective = getEffectiveAdState(targetPath);
  return effective === ADS_ENABLED;
}

// Variant that also respects RBAC folder permissions for a given user (optional).
// If user cannot access the path, ads are not allowed for that user/context.
// This ensures restricted content never becomes ad-eligible accidentally for any user.
export function isAdAllowedForUser(user, targetPath, canAccessFn) {
  if (!isSafeLibraryPath(targetPath)) return false;
  if (isPathRestricted(targetPath)) return false;
  if (typeof canAccessFn === 'function') {
    try {
      if (!canAccessFn(user, targetPath)) return false;
    } catch {
      return false;
    }
  }
  const effective = getEffectiveAdState(targetPath);
  return effective === ADS_ENABLED;
}

// For tests: clear cache
export function clearAdCache() {
  adCache = { expiresAt: 0, map: new Map() };
}

// For tests: set cache directly without DB
export function setAdCacheForTest(entries) {
  const map = new Map();
  for (const [p, state] of Object.entries(entries)) {
    if (isValidAdState(state)) map.set(p, state);
  }
  adCache = { expiresAt: Date.now() + 30_000, map };
  return map;
}

export function invalidateAdCache() {
  adCache = { expiresAt: 0, map: new Map() };
}
