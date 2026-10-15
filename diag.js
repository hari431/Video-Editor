import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:Hari431@localhost:5432/gosu_query_library'
});

async function run() {
  try {
    console.log('--- RECENT paid_subscriptions ---');
    const subRes = await pool.query("SELECT * FROM paid_subscriptions WHERE provider = 'razorpay' ORDER BY created_at DESC LIMIT 1");
    if (subRes.rowCount > 0) {
      console.log(JSON.stringify(subRes.rows[0], null, 2));
    }
    
    console.log('\n--- RECENT premium_subscriptions ---');
    const legacyRes = await pool.query("SELECT * FROM premium_subscriptions WHERE provider = 'razorpay' ORDER BY created_at DESC LIMIT 1");
    if (legacyRes.rowCount > 0) {
      console.log(JSON.stringify(legacyRes.rows[0], null, 2));
    }

    console.log('\n--- RECENT paid_orders ---');
    const ordersRes = await pool.query("SELECT * FROM paid_orders WHERE provider = 'razorpay' ORDER BY created_at DESC LIMIT 1");
    if (ordersRes.rowCount > 0) {
      console.log(JSON.stringify(ordersRes.rows[0], null, 2));
    }

    console.log('\n--- RECENT user_product_grants ---');
    const grantsRes = await pool.query("SELECT * FROM user_product_grants ORDER BY created_at DESC LIMIT 1");
    if (grantsRes.rowCount > 0) {
      console.log(JSON.stringify(grantsRes.rows[0], null, 2));
    }

    console.log('\n--- RECENT paid_product_events ---');
    const eventsRes = await pool.query("SELECT * FROM paid_product_events ORDER BY created_at DESC LIMIT 2");
    console.log(JSON.stringify(eventsRes.rows, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

run();
