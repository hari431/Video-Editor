const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');

content = content.replace("assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));", "console.log('Location:', res.headers.get('location'));\n  assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));");
content = content.replace("assert.ok(res.headers.get('location').includes('/login'));", "console.log('Location:', res.headers.get('location'));\n  assert.ok(res.headers.get('location').includes('/login'));");

fs.writeFileSync('tests/user-delete.test.js', content);
