const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');
content = content.replace(
  "app.get('/health', (_req, res) =>  status: 'ok', ...getSystemHealth() }));",
  "app.get('/health', (_req, res) => res.json({ status: 'ok', ...getSystemHealth() }));"
);
fs.writeFileSync('src/server.js', content);
