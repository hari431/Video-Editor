import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED } from '../src/library/ad-eligibility.js';
import { isAdVisibleForUser, hasActiveProductEntitlementForContent } from '../src/library/ad-visibility.js';

const PAST_DATE = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_DATE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

const PC_TEAM_ROLE_ID = 100;
const INTERVIEW_QUESTIONS_ROLE_ID = 200;

function canAccessAlways() { return true; }

function mockGetPermission(contentPath) {
  if (contentPath.startsWith('Guidewire')) {
    return {
      accessLevel: 'role',
      roleIds: [PC_TEAM_ROLE_ID],
      roleAdsMap: { [PC_TEAM_ROLE_ID]: true } // Ads Available = ENABLED
    };
  }
  if (contentPath.startsWith('InterviewQuestions')) {
    return {
      accessLevel: 'role',
      roleIds: [INTERVIEW_QUESTIONS_ROLE_ID],
      roleAdsMap: { [INTERVIEW_QUESTIONS_ROLE_ID]: true }
    };
  }
  return { accessLevel: 'all', roleIds: [] };
}

test.beforeEach(() => {
  clearAdCache();
  setAdCacheForTest({
    'Guidewire': ADS_ENABLED,
    'InterviewQuestions': ADS_ENABLED,
    'home': ADS_ENABLED
  });
});

test.afterEach(() => {
  clearAdCache();
});

test('1. Expired + manually assigned Ads Available role + no paid entitlement → ad allowed', () => {
  const expiredUserWithManualRole = {
    id: 101,
    email: 'expired_manual@example.com',
    status: 'expired',
    access_expires_at: PAST_DATE,
    app_role: 'USER',
    roles: [PC_TEAM_ROLE_ID], // Manually assigned PC Team role
    paidProductRoleIds: [] // NO active paid product entitlement
  };

  assert.equal(
    hasActiveProductEntitlementForContent(expiredUserWithManualRole, 'Guidewire/doc.txt', mockGetPermission),
    false,
    'Possession of role alone must NOT count as a paid-product entitlement'
  );

  const visible = isAdVisibleForUser(expiredUserWithManualRole, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission);
  assert.equal(visible, true, 'Expired user with Ads Available role and no paid entitlement must see ads');
});

test('2. Expired + active paid entitlement for this product → ad suppressed', () => {
  const expiredUserWithProductEntitlement = {
    id: 102,
    email: 'expired_paid@example.com',
    status: 'expired',
    access_expires_at: PAST_DATE,
    app_role: 'USER',
    roles: [PC_TEAM_ROLE_ID],
    paidProductRoleIds: [PC_TEAM_ROLE_ID] // Active paid entitlement for PC Team
  };

  assert.equal(
    hasActiveProductEntitlementForContent(expiredUserWithProductEntitlement, 'Guidewire/doc.txt', mockGetPermission),
    true,
    'User holds active paid product entitlement for PC Team'
  );

  const visible = isAdVisibleForUser(expiredUserWithProductEntitlement, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission);
  assert.equal(visible, false, 'Ad must be suppressed for user with active paid entitlement for this product');
});

test('3. Expired + paid entitlement for different product → ad allowed', () => {
  const expiredUserWithOtherProductEntitlement = {
    id: 103,
    email: 'expired_other_paid@example.com',
    status: 'expired',
    access_expires_at: PAST_DATE,
    app_role: 'USER',
    roles: [PC_TEAM_ROLE_ID, INTERVIEW_QUESTIONS_ROLE_ID],
    paidProductRoleIds: [INTERVIEW_QUESTIONS_ROLE_ID] // Entitlement for Interview Questions, NOT PC Team
  };

  assert.equal(
    hasActiveProductEntitlementForContent(expiredUserWithOtherProductEntitlement, 'Guidewire/doc.txt', mockGetPermission),
    false,
    'Entitlement for Interview Questions is not relevant to Guidewire'
  );

  const visible = isAdVisibleForUser(expiredUserWithOtherProductEntitlement, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission);
  assert.equal(visible, true, 'Paid entitlement for a different product must not suppress ads on Guidewire');
});

test('4. Premium → ad suppressed everywhere', () => {
  const premiumUser = {
    id: 104,
    email: 'premium@example.com',
    status: 'active',
    access_expires_at: FUTURE_DATE,
    app_role: 'PREMIUM',
    roles: [PC_TEAM_ROLE_ID],
    paidProductRoleIds: []
  };

  assert.equal(
    isAdVisibleForUser(premiumUser, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission),
    false,
    'Premium user must never see ads on role content'
  );
  assert.equal(
    isAdVisibleForUser(premiumUser, 'home', canAccessAlways, mockGetPermission),
    false,
    'Premium user must never see ads on home'
  );
});

test('5. ADMIN/OWNER → ad suppressed everywhere', () => {
  const adminUser = {
    id: 105,
    email: 'admin@example.com',
    status: 'active',
    access_expires_at: FUTURE_DATE,
    app_role: 'ADMIN',
    roles: [PC_TEAM_ROLE_ID]
  };

  const ownerUser = {
    id: 106,
    email: 'owner@example.com',
    status: 'active',
    access_expires_at: FUTURE_DATE,
    app_role: 'OWNER',
    roles: [PC_TEAM_ROLE_ID]
  };

  assert.equal(
    isAdVisibleForUser(adminUser, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission),
    false,
    'ADMIN user must never see ads on role content'
  );
  assert.equal(
    isAdVisibleForUser(ownerUser, 'Guidewire/doc.txt', canAccessAlways, mockGetPermission),
    false,
    'OWNER user must never see ads on role content'
  );
});
