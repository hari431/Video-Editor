import { pool } from './src/db/pool.js';
(async () => {
  try {
    const planRes = await pool.query(
      `SELECT p.id, p.name, p.razorpay_plan_id FROM paid_product_plans p`
    );
    console.log(planRes.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
})();
