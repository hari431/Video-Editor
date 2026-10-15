const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');

content = content.replace("let originalQuery = null;", "let originalQuery = null;\nlet originalConnect = null;");
content = content.replace("originalQuery = pool.query;", "originalQuery = pool.query;\n  originalConnect = pool.connect;\n  pool.connect = async () => ({ query: pool.query, release: () => {} });");
content = content.replace("if (originalQuery) { pool.query = originalQuery; originalQuery = null; }", "if (originalQuery) { pool.query = originalQuery; originalQuery = null; }\n  if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }");

fs.writeFileSync('tests/user-delete.test.js', content);
