import { isAdminUser } from '../auth/admin.js';
import { canAccessLibraryPathAsync } from '../library/local.js';

/**
 * Luna V2 permissions layer.
 * Single place for "who may use Luna" and "what content may reach a provider".
 * Does not change library RBAC semantics — it only reuses canAccessLibraryPathAsync.
 */

export function isLunaUser(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return user.status === 'active';
}

export function assertLunaUser(user) {
  if (!isLunaUser(user)) {
    throw new Error('Luna is available only to active users and admins.');
  }
}

/** Authorize a single library path for this user. Returns true/false, never throws. */
export async function canReadPath(user, relPath) {
  try {
    return await canAccessLibraryPathAsync(user, relPath);
  } catch {
    return false;
  }
}

/**
 * Filter evidence items down to paths the user is authorized to read.
 * Items without a library path (e.g. official Guidewire docs) pass through.
 */
export async function filterEvidenceForUser(user, evidence) {
  const out = [];
  for (const item of evidence || []) {
    if (!item) continue;
    if (!item.path || item.source === 'guidewire-docs') {
      out.push(item);
      continue;
    }
    if (await canReadPath(user, item.path)) out.push(item);
  }
  return out;
}
