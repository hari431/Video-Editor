const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');

const regex = /function recordView\(userId, videoPath\) \{[\s\S]*?\/\/ Connect-Pg-Simple session store class\./;

const good = `function recordView(userId, videoPath) {
  return pool.query(
    \`SELECT COUNT(*) AS cnt FROM video_views
       WHERE video_path = $1 AND user_id = $2 AND viewed_at >= NOW() - INTERVAL '24 hours'\`,
    [videoPath, userId]
  ).then(result => {
    if (Number(result.rows[0].cnt) === 0) {
      return pool.query(
        \`INSERT INTO video_views (video_path, user_id, viewed_at) VALUES ($1, $2, NOW())\`,
        [videoPath, userId]
      );
    }
  }).catch(err => {
    console.error('Failed to record view:', err);
  });
}

// Connect-Pg-Simple session store class.`;

content = content.replace(regex, good);
fs.writeFileSync('src/server.js', content);
