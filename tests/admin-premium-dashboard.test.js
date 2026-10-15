import test from 'node:test';
import assert from 'node:assert';
import { getPremiumDashboardData } from '../src/auth/premium-admin.js';
import { getPromoCodes } from '../src/auth/premium.js';
import { pool } from '../src/db/pool.js';

test('Premium Dashboard Tests', async (t) => {
  const originalQuery = pool.query;
  
  t.beforeEach(() => {
    pool.query = async (queryText, params) => {
      // Very basic mock to prevent crashing
      if (queryText.includes('COUNT(*) FILTER')) {
        return { rows: [{ active_premium: '10', recurring_members: '5', one_time_passes: '3', manual_members: '2' }] };
      }
      if (queryText.includes('FROM premium_promo_redemptions') && queryText.includes('GROUP BY')) {
        return { rows: [{ promotion_code: 'TEST100', used_count: '2' }] };
      }
      if (queryText.includes('COUNT(DISTINCT user_id)')) {
        return { rows: [{ count: '5' }] };
      }
      if (queryText.includes('COUNT(*)')) {
        return { rows: [{ count: '2' }] };
      }
      if (queryText.includes('u.id, u.name, u.email')) {
        return { rows: [
          { id: 1, name: 'User 1', email: 'user1@test.com', app_role: 'PREMIUM', premium_source: 'subscription', sub_status: 'active' },
          { id: 2, name: 'User 2', email: 'user2@test.com', app_role: 'PREMIUM', premium_source: 'one_time', one_time_message: 'Amount: 30000 paise' }
        ] };
      }
      if (queryText.includes('FROM premium_subscription_events pse')) {
        return { rows: [] };
      }
      return { rows: [] };
    };
  });
  
  t.afterEach(() => {
    pool.query = originalQuery;
  });

  await t.test('getPremiumDashboardData executes without error for standard filters', async () => {
    const dataAll = await getPremiumDashboardData('all', '');
    assert.ok(dataAll);
    assert.ok(dataAll.kpis);
    assert.equal(dataAll.kpis.activePremium, 10);
    assert.equal(dataAll.kpis.recurringMembers, 5);
    assert.ok(Array.isArray(dataAll.members));
    assert.equal(dataAll.members.length, 2);
    
    // Quick smoke tests for filters
    await getPremiumDashboardData('recurring', 'test');
    await getPremiumDashboardData('one_time', '');
    await getPremiumDashboardData('manual', '');
    await getPremiumDashboardData('expiring_soon', '');
  });
  
  await t.test('Promotions data reads from environment correctly', async () => {
    const orig = process.env.PREMIUM_PROMO_CODES_JSON;
    process.env.PREMIUM_PROMO_CODES_JSON = JSON.stringify([
      { code: 'TEST100', type: 'flat', value: 100, maxRedemptions: 5, enabled: true },
      { code: 'DISABLED50', type: 'percentage', value: 50, enabled: false }
    ]);
    
    try {
      const data = await getPremiumDashboardData('all', '');
      const promos = data.promotions;
      assert.equal(promos.length, 2);
      
      const testPromo = promos.find(p => p.code === 'TEST100');
      assert.equal(testPromo.health, '🟠 Almost Full'); // 5 max, 2 used (from mock) -> 3 remaining (<= 5)
      assert.equal(testPromo.usedCount, 2);
      assert.equal(testPromo.remainingRedemptions, 3);
      
      const disabledPromo = promos.find(p => p.code === 'DISABLED50');
      assert.equal(disabledPromo.health, '⚪ Disabled');
    } finally {
      process.env.PREMIUM_PROMO_CODES_JSON = orig;
    }
  });
});
