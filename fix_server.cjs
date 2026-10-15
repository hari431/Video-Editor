const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');

const bad = `    if (Number(result.rows[0].cnt) === 0) {
      return pool.query(
        \`INSERT INTO video_views (video_path, user_id, viewed_at) VALUES ($1, $2, NOW())\`,
        [videoPath, userId]
      );
    }
  }
// Connect-Pg-Simple session store class.`;

const good = `    if (Number(result.rows[0].cnt) === 0) {
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

content = content.replace(bad, good);
fs.writeFileSync('src/server.js', content);
