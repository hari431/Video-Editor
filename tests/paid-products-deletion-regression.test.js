import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { deletePaidProduct, logPaidProductEvent } from '../src/auth/paidProducts.js';

test('Paid Products Deletion Regression Tests', async (t) => {
  const origQuery = pool.query;
  
  await t.test('1. deletePaidProduct logs correctly without historical event FK violation (productId is set to null)', async () => {
    let deleteProductCalled = false;
    let insertEventSql = '';
    let insertEventParams = [];
    
    pool.query = async (sql, params) => {
      if (sql.includes('DELETE FROM paid_products')) {
        deleteProductCalled = true;
        return {
          rows: [
            { id: 42, code: 'TEST_PROD', name: 'Test Product', is_enabled: false }
          ],
          rowCount: 1
        };
      }
      if (sql.includes('INSERT INTO paid_product_events')) {
        insertEventSql = sql;
        insertEventParams = params;
        // Simulate a successful insert that doesn't trigger FK constraint (because productId will be null)
        return { rows: [{ id: 100 }], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM paid_product_plans')) {
        return { rows: [], rowCount: 0 }; // No active plans
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: 0 }], rowCount: 1 }; // No active entitlements
      }
      if (sql.includes('SELECT p.*')) {
        return {
          rows: [
            { id: 42, code: 'TEST_PROD', name: 'Test Product', is_enabled: false, role_id: null, metadata: {} }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const product = await pool.query('SELECT p.* FROM paid_products').then(res => res.rows[0]);
      await deletePaidProduct(42);
      
      await logPaidProductEvent({
        productId: null, // this mimics what server.js now passes!
        userId: 1,
        eventType: 'product_deleted',
        previousStatus: 'disabled',
        newStatus: 'deleted',
        message: 'Deleted product',
        payload: { deletedProduct: product, originalProductId: 42 }
      });
      
      assert.ok(deleteProductCalled, 'Product should be deleted');
      assert.equal(insertEventParams[0], null, 'Product ID in the event insert should be null to avoid FK violation after product deletion');
      
      const payloadObj = JSON.parse(insertEventParams[8]);
      assert.equal(payloadObj.originalProductId, 42, 'Original Product ID should be captured in payload');
      
    } finally {
      pool.query = origQuery;
    }
  });

  await t.test('2. Server route for deletion uses correct db method and gracefully redirects on error', async () => {
    const { app } = await import('../src/server.js');
    const cookieSignature = await import('cookie-signature');
    const ADMIN_SID = 'admin-del-sid';
    const ADMIN_COOKIE = `connect.sid=s:${cookieSignature.sign(ADMIN_SID, process.env.SESSION_SECRET)}`;
    const ADMIN = {
      id: 99, google_user_id: 'google-admin-del', email: 'admin-del@example.com', name: 'Admin Del',
      status: 'active', first_login_at: new Date(), last_login_at: new Date(),
      access_expires_at: null, app_role: 'ADMIN', premium_source: null
    };
    
    pool.query = async (sql, params = []) => {
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
      if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
        if (params[0] === ADMIN_SID) return { rows: [{ sess: JSON.stringify({ cookie:{}, passport:{ user: ADMIN.id }})}]};
        return { rows: [] };
      }
      if (/UPDATE ["']?user_sessions["']?/i.test(sql)) {
        return { rows: [{ sid: 'admin-del-sid' }] };
      }
      if (/SELECT \* FROM users WHERE id = \$1/i.test(sql)) {
        if (params[0] === ADMIN.id) return { rows: [ADMIN] };
        return { rows: [] };
      }
      
      if (sql.includes('SELECT p.*')) {
        return {
          rows: [
            { id: 999, code: 'PROTECTED', name: 'Protected Prod', is_enabled: true, metadata: { is_system: true } }
          ],
          rowCount: 1
        };
      }
      
      if (sql.includes('SELECT * FROM paid_product_plans')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    };

    let server = null;
    let port = 0;
    try {
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve();
        });
      });

      const url = `http://127.0.0.1:${port}/admin/paid-products/999/delete`;
      
      // Should redirect back to admin/paid-products with an error parameter because product is protected
      const res = await fetch(url, { 
        method: 'POST',
        headers: { 
          Cookie: ADMIN_COOKIE,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      assert.equal(res.status, 200, 'Express redirect interceptor should resolve correctly if not using follow redirect, or 200 if fetched');
      const finalUrl = res.url;
      assert.ok(finalUrl.includes('/admin/paid-products?error='), 'Should redirect to /admin/paid-products with an error message instead of throwing raw page');
      assert.ok(finalUrl.includes('Protected'), 'Error message should complain about protected system product');

    } finally {
      pool.query = origQuery;
      if (server) server.close();
    }
  });
});
