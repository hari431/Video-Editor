const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');
content = content.replace(/export \{ app \};[\s\S]*$/, 'export { app };');
fs.writeFileSync('src/server.js', content);
