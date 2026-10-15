const fs = require('fs');
let content = fs.readFileSync('tests/admin-folders-premium.test.js', 'utf8');
content = content.replace("assert.equal(res.status, 200);", "console.log('STATUS:', res.status, res.headers.get('location'));\n  assert.equal(res.status, 200);");
fs.writeFileSync('tests/admin-folders-premium.test.js', content);
