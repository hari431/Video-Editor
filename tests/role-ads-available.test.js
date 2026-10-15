import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdVisibleForUser } from '../src/library/ad-visibility.js';

test('Role Ads Available & Content Ad-Visibility Suite', async (t) => {
  const expiredUser = {
    id: 1,
    email: 'expired@example.com',
    status: 'expired',
    access_expires_at: '2026-01-01T00:00:00.000Z',
    app_role: 'USER',
    roles: []
  };

  const activeUser = {
    id: 2,
    email: 'active@example.com',
    status: 'active',
    access_expires_at: '2027-01-01T00:00:00.000Z',
    app_role: 'USER',
    roles: []
  };

  const adminUser = {
    id: 3,
    email: 'admin@example.com',
    status: 'active',
    access_expires_at: '2027-01-01T00:00:00.000Z',
    app_role: 'ADMIN',
    roles: []
  };

  const premiumUser = {
    id: 4,
    email: 'premium@example.com',
    status: 'active',
    access_expires_at: '2027-01-01T00:00:00.000Z',
    app_role: 'PREMIUM',
    roles: []
  };

  const subscriberWithRole = {
    id: 5,
    email: 'subscriber@example.com',
    status: 'active',
    access_expires_at: '2027-01-01T00:00:00.000Z',
    app_role: 'USER',
    roles: [10], // holds Role 10 (Certification Dumps)
    paidProductRoleIds: [10]
  };

  // Mock permissions getter
  const mockPermissions = {
    'Guidewire/Certification': {
      accessLevel: 'role',
      roleIds: [10],
      roleAdsMap: { 10: false } // ads_available = false
    },
    'Guidewire/InterviewQuestions': {
      accessLevel: 'role',
      roleIds: [20],
      roleAdsMap: { 20: true } // ads_available = true
    },
    'Guidewire/MultiRoleFolder': {
      accessLevel: 'role',
      roleIds: [10, 20],
      roleAdsMap: { 10: false, 20: true } // Role 10 is ad-free, Role 20 has ads available
    },
    'Guidewire/Normal': {
      accessLevel: 'all',
      roleIds: [],
      roleAdsMap: {}
    }
  };

  const getPermFn = (path) => mockPermissions[path] || null;
  const canAccessAlways = () => true;

  await t.test('1. Role-protected content with ads_available=false shows NO ads even to expired user', () => {
    const visible = isAdVisibleForUser(expiredUser, 'Guidewire/Certification', canAccessAlways, getPermFn);
    assert.equal(visible, false, 'Ads must NOT be shown when role has ads_available=false');
  });

  await t.test('2. Role-protected content with ads_available=true shows ads to expired user', () => {
    const visible = isAdVisibleForUser(expiredUser, 'Guidewire/InterviewQuestions', canAccessAlways, getPermFn);
    assert.equal(visible, true, 'Ads MUST be shown to expired user when role has ads_available=true');
  });

  await t.test('3. Active paid-product subscriber NEVER sees ads on their protected content, even if folder has another role with ads_available=true', () => {
    const visible = isAdVisibleForUser(subscriberWithRole, 'Guidewire/MultiRoleFolder', canAccessAlways, getPermFn);
    assert.equal(visible, false, 'Paid subscriber must NEVER see ads on content they hold an entitlement for');
  });

  await t.test('4. Free/base content shows NO ads to active base user', () => {
    const visible = isAdVisibleForUser(activeUser, 'Guidewire/Normal', canAccessAlways, getPermFn);
    assert.equal(visible, false, 'Active base user gets no ads on free content');
  });

  await t.test('5. Free/base content shows ads to expired base user', () => {
    const visible = isAdVisibleForUser(expiredUser, 'Guidewire/Normal', canAccessAlways, getPermFn);
    assert.equal(visible, true, 'Expired base user gets ads on free content');
  });

  await t.test('6. ADMIN and PREMIUM users NEVER see ads on any content', () => {
    assert.equal(isAdVisibleForUser(adminUser, 'Guidewire/InterviewQuestions', canAccessAlways, getPermFn), false);
    assert.equal(isAdVisibleForUser(premiumUser, 'Guidewire/InterviewQuestions', canAccessAlways, getPermFn), false);
    assert.equal(isAdVisibleForUser(adminUser, 'Guidewire/Normal', canAccessAlways, getPermFn), false);
    assert.equal(isAdVisibleForUser(premiumUser, 'Guidewire/Normal', canAccessAlways, getPermFn), false);
  });
});
