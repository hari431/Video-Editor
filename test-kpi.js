import { pool } from './src/db/pool.js';
async function test() {
  try {
    const kpiQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE app_role = 'PREMIUM') as active_premium,
        COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'subscription') as recurring_members,
        COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'one_time') as one_time_passes,
        COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'manual') as manual_members
      FROM users
    `;
    await pool.query(kpiQuery);
    console.log('Query OK');
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
test();
