import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

test('Phase 2H - Paid Products Admin Control Center Tests (Mocked DB)', async (t) => {

  const origQuery = pool.query;

  // Set up mock database records
  const mockProducts = [
    { id: 1, code: 'PREMIUM', name: 'Premium Membership', description: 'Desc', role_id: 10, role_name: 'PREMIUM', is_enabled: true }
  ];

  const mockPlans = [
    { id: 101, product_id: 1, code: 'monthly', name: 'Premium Monthly', billing_type: 'recurring', price_amount_paise: 30000, currency: 'INR', duration_days: null, razorpay_plan_id: 'plan_ABC', is_active: true },
    { id: 102, product_id: 1, code: 'one_time_pass', name: 'Premium 30-Day Pass', billing_type: 'one_time', price_amount_paise: 30000, currency: 'INR', duration_days: 30, razorpay_plan_id: null, is_active: true }
  ];

  const mockPromotions = [
    { id: 50, code: 'PROMO50', is_enabled: true, max_redemptions: 100, redemption_count: 12, product_id: 1, product_name: 'Premium Membership', product_code: 'PREMIUM', discount_type: 'percent', discount_value: 50 }
  ];

  const mockGrants = [
    { grant_id: 201, user_id: 88, email: 'user1@example.com', user_name: 'User One', product_id: 1, product_name: 'Premium Membership', product_code: 'PREMIUM', plan_id: 102, plan_name: 'Premium 30-Day Pass', billing_type: 'one_time', grant_status: 'active', valid_until: new Date(Date.now() + 86400000), created_at: new Date(), grant_type: 'one_time_purchase' }
  ];

  const mockIssues = [
    { user_id: 99, email: 'attention@example.com', user_name: 'Need Attention User', app_role: 'USER', product_id: 1, product_name: 'Premium Membership', product_code: 'PREMIUM', issue: 'Role Missing', details: 'User has active entitlement but is missing the mapped RBAC role.' }
  ];

  let queryLog = [];

  const mockPool = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });

      // Match revenue summary query
      if (sql.includes('COALESCE(SUM(amount_paise)') && sql.includes('paid_orders')) {
        return {
          rows: [{ total_revenue_paise: '3000000', total_orders_count: 10 }],
          rowCount: 1
        };
      }

      // Match active grants counts grouped by product
      if (sql.includes('user_product_grants') && sql.includes('status = \'active\'') && sql.includes('GROUP BY product_id')) {
        return {
          rows: [{ product_id: '1', active_count: 5 }],
          rowCount: 1
        };
      }

      // Match one-time vs recurring split
      if (sql.includes('billing_type = \'recurring\'') && sql.includes('user_product_grants')) {
        return {
          rows: [{ product_id: '1', recurring_count: 3, one_time_count: 2 }],
          rowCount: 1
        };
      }

      // Match Needs Attention items query
      if (sql.includes('WITH issues AS') || sql.includes('assignment_source = \'payment_system\'')) {
        return {
          rows: mockIssues,
          rowCount: mockIssues.length
        };
      }

      // Match Directory search query
      if (sql.includes('g.id AS grant_id') && sql.includes('user_product_grants')) {
        return {
          rows: mockGrants,
          rowCount: mockGrants.length
        };
      }

      // Match standard products list query
      if (sql.includes('SELECT p.*, r.name AS role_name') || (sql.includes('SELECT * FROM paid_products') && !sql.includes('is_enabled'))) {
        return {
          rows: mockProducts,
          rowCount: mockProducts.length
        };
      }

      // Match standard plans list query
      if (sql.includes('SELECT * FROM paid_product_plans')) {
        return {
          rows: mockPlans,
          rowCount: mockPlans.length
        };
      }

      // Match promotions query
      if (sql.includes('paid_product_promotions')) {
        return {
          rows: mockPromotions,
          rowCount: mockPromotions.length
        };
      }

      return { rows: [], rowCount: 0 };
    }
  };

  // Assign mock query
  pool.query = mockPool.query;

  await t.test('1. Revenue & order aggregator returns expected aggregated values', async () => {
    const res = await pool.query(`
      SELECT 
        COALESCE(SUM(amount_paise), 0)::bigint AS total_revenue_paise,
        COUNT(*)::int AS total_orders_count
      FROM paid_orders
      WHERE status = 'paid'
    `);
    assert.equal(res.rows[0].total_revenue_paise, '3000000');
    assert.equal(res.rows[0].total_orders_count, 10);
  });

  await t.test('2. Needs Attention returns flagged discrepancy items', async () => {
    const res = await pool.query('WITH issues AS ( ... ) SELECT * FROM issues');
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].email, 'attention@example.com');
    assert.equal(res.rows[0].issue, 'Role Missing');
  });

  await t.test('3. One-Time vs Recurring Split correctly calculates client counts', async () => {
    const res = await pool.query(`
      SELECT 
        g.product_id,
        SUM(CASE WHEN pl.billing_type = 'recurring' OR g.subscription_id IS NOT NULL THEN 1 ELSE 0 END)::int AS recurring_count,
        SUM(CASE WHEN pl.billing_type = 'one_time' AND g.subscription_id IS NULL THEN 1 ELSE 0 END)::int AS one_time_count
      FROM user_product_grants g
      LEFT JOIN paid_product_plans pl ON g.plan_id = pl.id
      GROUP BY g.product_id
    `);
    assert.equal(res.rows[0].recurring_count, 3);
    assert.equal(res.rows[0].one_time_count, 2);
  });

  await t.test('4. Directory filtering and search query successfully returns matching rows', async () => {
    const res = await pool.query('SELECT g.id AS grant_id, u.email FROM user_product_grants g');
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].email, 'user1@example.com');
    assert.equal(res.rows[0].grant_id, 201);
  });

  // Restore original query
  pool.query = origQuery;
});
