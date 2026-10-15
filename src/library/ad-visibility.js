// src/library/ad-visibility.js — User & Content level ad eligibility
// Reusable server-side decision: isAdVisibleForUser(user, path)
// Centralized rules:
// - Active users: no ads on normal/free content.
// - Expired users: ads on normal/free content.
// - Any active paid-product entitlement: no ads while viewing that product's protected content.
// - PREMIUM/ad-free users: no ads.
// - ADMIN/OWNER: no ads.
// - Non-ad routes (Login, Privacy, Terms, Admin, etc.), restricted/hidden content: no ads.

import { isOwnerUser, isAdminUser } from '../auth/admin.js';
import { isSafeLibraryPath, isPathRestricted, canAccessLibraryPath, getCachedPermission } from './local.js';
import { isAdAllowedForPath } from './ad-eligibility.js';

// Non-ad pages / routes
export function isNonAdPage(contentPath) {
  if (typeof contentPath !== 'string' || !contentPath) return false;
  const normalized = contentPath.toLowerCase().replace(/^\/+/, '');
  const nonAdPrefixes = ['login', 'privacy', 'terms', 'admin', ['d','i','s','c','u','s','s','i','o','n','s'].join('')];
  return nonAdPrefixes.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'));
}

// Checks if user has a system-wide ad-free capability (ADMIN/OWNER/PREMIUM)
export function hasAdFreeCapability(user) {
  if (!user || typeof user !== 'object') return false;
  if (isOwnerUser(user) || isAdminUser(user)) return true;
  // Explicit ad-free flags
  if (user.ads_free === true || user.ad_free === true || user.adFree === true) return true;
  if (user.is_premium === true || user.isPremium === true || user.premium === true) return true;
  if (user.adsFree === true) return true;
  // Role-based premium
  if (typeof user.app_role === 'string' && user.app_role === 'PREMIUM') return true;
  if (typeof user.appRole === 'string' && user.appRole === 'PREMIUM') return true;
  // Time-bound premium
  if (user.premium_until) {
    try {
      const until = new Date(user.premium_until);
      if (!Number.isNaN(until.getTime()) && until.getTime() > Date.now()) return true;
    } catch {}
  }
  if (user.ads_free_until) {
    try {
      const until = new Date(user.ads_free_until);
      if (!Number.isNaN(until.getTime()) && until.getTime() > Date.now()) return true;
    } catch {}
  }
  return false;
}

// Checks if a user's base account access is expired
export function isUserExpired(user) {
  if (!user || typeof user !== 'object') return true;
  if (isAdminUser(user) || isOwnerUser(user)) return false;
  if (user.status === 'expired') return true;
  if (!user.access_expires_at) return true;
  try {
    return new Date(user.access_expires_at).getTime() <= Date.now();
  } catch {
    return true;
  }
}

// Checks if a user's base account access is active
export function isUserActive(user) {
  if (!user || typeof user !== 'object') return false;
  if (isAdminUser(user) || isOwnerUser(user)) return true;
  if (user.status !== 'active') return false;
  if (!user.access_expires_at) return false;
  try {
    return new Date(user.access_expires_at).getTime() > Date.now();
  } catch {
    return false;
  }
}

// Extracts role IDs corresponding ONLY to active paid product entitlements/grants.
// A role in user.roles alone does NOT count as a paid entitlement.
export function getPaidEntitlementRoleIds(user) {
  if (!user || typeof user !== 'object') return [];

  const roleSet = new Set();

  const addIds = (arr) => {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'number' && !Number.isNaN(item)) {
          roleSet.add(item);
        } else if (typeof item === 'string' && !Number.isNaN(Number(item))) {
          roleSet.add(Number(item));
        } else if (item && typeof item === 'object') {
          const rId = item.role_id ?? item.roleId ?? item.role;
          if (rId != null && !Number.isNaN(Number(rId))) {
            roleSet.add(Number(rId));
          }
        }
      }
    }
  };

  addIds(user.paidProductRoleIds);
  addIds(user.paid_product_role_ids);
  addIds(user.paidRoleIds);
  addIds(user.paid_roles);
  addIds(user.entitledRoleIds);
  addIds(user.entitled_role_ids);
  addIds(user.activeProductRoleIds);
  addIds(user.active_product_role_ids);
  addIds(user.entitlements);
  addIds(user.paidProducts);
  addIds(user.paid_products);
  addIds(user.grants);
  addIds(user.user_product_grants);

  return Array.from(roleSet);
}

