import { pool } from './src/db/pool.js';

async function test() {
  pool.query = async (sql) => {
    if (/SELECT g\.id, g\.valid_until/.test(sql)) {
      return {
        rows: [
          { id: 1001, valid_until: null, status: 'active', product_name: 'Test Product A', product_code: 'TEST_PROD_A', plan_name: 'Lifetime', billing_type: 'one_time' }
        ],
        rowCount: 1
      };
    }
    if (/SELECT id, current_period_end FROM premium_subscriptions/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
  };
  const activeProducts = (await pool.query('SELECT g.id, g.valid_until')).rows;
  console.log(activeProducts);
}
test();
