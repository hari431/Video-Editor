const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');
content = content.replace(
  "lastViewedAt: row.last_viewed_at\n      \n    }",
  "lastViewedAt: row.last_viewed_at\n      });\n    }"
);
fs.writeFileSync('src/server.js', content);
