const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const regexGet = /app\.get\('\/admin\/premium', requireAuth, requireAdmin, async \(req, res\) => \{[\s\S]*?res\.render\('admin-premium', [^\}]+\}\);\s*\n\}\);/m;
const redirectGet = `app.get('/admin/premium', requireAuth, requireAdmin, (req, res) => {
  res.redirect('/admin/paid-products');
});`;

code = code.replace(regexGet, redirectGet);

const regexPost = /app\.post\('\/admin\/premium\/reconcile', requireAuth, requireAdmin, requireSameOrigin, async \(req, res\) => \{[\s\S]*?res\.redirect\('\/admin\/premium\?msg=' \+ encodeURIComponent\(msg\)\);\s*\n  \} catch \(error\) \{\s*\n    adminError\(res, error\);\s*\n  \}\s*\n\}\);/m;
const redirectPost = `app.post('/admin/premium/reconcile', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  res.redirect('/admin/paid-products');
});`;

code = code.replace(regexPost, redirectPost);

fs.writeFileSync('src/server.js', code);
