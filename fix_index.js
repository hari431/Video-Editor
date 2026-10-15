const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://test:test@127.0.0.1:5432/gosu_query_library_test' });

async function fix() {
  try {
    // Drop the composite index that enforces UNIQUE(video_path, user_id)
    await pool.query('DROP INDEX IF EXISTS idx_video_views_video_path_user_id');
    console.log('Dropped idx_video_views_video_path_user_id index');
    
    // Also drop the video_path index if we want (the likes table has its own)
    await pool.query('DROP INDEX IF EXISTS idx_video_views_video_path');
    console.log('Dropped idx_video_views_video_path index');
    
    // Check remaining indexes
    const { rows } = await pool.query(
      'SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1',
      ['video_views']
    );
    console.log('Remaining indexes on video_views:', JSON.stringify(rows, null, 2));
    
    // Verify the table structure
    const { rows: cols } = await pool.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'video_views' ORDER BY ordinal_position"
    );
    console.log('video_views columns:', JSON.stringify(cols, null, 2));
    
    pool.end();
    console.log('Database fix complete.');
  } catch (err) {
    console.error('Error:', err);
    pool.end();
  }
}

fix();