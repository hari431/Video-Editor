import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { clearAdCache, setAdCacheForTest, ADS_ENABLED, ADS_DISABLED, loadAdSettings, getEffectiveAdState } from '../src/library/ad-eligibility.js';
import { isAdVisibleForUser } from '../src/library/ad-visibility.js';
import { renderAdSlot } from '../src/library/ad-slot.js';

// Define users for role/restricted-path rule verification
const OWNER = { id: 100, app_role: 'OWNER' };
const ADMIN = { id: 101, app_role: 'ADMIN' };
const USER = { id: 102, app_role: 'USER' };

test.beforeEach(() => {
  clearAdCache();
});

test.afterEach(() => {
  clearAdCache();
});

// 1. ADSENSE_ENABLED=false renders no placeholder
test('ADSENSE_ENABLED=false renders no placeholder', () => {
  const origEnabled = process.env.ADSENSE_ENABLED;
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origSlot = process.env.ADSENSE_SLOT_ID;

  process.env.ADSENSE_ENABLED = 'false';
  delete process.env.ADSENSE_CLIENT_ID;
  delete process.env.ADSENSE_SLOT_ID;

  setAdCacheForTest({ 'home': ADS_ENABLED });
  
  // Directly verify the helper return value
  const html = renderAdSlot(USER, 'home');
  assert.equal(html, '', 'should render absolutely nothing when adsense is disabled');

  // Restore
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
  if (origSlot !== undefined) process.env.ADSENSE_SLOT_ID = origSlot;
});

// 2. Enabled AdSense still renders correctly
test('enabled AdSense still renders correctly', () => {
  const origEnabled = process.env.ADSENSE_ENABLED;
  const origClient = process.env.ADSENSE_CLIENT_ID;
  const origSlot = process.env.ADSENSE_SLOT_ID;

  process.env.ADSENSE_ENABLED = 'true';
  process.env.ADSENSE_CLIENT_ID = 'ca-pub-99999999';
  process.env.ADSENSE_SLOT_ID = '88888888';

  setAdCacheForTest({ 'home': ADS_ENABLED });

  const html = renderAdSlot(USER, 'home');
  assert.match(html, /data-testid="ad-slot"/, 'should have test id');
  assert.match(html, /data-ad-client="ca-pub-99999999"/, 'should have publisher ID');
  assert.match(html, /data-ad-slot-id="88888888"/, 'should have slot ID');
  assert.match(html, /Ad slot prepared — AdSense configured/, 'should have prepared status text');

  // Restore
  if (origEnabled !== undefined) process.env.ADSENSE_ENABLED = origEnabled;
  if (origClient !== undefined) process.env.ADSENSE_CLIENT_ID = origClient;
  if (origSlot !== undefined) process.env.ADSENSE_SLOT_ID = origSlot;
});

// 3. ad_settings override is loaded at runtime
test('ad_settings override is loaded at runtime', async () => {
  const originalQuery = pool.query;
  try {
    pool.query = async (sql) => {
      if (/SELECT path, ad_state FROM ad_settings/.test(sql)) {
        return {
          rows: [
            { path: 'Guidewire/Gosu/CustomOverride', ad_state: 'ADS_DISABLED' },
            { path: 'Guidewire/Gosu/CustomOverrideEnabled', ad_state: 'ADS_ENABLED' }
          ]
        };
      }
      return { rows: [] };
    };

    // Load ad settings and verify they are cached and retrieved correctly
    const map = await loadAdSettings();
    assert.equal(map.get('Guidewire/Gosu/CustomOverride'), 'ADS_DISABLED');
    assert.equal(map.get('Guidewire/Gosu/CustomOverrideEnabled'), 'ADS_ENABLED');
    assert.equal(getEffectiveAdState('Guidewire/Gosu/CustomOverride/file.txt'), 'ADS_DISABLED');
    assert.equal(getEffectiveAdState('Guidewire/Gosu/CustomOverrideEnabled/file.txt'), 'ADS_ENABLED');
  } finally {
    pool.query = originalQuery;
  }
});

// 4. child paths inherit the correct parent setting
test('child paths inherit the correct parent setting', () => {
  setAdCacheForTest({ 'Guidewire/Gosu': ADS_ENABLED });
  assert.equal(getEffectiveAdState('Guidewire/Gosu/Nested/MoreNested/file.txt'), 'ADS_ENABLED', 'should inherit parent ADS_ENABLED');

  setAdCacheForTest({ 'Guidewire/Gosu': ADS_DISABLED });
  assert.equal(getEffectiveAdState('Guidewire/Gosu/Nested/MoreNested/file.txt'), 'ADS_DISABLED', 'should inherit parent ADS_DISABLED');
});

// 5. explicit disabled override suppresses an otherwise eligible path
test('explicit disabled override suppresses an otherwise eligible path', () => {
  // Gosu files normally default to ADS_ENABLED
  assert.equal(getEffectiveAdState('Guidewire/Gosu/Eligible/file.txt'), 'ADS_ENABLED', 'should default to enabled');

  // Set explicit disabled override for parent
  setAdCacheForTest({ 'Guidewire/Gosu/Eligible': ADS_DISABLED });
  assert.equal(getEffectiveAdState('Guidewire/Gosu/Eligible/file.txt'), 'ADS_DISABLED', 'should be disabled via explicit override');
});

// 6. existing role/restricted-path rules remain intact
test('existing role/restricted-path rules remain intact', () => {
  setAdCacheForTest({ 'Guidewire': ADS_ENABLED });

  // OWNER is ad-free
  assert.equal(isAdVisibleForUser(OWNER, 'Guidewire/Gosu/file.txt'), false, 'OWNER should be ad-free');

  // ADMIN is ad-free
  assert.equal(isAdVisibleForUser(ADMIN, 'Guidewire/Gosu/file.txt'), false, 'ADMIN should be ad-free');

  // USER sees ads
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/file.txt', () => true), true, 'USER sees ads on eligible path');

  // Restricted path (e.g., hidden folders or explicitly returned false via canAccess)
  assert.equal(isAdVisibleForUser(USER, 'Guidewire/Gosu/file.txt', () => false), false, 'restricted/inaccessible paths do not show ads');
});
