const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hari431@localhost:5432/gosu_query_library' });
async function check(){
  // Check existing paid_orders uniqueness constraints behavior with NULLs
  // Check webhook signature handling, double-click protections, etc via code review
  // Let's dump the core verification logic checks

  // 1. Check users
  const users = await pool.query("SELECT id, email, app_role, premium_source, status, access_expires_at FROM users");
  console.log('users', users.rows);

  // 2. Check existing orders history
  const orders = await pool.query("SELECT id, user_id, provider_order_id, provider_payment_id, status FROM paid_orders ORDER BY id DESC LIMIT 5");
  console.log('orders', orders.rows);
  const subs = await pool.query("SELECT id, user_id, provider_subscription_id, status, current_period_end, cancel_at_period_end FROM paid_subscriptions ORDER BY id DESC LIMIT 5");
  console.log('paid_subs', subs.rows);
  const psubs = await pool.query("SELECT id, user_id, provider_subscription_id, status, current_period_end FROM premium_subscriptions ORDER BY id DESC LIMIT 5");
  console.log('premium_subs', psubs.rows);
  const grants = await pool.query("SELECT id, user_id, product_id, grant_type, status, valid_until FROM user_product_grants ORDER BY id DESC LIMIT 5");
  console.log('grants', grants.rows);

  // Check if subscriptions notes validation uses userId match strictly
  // Check webhook route auth
  const promos = await pool.query("SELECT * FROM paid_product_promotions WHERE code IN ('FIRST50','SAVE50')");
  console.log('promo details', promos.rows.map(r=> ({code:r.code, type:r.discount_type, val:r.discount_value, recurring_offer_id:r.recurring_offer_id, enabled:r.is_enabled, valid_until:r.valid_until})));

  // Check ENV plan vs DB plan
  console.log('RAZORPAY_PLAN_ID env', process.env.RAZORPAY_PREMIUM_PLAN_ID);

  await pool.end();
}
check();
