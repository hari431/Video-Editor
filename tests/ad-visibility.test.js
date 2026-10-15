import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED, ADS_DISABLED, isAdAllowedForPath } from '../src/library/ad-eligibility.js';
import { isAdVisibleForUser, hasAdFreeCapability } from '../src/library/ad-visibility.js';

// Users: OWNER, ADMIN, USER, future premium
const OWNER = { id: 10, email: 'owner@example.com', app_role: 'OWNER' };
const ADMIN = { id: 11, email: 'admin@example.com', app_role: 'ADMIN' };
const USER = { id: 12, email: 'user@example.com', app_role: 'USER' };
const USER_PREMIUM_FLAG = { id: 13, email: 'premium@example.com', app_role: 'USER', ads_free: true };
const USER_AD_FREE = { id: 14, email: 'adfree@example.com', app_role: 'USER', ad_free: true };
const USER_PREMIUM_ROLE = { id: 15, email: 'premium2@example.com', app_role: 'PREMIUM' };
const USER_PREMIUM_UNTIL_FUTURE = { id: 16, email: 'future@example.com', app_role: 'USER', premium_until: new Date(Date.now() + 86400000).toISOString() };
const USER_PREMIUM_UNTIL_PAST = { id: 17, email: 'past@example.com', app_role: 'USER', premium_until: new Date(Date.now() - 86400000).toISOString() };
const USER_IS_PREMIUM = { id: 18, email: 'ispremium@example.com', app_role: 'USER', isPremium: true };

function allowAll() { return true; }
function denyAll() { return false; }
function allowOnlyGuidewire(user, p) { return p.startsWith('Guidewire'); }

test.beforeEach(() => clearAdCache());
test.afterEach(() => clearAdCache());

// ----- OWNER -----
test('OWNER → ads disabled regardless of content', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(OWNER, 'Guidewire/Gosu/PC/query.txt', allowAll), false);
  assert.equal(isAdVisibleForUser(OWNER, 'Guidewire/Gosu/PC/query.txt'), false); // default canAccess will be checked but OWNER would be allowed, still disabled due to role
  assert.equal(hasAdFreeCapability(OWNER), true);
  // Even with ADS_ENABLED content
  assert.equal(isAdAllowedForPath('Guidewire/Gosu/PC/query.txt'), true); // content itself is enabled
  assert.equal(isAdVisibleForUser(OWNER, 'Guidewire/Gosu/PC/query.txt', allowAll), false); // but OWNER disabled
});

// ----- ADMIN -----
test('ADMIN → ads disabled regardless of content', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(ADMIN, 'Guidewire/Gosu/PC/query.txt', allowAll), false);
  assert.equal(hasAdFreeCapability(ADMIN), true);
  assert.equal(isAdAllowedForPath('Guidewire/Gosu/PC/query.txt'), true);
  assert.equal(isAdVisibleForUser(ADMIN, 'Guidewire/Gosu/PC/query.txt', allowAll), false);
});

// ----- normal USER + ADS_ENABLED -----
test('normal USER + ADS_ENABLED content → ads allowed', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  // txt is enabled by default and via explicit folder
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/query.txt', allowAll), true);
  assert.equal(hasAdFreeCapability(USER), false);
});

// ----- normal USER + ADS_DISABLED -----
test('normal USER + ADS_DISABLED content → ads disabled', () => {
  setAdCacheForTest({ 'Guidewire/Gosu/PC': ADS_DISABLED });
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/query.txt', allowAll), false);
  // Also via default pdf disabled
  clearAdCache();
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/doc.pdf', allowAll), false);
});

