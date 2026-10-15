import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:url';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import {
  getProductById,
  getPlanById,
  updatePaidProduct,
  updatePaidProductPlan
} from '../src/auth/paidProducts.js';

test('Paid Products Edit Flow Regression Tests', async (t) => {
  const origQuery = pool.query;

  await t.test('1. getProductById uses LEFT JOIN and succeeds even if role_id is not mapped in roles table', async () => {
    let queriedSql = '';
    pool.query = async (sql, params) => {
      queriedSql = sql;
      if (sql.includes('FROM paid_products')) {
        return {
          rows: [
            {
              id: 5,
              code: 'STANDALONE_PROD',
              name: 'Standalone Product',
              description: 'A product with potential unmapped role ID',
              role_id: 9999,
              role_name: null, // LEFT JOIN output if role is missing
              is_enabled: true
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const product = await getProductById(5);
      assert.ok(product);
      assert.equal(product.id, 5);
      assert.equal(product.code, 'STANDALONE_PROD');
      assert.equal(product.role_name, null); // Robust fallback
      assert.match(queriedSql, /LEFT\s+JOIN\s+roles/i);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('2. getPlanById retrieves correct plan attributes', async () => {
    pool.query = async (sql, params) => {
      if (sql.includes('FROM paid_product_plans')) {
        return {
          rows: [
            {
              id: 42,
              product_id: 5,
              code: 'monthly',
              name: 'Monthly Plan',
              billing_type: 'recurring',
              price_amount_paise: 49900,
              currency: 'INR',
              is_active: true
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const plan = await getPlanById(42);
      assert.ok(plan);
      assert.equal(plan.id, 42);
      assert.equal(plan.product_id, 5);
      assert.equal(plan.code, 'monthly');
      assert.equal(plan.price_amount_paise, 49900);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('3. updatePaidProduct database updates work successfully', async () => {
    let updateParams = null;
    pool.query = async (sql, params) => {
      if (sql.includes('UPDATE paid_products')) {
        updateParams = params;
        return {
          rows: [
            {
              id: 5,
              name: params[0],
              description: params[1],
              role_id: params[2],
              is_enabled: params[3]
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('SELECT p.*') && sql.includes('FROM paid_products')) {
        return {
          rows: [
            {
              id: 5,
              code: 'STANDALONE_PROD',
              name: 'Original Standalone Product',
              description: 'Original Description',
              role_id: 10,
              is_enabled: true
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('COUNT(*)') && sql.includes('user_product_grants')) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const updated = await updatePaidProduct(5, {
        name: 'New Product Name',
        description: 'New Description',
        role_id: 2,
        is_enabled: true
      });
      assert.ok(updated);
      assert.equal(updated.name, 'New Product Name');
      assert.equal(updated.description, 'New Description');
      assert.equal(updated.role_id, 2);
      assert.equal(updated.is_enabled, true);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('4. updatePaidProductPlan database updates work successfully', async () => {
    let updateParams = null;
    pool.query = async (sql, params) => {
      if (sql.includes('UPDATE paid_product_plans')) {
        updateParams = params;
        return {
          rows: [
            {
              id: 42,
              name: params[0],
              billing_type: params[1],
              price_amount_paise: params[2],
              currency: params[3],
              duration_days: params[4],
              razorpay_plan_id: params[5],
              is_active: params[6]
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('SELECT * FROM paid_product_plans')) {
        return {
          rows: [
            {
              id: 42,
              product_id: 5,
              code: 'monthly',
              name: 'Original Monthly Plan',
              billing_type: 'recurring',
              price_amount_paise: 49900,
              currency: 'INR',
              duration_days: null,
              razorpay_plan_id: 'plan_USD_original',
              is_active: true
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('COUNT(*)') && sql.includes('user_product_grants')) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const updated = await updatePaidProductPlan(42, {
        name: 'New Plan Name',
        billing_type: 'recurring',
        price_amount_paise: 59900,
        currency: 'USD',
        duration_days: null,
        razorpay_plan_id: 'plan_USD_new',
        is_active: true
      });
      assert.ok(updated);
      assert.equal(updated.name, 'New Plan Name');
      assert.equal(updated.billing_type, 'recurring');
      assert.equal(updated.price_amount_paise, 59900);
      assert.equal(updated.currency, 'USD');
      assert.equal(updated.razorpay_plan_id, 'plan_USD_new');
      assert.equal(updated.is_active, true);
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('5. End-to-end rendering: Product Edit page loads for TEST_PRODUCT and Plan Edit page loads for test_pass', async () => {
    const { app } = await import('../src/server.js');
    const cookieSignature = await import('cookie-signature');

    const ADMIN_SID = 'admin-edit-sid';
    const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
    const ADMIN = {
      id: 99, google_user_id: 'google-admin-edit', email: 'admin-edit@example.com', name: 'Admin Edit User',
      status: 'active', first_login_at: new Date(), last_login_at: new Date(),
      access_expires_at: null, app_role: 'ADMIN', premium_source: null
    };

    const origQuery = pool.query;
    pool.query = async (sql, params = []) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        if (params[0] === ADMIN_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: ADMIN.id }})}]};
        return { rows: [] };
      }
      if (/UPDATE ["']?user_sessions["']?/i.test(sql)) {
        return { rows: [{ sid: 'admin-edit-sid' }] };
      }
      if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
        if (params[0] === ADMIN.id) return { rows: [ADMIN] };
        return { rows: [] };
      }

      // 1. Product Edit page queries
      if (sql.includes('FROM paid_products') && sql.includes('r.name AS role_name')) {
        return {
          rows: [
            {
              id: 2,
              code: 'TEST_PRODUCT',
              name: 'TEST_PRODUCT',
              description: 'Our test product description',
              role_id: 5,
              role_name: 'PREMIUM',
              is_enabled: true
            }
          ],
          rowCount: 1
        };
      }

      // 2. Plan Edit page queries
      if (sql.includes('FROM paid_product_plans') && sql.includes('id = $1')) {
        return {
          rows: [
            {
              id: 10,
              product_id: 2,
              code: 'test_pass',
              name: 'test_pass',
              billing_type: 'one_time',
              price_amount_paise: 9900,
              currency: 'INR',
              duration_days: 7,
              is_active: true
            }
          ],
          rowCount: 1
        };
      }

      // 3. Roles and expiring counts
      if (sql.includes('FROM roles')) {
        return {
          rows: [
            { id: 5, name: 'PREMIUM', description: 'Premium Role' },
            { id: 6, name: 'MEMBER', description: 'Member Role' }
          ],
          rowCount: 2
        };
      }
      if (sql.includes('access_expires_at')) {
        return { rows: [], rowCount: 0 };
      }
      if (/user_roles/i.test(sql) || /folder_permissions/i.test(sql) || /ad_settings/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    };

    // Spin up server on an ephemeral port
    let server = null;
    let port = 0;
    try {
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve();
        });
      });

      const fetchUrl = async (path) => {
        const url = `http://127.0.0.1:${port}${path}`;
        const res = await fetch(url, { headers: { Cookie: ADMIN_COOKIE } });
        const html = await res.text();
        return { status: res.status, html };
      };

      // Test 1: Product Edit Route (/admin/paid-products/2/edit)
      const prodRes = await fetchUrl('/admin/paid-products/2/edit');
      if (prodRes.status !== 200) {
        console.error("HTML ERROR:", prodRes.html);
      }
      assert.equal(prodRes.status, 200, 'Product Edit page should return HTTP 200');
      assert.match(prodRes.html, /Edit Paid Product/, 'Product Edit page should render product edit header');
      assert.match(prodRes.html, /TEST_PRODUCT/, 'Product Edit page should display product name');

      // Test 2: Plan Edit Route (/admin/paid-products/plan/10/edit)
      const planRes = await fetchUrl('/admin/paid-products/plan/10/edit');
      assert.equal(planRes.status, 200, 'Plan Edit page should return HTTP 200');
      assert.match(planRes.html, /Edit Product Plan/, 'Plan Edit page should render plan edit header');
      assert.match(planRes.html, /test_pass/, 'Plan Edit page should display plan name');

    } finally {
      pool.query = origQuery;
      if (server) server.close();
    }
  });
});