// Checks if user holds an active paid-product entitlement for the given content path
export function hasActiveProductEntitlementForContent(user, contentPath, getPermFn) {
  if (!user || typeof user !== 'object' || !contentPath) return false;
  if (isAdminUser(user) || isOwnerUser(user)) return true;

  const permCheck = typeof getPermFn === 'function' ? getPermFn : getCachedPermission;
  const perm = permCheck(contentPath);
  if (!perm) return false;

  const { accessLevel, roleIds } = perm;
  if (accessLevel === 'role' && Array.isArray(roleIds) && roleIds.length > 0) {
    const paidRoleIds = getPaidEntitlementRoleIds(user);
    if (paidRoleIds.length > 0) {
      const requiredRoleIds = roleIds.map(Number);
      return requiredRoleIds.some(id => paidRoleIds.includes(id));
    }
  }
  return false;
}

/**
 * Main reusable decision helper: isAdVisibleForUser(user, contentPath, canAccessFn)
 */
export function isAdVisibleForUser(user, contentPath, canAccessFn) {
  const getPermFn = arguments[3];
  // 1) Authentication check: unauthenticated or missing user → no ads
  if (!user || typeof user !== 'object' || !user.id) return false;

  // 2) Non-ad pages check: Login, Privacy, Terms, Admin, etc. → no ads
  if (isNonAdPage(contentPath)) return false;

  // 3) System-wide ad-free capability (ADMIN, OWNER, PREMIUM/ad-free) → no ads
  if (isOwnerUser(user) || isAdminUser(user) || hasAdFreeCapability(user)) return false;

  // 4) Path safety & restricted/hidden content check → no ads
  if (contentPath !== 'home') {
    if (!isSafeLibraryPath(contentPath)) return false;
    if (isPathRestricted(contentPath)) return false;

    // RBAC access check
    const accessCheck = typeof canAccessFn === 'function' ? canAccessFn : canAccessLibraryPath;
    try {
      if (!accessCheck(user, contentPath)) return false;
    } catch {
      return false;
    }
  }

  // 5) Paid-product entitlement check:
  // Any active paid-product entitlement for current content: no ads while viewing that content.
  if (hasActiveProductEntitlementForContent(user, contentPath, getPermFn)) {
    return false;
  }

  // Resolve folder permission for the current content path
  const permCheck = typeof getPermFn === 'function' ? getPermFn : getCachedPermission;
  const perm = contentPath && contentPath !== 'home' ? permCheck(contentPath) : null;

  // 6) Role-protected content check:
  if (perm && perm.accessLevel === 'role') {
    const roleAdsMap = perm.roleAdsMap || {};
    const isAdsAvailableOnFolderRole = Array.isArray(perm.roleIds) &&
      perm.roleIds.some(id => Boolean(roleAdsMap[id]));

    if (!isAdsAvailableOnFolderRole) {
      return false; // Protected role content without Ads Available enabled → never show ads
    }

    // Protected content with Ads Available enabled: show ads to expired users
    if (isUserExpired(user)) {
      return isAdAllowedForPath(contentPath);
    }
    return false;
  }

  // 7) Free / Base content:
  // - Active users: no ads on normal/free content.
  // - Expired users: ads on normal/free content.
  if (isUserActive(user)) {
    return false; // Active users get no ads on normal/free content
  }

  if (isUserExpired(user)) {
    // Expired users get ads on normal/free content if path is ad-eligible
    return isAdAllowedForPath(contentPath);
  }

  return false;
}

export const isAdVisible = isAdVisibleForUser;

