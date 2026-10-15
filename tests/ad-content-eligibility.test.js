import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED } from '../src/library/ad-eligibility.js';
import {
  isAdVisibleForUser,
  hasAdFreeCapability,
  isUserActive,
  isUserExpired,
  isNonAdPage,
  hasActiveProductEntitlementForContent
} from '../src/library/ad-visibility.js';

const FUTURE_DATE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

// User Fixtures
const OWNER_USER = { id: 1, email: 'owner@example.com', app_role: 'OWNER' };
const ADMIN_USER = { id: 2, email: 'admin@example.com', app_role: 'ADMIN' };
const PREMIUM_USER = { id: 3, email: 'premium@example.com', app_role: 'PREMIUM' };
const AD_FREE_USER = { id: 4, email: 'adfree@example.com', app_role: 'USER', ads_free: true };

const ACTIVE_USER = {
  id: 10,
  email: 'active@example.com',
  app_role: 'USER',
  status: 'active',
  access_expires_at: FUTURE_DATE,
  roles: []
};

const EXPIRED_USER = {
  id: 11,
  email: 'expired@example.com',
  app_role: 'USER',
  status: 'expired',
  access_expires_at: PAST_DATE,
  roles: []
};

const EXPIRED_USER_WITH_PRODUCT_ENTITLEMENT = {
  id: 12,
  email: 'expired_product@example.com',
  app_role: 'USER',
  status: 'expired',
  access_expires_at: PAST_DATE,
  roles: [101], // Holds role ID 101 for Java Course product
  paidProductRoleIds: [101]
};

function allowAll() { return true; }
function denyAll() { return false; }

// Mock folder permissions mapper
function mockGetPermission(path) {
  if (path.startsWith('JavaCourse')) {
    return { accessLevel: 'role', roleIds: [101] };
  }
  if (path.startsWith('PythonCourse')) {
    return { accessLevel: 'role', roleIds: [202] };
  }
  return { accessLevel: 'all', roleIds: [] };
}

test.beforeEach(() => clearAdCache());
test.afterEach(() => clearAdCache());

test('isNonAdPage correctly identifies pages that must not render ads', () => {
  assert.equal(isNonAdPage('login'), true);
  assert.equal(isNonAdPage('/login'), true);
  assert.equal(isNonAdPage('privacy'), true);
  assert.equal(isNonAdPage('terms'), true);
  assert.equal(isNonAdPage('admin'), true);
  assert.equal(isNonAdPage('admin/dashboard'), true);
  assert.equal(isNonAdPage('discussions'), true);
  assert.equal(isNonAdPage('discussions/123'), true);
  assert.equal(isNonAdPage('Guidewire/Gosu/file.txt'), false);
  assert.equal(isNonAdPage('home'), false);
});

test('isUserActive and isUserExpired helper classifications', () => {
  assert.equal(isUserActive(ACTIVE_USER), true);
  assert.equal(isUserExpired(ACTIVE_USER), false);

  assert.equal(isUserActive(EXPIRED_USER), false);
  assert.equal(isUserExpired(EXPIRED_USER), true);

  // ADMIN/OWNER are always active and never expired
  assert.equal(isUserActive(ADMIN_USER), true);
  assert.equal(isUserExpired(ADMIN_USER), false);
});

test('Active users see NO ads on normal/free content', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(
    isAdVisibleForUser(ACTIVE_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission),
    false,
    'Active user must not see ads on free content'
  );
  assert.equal(
    isAdVisibleForUser(ACTIVE_USER, 'home', allowAll, mockGetPermission),
    false,
    'Active user must not see ads on home'
  );
});

test('Expired users see ads on normal/free content', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(
    isAdVisibleForUser(EXPIRED_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission),
    true,
    'Expired user must see ads on eligible free content'
  );
});

test('Active paid-product entitlement suppresses ads on product protected content', () => {
  setAdCacheForTest({ 'JavaCourse': ADS_ENABLED, 'Guidewire': ADS_ENABLED });

  // Expired base account user who HAS entitlement for JavaCourse (role 101)
  assert.equal(
    hasActiveProductEntitlementForContent(EXPIRED_USER_WITH_PRODUCT_ENTITLEMENT, 'JavaCourse/lesson1.txt', mockGetPermission),
    true,
    'User holds entitlement for JavaCourse'
  );

  assert.equal(
    isAdVisibleForUser(EXPIRED_USER_WITH_PRODUCT_ENTITLEMENT, 'JavaCourse/lesson1.txt', allowAll, mockGetPermission),
    false,
    'No ads while viewing product protected content for which user has active entitlement'
  );

  // But the same expired user sees ads when viewing free content
  assert.equal(
    isAdVisibleForUser(EXPIRED_USER_WITH_PRODUCT_ENTITLEMENT, 'Guidewire/file.txt', allowAll, mockGetPermission),
    true,
    'Expired user sees ads on normal free content'
  );
});

test('Users WITHOUT product entitlement see NO ads on restricted/protected content', () => {
  setAdCacheForTest({ 'JavaCourse': ADS_ENABLED });

  // User does NOT have role 101 and cannot access JavaCourse
  assert.equal(
    isAdVisibleForUser(EXPIRED_USER, 'JavaCourse/lesson1.txt', denyAll, mockGetPermission),
    false,
    'Inaccessible/restricted content must not show ads'
  );
});

test('ADMIN, OWNER, and PREMIUM users never see ads on any content', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });

  assert.equal(isAdVisibleForUser(OWNER_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission), false);
  assert.equal(isAdVisibleForUser(ADMIN_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission), false);
  assert.equal(isAdVisibleForUser(PREMIUM_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission), false);
  assert.equal(isAdVisibleForUser(AD_FREE_USER, 'Guidewire/Gosu/file.txt', allowAll, mockGetPermission), false);
});

test('Non-ad routes (Login, Privacy, Terms, Admin, Discussions) never show ads', () => {
  setAdCacheForTest({ 'login': ADS_ENABLED, 'admin': ADS_ENABLED });

  assert.equal(isAdVisibleForUser(EXPIRED_USER, 'login', allowAll), false);
  assert.equal(isAdVisibleForUser(EXPIRED_USER, 'privacy', allowAll), false);
  assert.equal(isAdVisibleForUser(EXPIRED_USER, 'terms', allowAll), false);
  assert.equal(isAdVisibleForUser(EXPIRED_USER, 'admin', allowAll), false);
  assert.equal(isAdVisibleForUser(EXPIRED_USER, 'discussions', allowAll), false);
});
