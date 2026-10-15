const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hari431@localhost:5432/gosu_query_library' });

async function check() {
  const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
  console.log('Tables:', tables.rows.map(r => r.table_name));
  
  const vv = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'video_views' ORDER BY ordinal_position`);
  console.log('\nvideo_views columns:', vv.rows.map(r => r.column_name + ':' + r.data_type));
  
  const vl = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'video_likes' ORDER BY ordinal_position`);
  console.log('\nvideo_likes columns:', vl.rows.map(r => r.column_name + ':' + r.data_type));
  
  const indexes = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('video_views', 'video_likes') ORDER BY indexname`);
  console.log('\nIndexes:', JSON.stringify(indexes.rows.map(r => r.indexname + ': ' + r.indexdef).join(', ')));
  
  await pool.end();
}

check();