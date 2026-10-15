import { pool } from './src/db/pool.js';

async function main() {
  try {
    const res = await pool.query('SELECT * FROM paid_product_promotions');
    console.log('Total promotions:', res.rowCount);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error querying promotions:', err);
  } finally {
    await pool.end();
  }
}

main();
