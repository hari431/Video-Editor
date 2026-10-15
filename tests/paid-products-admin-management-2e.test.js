import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const { app } = await import('../src/server.js');
import {
  getAllProductsWithRoles,
  getAllPlans,
  setProductEnabled,
  setPlanActive,
  logPaidProductEvent,
  getPlanById,
  getAllRoles,
  createPaidProduct,
  updatePaidProduct,
  createPaidProductPlan,
  updatePaidProductPlan,
  getProductByCode,
  getPlanByCode
} from '../src/auth/paidProducts.js';

test('Phase 2E-2 - Admin Product & Plan Create/Edit and Validation', async (t) => {

  await t.test('1. Admin views display standard products, plans, statuses, and edit buttons (with NO delete actions)', () => {
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-paid-products.ejs');
    const viewSrc = fs.readFileSync(viewPath, 'utf8');

    // Display fields check
    assert.ok(viewSrc.includes('Product Catalog'), 'Should contain Product Catalog header');
    assert.ok(viewSrc.includes('product.name'), 'Should display product name');
    assert.ok(viewSrc.includes('product.code'), 'Should display product code');
    assert.ok(viewSrc.includes('product.role_name'), 'Should display product role');
    assert.ok(viewSrc.includes('plan.name'), 'Should display plan name');
    assert.ok(viewSrc.includes('plan.billing_type'), 'Should display billing type');
    assert.ok(viewSrc.includes('plan.price_amount_paise'), 'Should display price in paise');
    assert.ok(viewSrc.includes('plan.currency'), 'Should display currency');
    assert.ok(viewSrc.includes('plan.duration_days'), 'Should display duration');
    assert.ok(viewSrc.includes('plan.razorpay_plan_id'), 'Should display Razorpay Plan ID');

    // Actions check
    assert.ok(viewSrc.includes('/admin/paid-products/create'), 'Should link to product creation');
    assert.ok(viewSrc.includes('edit-product-'), 'Should contain edit product buttons');
    assert.ok(viewSrc.includes('add-plan-'), 'Should contain add plan buttons');
    assert.ok(viewSrc.includes('edit-plan-'), 'Should contain edit plan buttons');

    // Check: product delete forms/buttons now exist
    assert.ok(viewSrc.includes('delete-product'), 'Should HAVE product delete forms/buttons');
    assert.ok(!viewSrc.includes('delete-plan'), 'Should NOT have plan delete forms/buttons');
  });

  await t.test('2. Sub-navigation menus have been updated to include Paid Products link', () => {
    const adminPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin.ejs');
    const adminSrc = fs.readFileSync(adminPath, 'utf8');
    assert.ok(adminSrc.includes('/admin/paid-products') || adminSrc.includes('partials/admin-nav'), 'admin.ejs should link to paid products');

    const premiumPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-premium.ejs');
    const premiumSrc = fs.readFileSync(premiumPath, 'utf8');
    assert.ok(premiumSrc.includes('/admin/paid-products') || premiumSrc.includes('partials/admin-nav'), 'admin-premium.ejs should link to paid products');

    const auditPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views/admin-audit-logs.ejs');
    const auditSrc = fs.readFileSync(auditPath, 'utf8');
    assert.ok(auditSrc.includes('/admin/paid-products') || auditSrc.includes('partials/admin-nav'), 'admin-audit-logs.ejs should link to paid products');
  });

  await t.test('3. Database access helpers fetch correct records & toggle state with audit trail logging', async () => {
    const origQuery = pool.query;

    const mockProducts = [
      { id: 1, name: 'Premium Membership', code: 'PREMIUM', role_id: 10, role_name: 'PREMIUM', is_enabled: true }
    ];
    const mockPlans = [
      { id: 101, product_id: 1, name: 'Premium Monthly', code: 'PREMIUM_MONTHLY', billing_type: 'recurring', price_amount_paise: 9900, currency: 'INR', duration_days: 30, razorpay_plan_id: 'plan_123', is_active: true }
    ];

    let queryLog = [];
    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });
        if (/SELECT p\.\*, r\.name AS role_name/i.test(sql)) {
          return { rows: mockProducts, rowCount: mockProducts.length };
        }
        if (/SELECT \* FROM paid_product_plans/i.test(sql)) {
          return { rows: mockPlans, rowCount: mockPlans.length };
        }
        if (/SELECT COUNT\(\*\)/i.test(sql) && /user_product_grants/i.test(sql)) {
          return { rows: [{ count: 0 }], rowCount: 1 };
        }
        if (/UPDATE paid_products/i.test(sql)) {
          mockProducts[0].is_enabled = params[0];
          return { rows: [mockProducts[0]], rowCount: 1 };
        }
        if (/UPDATE paid_product_plans/i.test(sql)) {
          mockPlans[0].is_active = params[0];
          return { rows: [mockPlans[0]], rowCount: 1 };
        }
        if (/INSERT INTO paid_product_events/i.test(sql)) {
          return { rows: [{ id: 999 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      const prods = await getAllProductsWithRoles();
      assert.equal(prods.length, 1);
      assert.equal(prods[0].code, 'PREMIUM');
      assert.equal(prods[0].role_name, 'PREMIUM');

      const plns = await getAllPlans();
      assert.equal(plns.length, 1);
      assert.equal(plns[0].code, 'PREMIUM_MONTHLY');

      const updatedProd = await setProductEnabled(1, false);
      assert.equal(updatedProd.is_enabled, false);

      const updatedPlan = await setPlanActive(101, false);
      assert.equal(updatedPlan.is_active, false);

      const event = await logPaidProductEvent({
        productId: 1,
        userId: 42,
        eventType: 'product_enabled_changed',
        previousStatus: 'enabled',
        newStatus: 'disabled',
        message: 'Product disabled by admin'
      });
      assert.equal(event.id, 999);

      const logInsert = queryLog.find(q => /INSERT INTO paid_product_events/i.test(q.sql));
      assert.ok(logInsert, 'Should have written audit event to database');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('4. POST toggle endpoints handle invalid records or input gracefully', async () => {
    const origQuery = pool.query;
    pool.query = async () => ({ rows: [], rowCount: 0 });

    try {
      const prodRes = await setProductEnabled(999, true);
      assert.equal(prodRes, null, 'Should return null for non-existent product');

      const planRes = await setPlanActive(999, true);
      assert.equal(planRes, null, 'Should return null for non-existent plan');
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('5. Product Create & Edit database helpers insert and update correctly', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });
        if (/SELECT p\.\*, r\.name AS role_name/i.test(sql)) {
          if (params.length > 0 && params[0] === 50) {
            return {
              rows: [{ id: 50, code: 'TEST_PROD', name: 'Test Product', description: 'Useful desc', role_id: 12, is_enabled: true }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/SELECT COUNT\(\*\)/i.test(sql) && /user_product_grants/i.test(sql)) {
          return { rows: [{ count: 0 }], rowCount: 1 };
        }
        if (/INSERT INTO paid_products/i.test(sql)) {
          return {
            rows: [{ id: 50, code: params[0], name: params[1], description: params[2], role_id: params[3], is_enabled: params[4] }],
            rowCount: 1
          };
        }
        if (/UPDATE paid_products/i.test(sql)) {
          const id = params.length === 6 ? params[5] : params[4];
          return {
            rows: [{ id, name: params[0], description: params[1], role_id: params[2], is_enabled: params[3] }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // Create product
      const newProd = await createPaidProduct({
        code: 'TEST_PROD',
        name: 'Test Product',
        description: 'Useful desc',
        role_id: 12,
        is_enabled: true
      });
      assert.ok(newProd);
      assert.equal(newProd.id, 50);
      assert.equal(newProd.code, 'TEST_PROD');
      assert.equal(newProd.name, 'Test Product');

      // Edit product
      const editedProd = await updatePaidProduct(50, {
        name: 'Updated Test Product',
        description: 'New desc',
        role_id: 13,
        is_enabled: false
      });
      assert.ok(editedProd);
      assert.equal(editedProd.id, 50);
      assert.equal(editedProd.name, 'Updated Test Product');
      assert.equal(editedProd.is_enabled, false);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('6. Plan Create & Edit database helpers insert and update correctly', async () => {
    const origQuery = pool.query;
    let queryLog = [];

    const mockPool = {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });
        if (/SELECT \* FROM paid_product_plans/i.test(sql)) {
          if (params.length > 0 && params[0] === 200) {
            return {
              rows: [{ id: 200, product_id: 1, code: 'yearly_test', name: 'Test Yearly Plan', billing_type: 'recurring', price_amount_paise: 49900, currency: 'INR', duration_days: 365, razorpay_plan_id: 'rp_yr_123', is_active: true }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/SELECT COUNT\(\*\)/i.test(sql) && /user_product_grants/i.test(sql)) {
          return { rows: [{ count: 0 }], rowCount: 1 };
        }
        if (/INSERT INTO paid_product_plans/i.test(sql)) {
          return {
            rows: [{
              id: 200,
              product_id: params[0],
              code: params[1],
              name: params[2],
              billing_type: params[3],
              price_amount_paise: params[4],
              currency: params[5],
              duration_days: params[6],
              razorpay_plan_id: params[7],
              is_active: params[8]
            }],
            rowCount: 1
          };
        }
        if (/UPDATE paid_product_plans/i.test(sql)) {
          return {
            rows: [{
              id: params[7],
              name: params[0],
              billing_type: params[1],
              price_amount_paise: params[2],
              currency: params[3],
              duration_days: params[4],
              razorpay_plan_id: params[5],
              is_active: params[6]
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // Create plan
      const plan = await createPaidProductPlan({
        product_id: 1,
        code: 'yearly_test',
        name: 'Test Yearly Plan',
        billing_type: 'recurring',
        price_amount_paise: 49900,
        currency: 'INR',
        duration_days: 365,
        razorpay_plan_id: 'rp_yr_123',
        is_active: true
      });
      assert.ok(plan);
      assert.equal(plan.id, 200);
      assert.equal(plan.code, 'yearly_test');
      assert.equal(plan.price_amount_paise, 49900);

      // Edit plan
      const updatedPlan = await updatePaidProductPlan(200, {
        name: 'Updated Test Yearly Plan',
        billing_type: 'one_time',
        price_amount_paise: 39900,
        currency: 'INR',
        duration_days: 30,
        razorpay_plan_id: null,
        is_active: false
      });
      assert.ok(updatedPlan);
      assert.equal(updatedPlan.id, 200);
      assert.equal(updatedPlan.billing_type, 'one_time');
      assert.equal(updatedPlan.price_amount_paise, 39900);
      assert.equal(updatedPlan.is_active, false);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('7. Create helpers validate and throw appropriate duplicate errors', async () => {
    const origQuery = pool.query;

    const mockPool = {
      query: async (sql, params = []) => {
        if (/paid_products/i.test(sql) && !/INSERT/i.test(sql) && !/UPDATE/i.test(sql)) {
          return { rows: [{ id: 1, code: 'PREMIUM', role_id: 1 }], rowCount: 1 };
        }
        if (/paid_product_plans/i.test(sql) && !/INSERT/i.test(sql) && !/UPDATE/i.test(sql)) {
          return { rows: [{ id: 101, code: 'monthly' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // Duplicate product code error
      await assert.rejects(
        async () => {
          await createPaidProduct({ code: 'PREMIUM', name: 'Duplicate Premium', role_id: 1 });
        },
        /already exists/
      );

      // Duplicate plan code error
      await assert.rejects(
        async () => {
          await createPaidProductPlan({ product_id: 1, code: 'monthly', name: 'Duplicate Plan', billing_type: 'recurring', price_amount_paise: 1000, razorpay_plan_id: 'plan_123' });
        },
        /already exists/
      );
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('8. Lifecycle safeguards: prevent changing RBAC role if active grants exist', async () => {
    const origQuery = pool.query;

    const mockPool = {
      query: async (sql, params = []) => {
        // Mock getProductById
        if (/SELECT \* FROM paid_products/i.test(sql) || ( /paid_products/i.test(sql) && !/INSERT/i.test(sql) && !/UPDATE/i.test(sql) )) {
          return { rows: [{ id: 1, code: 'PREMIUM', role_id: 1, is_enabled: true }], rowCount: 1 };
        }
        // Mock countActiveProductGrants: return 5 active grants
        if (/SELECT COUNT\(\*\)/i.test(sql) && /user_product_grants/i.test(sql) && /product_id/i.test(sql)) {
          return { rows: [{ count: 5 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // Attempting to change role_id from 1 to 2 should fail since active grants exist
      await assert.rejects(
        async () => {
          await updatePaidProduct(1, { name: 'Premium', description: '', role_id: 2, is_enabled: true });
        },
        /Cannot change the mapped RBAC role/
      );
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('9. Lifecycle safeguards: prevent disabling product/plan if active grants exist', async () => {
    const origQuery = pool.query;

    const mockPool = {
      query: async (sql, params = []) => {
        if (/SELECT \* FROM paid_products/i.test(sql) || ( /paid_products/i.test(sql) && !/INSERT/i.test(sql) && !/UPDATE/i.test(sql) )) {
          return { rows: [{ id: 1, code: 'PREMIUM', role_id: 1, is_enabled: true }], rowCount: 1 };
        }
        if (/SELECT \* FROM paid_product_plans/i.test(sql) || ( /paid_product_plans/i.test(sql) && !/INSERT/i.test(sql) && !/UPDATE/i.test(sql) )) {
          return { rows: [{ id: 101, product_id: 1, code: 'monthly', is_active: true }], rowCount: 1 };
        }
        // Mock active grants count = 3
        if (/SELECT COUNT\(\*\)/i.test(sql) && /user_product_grants/i.test(sql)) {
          return { rows: [{ count: 3 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    pool.query = mockPool.query;

    try {
      // Disabling product should fail
      await assert.rejects(
        async () => {
          await setProductEnabled(1, false);
        },
        /Cannot disable product/
      );

      // Disabling plan should fail
      await assert.rejects(
        async () => {
          await setPlanActive(101, false);
        },
        /Cannot disable plan/
      );
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('10. Validation: recurring plans require Razorpay Plan ID, and one-time plans require duration', async () => {
    const origQuery = pool.query;

    pool.query = async () => ({ rows: [], rowCount: 0 });

    try {
      // Recurring plan with missing Razorpay Plan ID should fail
      await assert.rejects(
        async () => {
          await createPaidProductPlan({
            product_id: 1,
            code: 'recurring_fail',
            name: 'Recurring Fail',
            billing_type: 'recurring',
            price_amount_paise: 100,
            razorpay_plan_id: null
          });
        },
        /Recurring plans require a Razorpay Plan ID/
      );

      // One-time plan with missing duration should fail
      await assert.rejects(
        async () => {
          await createPaidProductPlan({
            product_id: 1,
            code: 'onetime_fail',
            name: 'One Time Fail',
            billing_type: 'one_time',
            price_amount_paise: 100,
            duration_days: null
          });
        },
        /One-time plans require duration in days/
      );
    } finally {
      pool.query = origQuery;
    }
  });

});
