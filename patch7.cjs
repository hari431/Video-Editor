const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');
content = content.replace("app.get('/debug-auth', (req, res) => {", "");
content = content.replace("res.json({", "");
content = content.replace("isAuthenticated: req.isAuthenticated(),", "");
content = content.replace("user: req.user,", "");
content = content.replace("session: req.session,", "");
content = content.replace("cookies: req.cookies", "");
content = content.replace("});", "");
content = content.replace("});", "");

// Now add it properly
const indexPattern = "app.use(express.static(distPath));";
content = content.replace(indexPattern, indexPattern + "\n\napp.get('/debug-auth', (req, res) => res.json({ auth: req.isAuthenticated(), user: req.user, sess: req.session, cook: req.cookies }));");
fs.writeFileSync('src/server.js', content);