// ----- future ADS_FREE capability abstraction -----
test('future ADS_FREE capability abstraction: USER with ads_free / premium flags → disabled', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  // normal USER without flag → allowed
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/query.txt', allowAll), true);

  // USER with ads_free true
  assert.equal(hasAdFreeCapability(USER_AD_FREE), true);
  assert.equal(isAdVisibleForUser(USER_AD_FREE, 'Guidewire/Gosu/PC/query.txt', allowAll), false);

  // USER with ads_free (alternative field)
  assert.equal(hasAdFreeCapability(USER_PREMIUM_FLAG), true);
  assert.equal(isAdVisibleForUser(USER_PREMIUM_FLAG, 'Guidewire/Gosu/PC/query.txt', allowAll), false);

  // USER with PREMIUM role
  assert.equal(hasAdFreeCapability(USER_PREMIUM_ROLE), true);
  assert.equal(isAdVisibleForUser(USER_PREMIUM_ROLE, 'Guidewire/Gosu/PC/query.txt', allowAll), false);

  // USER with isPremium true
  assert.equal(hasAdFreeCapability(USER_IS_PREMIUM), true);
  assert.equal(isAdVisibleForUser(USER_IS_PREMIUM, 'Guidewire/Gosu/PC/query.txt', allowAll), false);

  // Future premium_until in future → ad-free
  assert.equal(hasAdFreeCapability(USER_PREMIUM_UNTIL_FUTURE), true);
  assert.equal(isAdVisibleForUser(USER_PREMIUM_UNTIL_FUTURE, 'Guidewire/Gosu/PC/query.txt', allowAll), false);

  // Past premium_until → not ad-free → allowed if content enabled
  assert.equal(hasAdFreeCapability(USER_PREMIUM_UNTIL_PAST), false);
  assert.equal(isAdVisibleForUser(USER_PREMIUM_UNTIL_PAST, 'Guidewire/Gosu/PC/query.txt', allowAll), true);

  // Verify abstraction is extensible: check source contains multiple future checks
  const src = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.match(src, /hasAdFreeCapability/, 'must have abstraction');
  assert.match(src, /ads_free/, 'checks ads_free');
  assert.match(src, /PREMIUM/, 'checks PREMIUM role');
  assert.match(src, /premium_until/, 'checks premium_until');
});

test('architecture supports future ADS_FREE without redesign', () => {
  const src = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  // Helper should combine 4 checks in one place, not scattered
  assert.match(src, /isAdVisibleForUser/, 'main helper exists');
  assert.match(src, /hasAdFreeCapability/, 'uses ad-free abstraction');
  assert.match(src, /isAdAllowedForPath/, 'uses Phase5 content check');
  assert.match(src, /isSafeLibraryPath|isPathRestricted/, 'uses Phase5 restriction checks');
  assert.match(src, /canAccessLibraryPath/, 'uses library access check');
  // Should not require redesigning call sites: single function with user+path (+ optional canAccess)
  assert.ok(isAdVisibleForUser.length >= 2 && isAdVisibleForUser.length <= 3, 'takes user, path (with optional canAccess)');
});

