const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hari431@localhost:5432/gosu_query_library' });

async function test() {
  // Check current state
  const vl = await pool.query('SELECT * FROM video_likes');
  console.log('Current likes:', vl.rows.length, 'rows');
  
  // Test insert
  const testPath = 'Videos/TestLike.mp4';
  await pool.query(
    'INSERT INTO video_likes (video_path, user_id, created_at) VALUES (\$1, \$2, NOW())',
    [testPath, 1]
  );
  const vl2 = await pool.query('SELECT * FROM video_likes WHERE video_path = \$1', [testPath]);
  console.log('After insert:', vl2.rows.length, 'rows');
  
  // Test delete
  await pool.query(
    'DELETE FROM video_likes WHERE video_path = \$1 AND user_id = \$2',
    [testPath, 1]
  );
  const vl3 = await pool.query('SELECT * FROM video_likes WHERE video_path = \$1');
  console.log('After delete:', vl3.rows.length, 'rows');
  
  await pool.end();
}

test();