const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');

const replacement = `
  originalConnect = pool.connect;
  pool.connect = async () => ({
    query: pool.query,
    release: () => {}
  });
`;

content = content.replace("originalQuery = pool.query;", "originalQuery = pool.query;" + replacement);
content = content.replace("pool.query = originalQuery; originalQuery = null;", "pool.query = originalQuery; originalQuery = null; if (originalConnect) { pool.connect = originalConnect; originalConnect = null; }");
content = content.replace("let originalQuery = null;", "let originalQuery = null;\nlet originalConnect = null;");

fs.writeFileSync('tests/user-delete.test.js', content);
