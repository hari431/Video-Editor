import { isAdminUser } from './admin.js';

// Display-only access-expiry reminder logic.
// Pure function: never touches auth, RBAC, or the database.
// Returns null when no reminder should be shown, otherwise:
//   { level: 'warning' | 'urgent', expiresAt: Date, daysRemaining: number | null, expiryIST: string }
export const ACCESS_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_EXPIRY_URGENT_MS = 24 * 60 * 60 * 1000;

export function formatExpiryIST(date) {
  return new Date(date).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
}

export function getAccessExpiryReminder(user, now = new Date()) {
  if (!user || user.access_expires_at == null) return null;
  // Admin/owner access never expires (see admin users page: "Never expires").
  try {
    if (isAdminUser(user)) return null;
  } catch {
    // fall through to date logic if role check fails
  }
  if (user.isAdmin === true) return null;
  const expiresAt = new Date(user.access_expires_at);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) return null;
  const diffMs = expiresAt.getTime() - nowDate.getTime();
  // Already expired (or expiring right now): existing access-control
  // handling in requireAuth/requireApiAuth remains authoritative.
  if (diffMs <= 0) return null;
  if (diffMs > ACCESS_EXPIRY_WARNING_MS) return null;
  const expiryIST = formatExpiryIST(expiresAt);
  if (diffMs < ACCESS_EXPIRY_URGENT_MS) {
    return { level: 'urgent', expiresAt, daysRemaining: null, expiryIST };
  }
  const daysRemaining = Math.ceil(diffMs / ACCESS_EXPIRY_URGENT_MS);
  return { level: 'warning', expiresAt, daysRemaining, expiryIST };
}
