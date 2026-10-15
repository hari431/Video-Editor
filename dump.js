import { pool } from './src/db/pool.js';
async function run() {
  const users = await pool.query('SELECT id, email, app_role, premium_source, access_expires_at, status FROM users');
  console.log("USERS:", users.rows);
  const grants = await pool.query('SELECT * FROM user_product_grants');
  console.log("GRANTS:", grants.rows);
  const psub = await pool.query('SELECT * FROM premium_subscriptions');
  console.log("PREM_SUB:", psub.rows);
  const pplan = await pool.query('SELECT * FROM paid_product_plans');
  console.log("PLANS:", pplan.rows);
  process.exit(0);
}
run();
