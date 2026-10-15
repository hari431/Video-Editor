import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAdFreeCapability } from '../src/library/ad-visibility.js';

test('Premium Home Page Link Visibility - Business Rules', async (t) => {
  // Prove that visibility logic: premiumEnabled && !isAdFree (using hasAdFreeCapability) works flawlessly

  await t.test('feature disabled + USER → hidden', async () => {
    const premiumEnabled = false;
    const user = { id: 1, app_role: 'USER' };
    const isAdFree = hasAdFreeCapability(user);
    
    const isVisible = premiumEnabled && !isAdFree;
    assert.equal(isVisible, false);
  });

  await t.test('feature enabled + USER → visible', async () => {
    const premiumEnabled = true;
    const user = { id: 1, app_role: 'USER' };
    const isAdFree = hasAdFreeCapability(user);
    
    const isVisible = premiumEnabled && !isAdFree;
    assert.equal(isVisible, true);
  });

  await t.test('feature enabled + PREMIUM → hidden', async () => {
    const premiumEnabled = true;
    const user = { id: 1, app_role: 'PREMIUM' };
    const isAdFree = hasAdFreeCapability(user);
    
    const isVisible = premiumEnabled && !isAdFree;
    assert.equal(isVisible, false);
  });

  await t.test('feature enabled + ADMIN → hidden', async () => {
    const premiumEnabled = true;
    const user = { id: 1, app_role: 'ADMIN' };
    const isAdFree = hasAdFreeCapability(user);
    
    const isVisible = premiumEnabled && !isAdFree;
    assert.equal(isVisible, false);
  });

  await t.test('feature enabled + OWNER → hidden', async () => {
    const premiumEnabled = true;
    const user = { id: 1, app_role: 'OWNER' };
    const isAdFree = hasAdFreeCapability(user);
    
    const isVisible = premiumEnabled && !isAdFree;
    assert.equal(isVisible, false);
  });
});