// ----- ADS_ENABLED / ADS_DISABLED content -----
test('ADS_ENABLED vs ADS_DISABLED content via helper', () => {
  clearAdCache();
  // defaults: txt enabled, pdf disabled
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/a.txt', allowAll), true);
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/a.pdf', allowAll), false);

  setAdCacheForTest({ 'Guidewire/Gosu/PC': ADS_DISABLED });
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  setAdCacheForTest({ 'Guidewire/Gosu/PC': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/PC/a.pdf', allowAll), true); // explicit enabled overrides default pdf disabled
});

// ----- restricted content -----
test('restricted content → ads disabled even if ADS_ENABLED', () => {
  setAdCacheForTest({ 'Private': ADS_ENABLED, 'Guidewire': ADS_ENABLED });
  // canAccess denies Private
  assert.equal(isAdVisibleForUser(USER, 'Private/secret.txt', denyAll), false);
  assert.equal(isAdVisibleForUser(USER, 'Private/secret.txt', allowOnlyGuidewire), false);
  // Even for ADMIN, hasAdFree already disables, but for USER with enabled content but restricted → disabled
  const regular = { id: 19, email: 'reg@example.com', app_role: 'USER' };
  assert.equal(isAdVisibleForUser(regular, 'Private/file.txt', denyAll), false);
  // Non-restricted allowed
  assert.equal(isAdVisibleForUser(regular, 'Guidewire/file.txt', allowAll), true);
});

test('restricted content takes precedence over explicit ADS_ENABLED', () => {
  // Simulate HIDDEN_FOLDERS-like restricted by using denyAll
  setAdCacheForTest({ 'Guidewire/Secret': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Secret/data.txt', denyAll), false);
  // But same path with allowAll would be enabled
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Secret/data.txt', allowAll), true);
});

// ----- unauthenticated/missing user -----
test('unauthenticated/missing user → ads disabled (safe default)', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(null, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  assert.equal(isAdVisibleForUser(undefined, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  assert.equal(isAdVisibleForUser({}, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  assert.equal(isAdVisibleForUser({ email: 'no-id@example.com' }, 'Guidewire/Gosu/PC/a.txt', allowAll), false);
  assert.equal(hasAdFreeCapability(null), false);
  assert.equal(hasAdFreeCapability(undefined), false);
});

// ----- server-side enforcement -----
test('server-side enforcement: no client-provided override', () => {
  const src = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.ok(!/req\.query/.test(src), 'must not read query params');
  assert.ok(!/req\.body/.test(src), 'must not read body');
  assert.ok(!/req\.cookies/.test(src), 'must not read cookies');
  assert.ok(!/localStorage/.test(src), 'must not use localStorage');
  assert.ok(!/window\.document|window\.localStorage/.test(src), 'must not use client JS');
  // Helper signature only server-side
  assert.ok(isAdVisibleForUser.length >= 2);
  // Ensure ad-visibility does not trust client flag like ?ads=1
  setAdCacheForTest({ 'Guidewire': ADS_DISABLED });
  // Even if client tries to force enabled, helper still returns disabled
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/file.txt', allowAll), false);
});

test('no client-provided override: helper ignores extra args', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });
  // Try to pass a fake client flag as user property — should not affect unless it's legitimate ad-free flag
  const maliciousUser = { id: 12, email: 'user@example.com', app_role: 'USER', ads_enabled: true, query: 'ads=1' };
  // ads_enabled is not a recognized ad-free flag, so should still be visible (since content enabled)
  assert.equal(isAdVisibleForUser(maliciousUser, 'Guidewire/file.txt', allowAll), true);
  // But if malicious tries to set ads_free false, still visible
  const malicious2 = { id: 12, email: 'user@example.com', app_role: 'USER', ads_free: false };
  assert.equal(isAdVisibleForUser(malicious2, 'Guidewire/file.txt', allowAll), true);
});

// ----- existing Phase5 inheritance remains intact -----
test('existing Phase5 inheritance behavior remains intact', () => {
  // This duplicates Phase5 folder inheritance but via user-level helper
  setAdCacheForTest({ 'A': ADS_ENABLED, 'A/B': ADS_DISABLED });
  // USER should inherit correctly
  assert.equal(isAdVisibleForUser(USER, 'A/file.txt', allowAll), true);
  assert.equal(isAdVisibleForUser(USER, 'A/B/file.txt', allowAll), false);
  assert.equal(isAdVisibleForUser(USER, 'A/B/C/file.txt', allowAll), false); // inherits B disabled
  // Child override
  setAdCacheForTest({ 'A': ADS_DISABLED, 'A/B/C': ADS_ENABLED });
  assert.equal(isAdVisibleForUser(USER, 'A/file.txt', allowAll), false);
  assert.equal(isAdVisibleForUser(USER, 'A/B/C/file.txt', allowAll), true);
  // Also test via raw Phase5 helper still works
  assert.equal(isAdAllowedForPath('A/B/C/file.txt'), true);
  clearAdCache();
  // Unknown/missing still disabled for USER
  assert.equal(isAdVisibleForUser(USER, '../evil.txt', allowAll), false);
  assert.equal(isAdVisibleForUser(USER, '', allowAll), false);
});

// ----- no scatter -----
test('do not scatter ad logic throughout routes/views', () => {
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // Server should not have ad checks scattered in routes (central helper should be used)
  // Count occurrences of isAdVisibleForUser / isAdAllowedForPath in server.js — should be 0 or minimal (import only)
  const countVisible = (serverSrc.match(/isAdVisibleForUser/g) || []).length;
  assert.ok(countVisible <= 1, `ad logic should not be scattered (found ${countVisible} occurrences)`);
  // Ensure views do not contain ad logic
  const viewsDir = new URL('../src/views/', import.meta.url);
  const viewFiles = fs.readdirSync(fileURLToPath(viewsDir)).filter(f=>f.endsWith('.ejs'));
  for (const f of viewFiles) {
    const content = fs.readFileSync(path.join(fileURLToPath(viewsDir), f), 'utf8');
    assert.ok(!/isAdVisible|ADS_ENABLED/.test(content), `${f} should not contain scattered ad logic`);
  }
});

// ----- no Google Ads / premium changes -----
test('do not add Google Ads or premium payments', () => {
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(!/adsbygoogle/i.test(serverSrc));
  assert.ok(!/googlesyndication/i.test(serverSrc));
  assert.ok(!/googletagmanager/i.test(serverSrc) || /\/auth\/google/.test(serverSrc));
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.ok(!/adsbygoogle/i.test(visSrc));
  assert.ok(!/AdSense/i.test(visSrc));
  assert.ok(!/stripe|payment|checkout|subscription/i.test(visSrc), 'must not implement payments');
  assert.ok(!/premium.*payment/i.test(visSrc.toLowerCase()));
});

test('do not modify Content Permissions / PDF / Recently Viewed etc', () => {
  const visSrc = fs.readFileSync(new URL('../src/library/ad-visibility.js', import.meta.url), 'utf8');
  assert.ok(!/hasContentPermission|COPY_QUERY|DOWNLOAD_PDF/.test(visSrc), 'must not modify content permissions');
  assert.ok(!/recently.*viewed|new-content|discussions/i.test(visSrc));
  const serverSrc = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /recordRecentlyViewed/, 'Recently Viewed still present');
  assert.match(serverSrc, /hasContentPermission/, 'Content Permissions still present');
});
