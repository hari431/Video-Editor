const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');
const indexPattern = "app.use(express.static(distPath));";
content = content.replace(indexPattern, indexPattern + "\n\napp.get('/debug-auth', (req, res) => res.json({ auth: req.isAuthenticated(), user: req.user, sess: req.session, cook: req.cookies }));");
fs.writeFileSync('src/server.js', content);
