export const ROLES = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  USER: 'USER',
  PREMIUM: 'PREMIUM'
};

// Canonical ADMIN_EMAILS parsing shared by exemption checks, mailer
// recipients, and the video-protection watermark source: comma-separated,
// trimmed, lowercased, empties dropped. First entry is the primary address.
export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email) {
  const admins = getAdminEmails();

  return Boolean(email) && admins.includes(String(email).trim().toLowerCase());
}

function getAppRole(user) {
  if (!user) return null;
  // Prefer DB-backed role if present; otherwise fall back to email for bootstrap/migration period
  if (typeof user.app_role === 'string' && user.app_role) return user.app_role;
  if (typeof user.appRole === 'string' && user.appRole) return user.appRole;
  return null;
}

export function isOwnerUser(user) {
  if (!user) return false;
  const role = getAppRole(user);
  if (role) return role === ROLES.OWNER;
  // Fallback before migration: treat ADMIN_EMAILS as OWNER for bootstrap
  return isAdminEmail(user.email);
}

export function isAdminUser(user) {
  if (!user) return false;
  const role = getAppRole(user);
  if (role) return role === ROLES.OWNER || role === ROLES.ADMIN;
  // Fallback before migration: ADMIN_EMAILS implies ADMIN
  return isAdminEmail(user.email);
}

export function getUserRole(user) {
  const role = getAppRole(user);
  if (role && [ROLES.OWNER, ROLES.ADMIN, ROLES.USER, ROLES.PREMIUM].includes(role)) return role;
  if (isAdminEmail(user?.email)) return ROLES.OWNER;
  return ROLES.USER;
}

export function isOwner(user) {
  return isOwnerUser(user);
}

export function isAdmin(user) {
  return isAdminUser(user);
}