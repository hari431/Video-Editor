const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hari431@localhost:5432/gosu_query_library' });

async function check() {
  const vv = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'video_views' ORDER BY ordinal_position");
  console.log('video_views columns:', vv.rows.map(r => r.column_name + ':' + r.data_type));
  
  const vl = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'video_likes' ORDER BY ordinal_position");
  console.log('video_likes columns:', vl.rows.map(r => r.column_name + ':' + r.data_type));
  
  await pool.end();
}

check();