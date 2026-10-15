const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');

content = content.replace("assert.equal(res.status, 500);\n  const text = await res.text();\n  assert.ok(text.includes('User deletion is only available in local development.'));", "assert.equal(res.status, 302);\n  assert.ok(res.headers.get('location').includes('User%20deletion%20is%20only%20available%20in%20local%20development.'));");
content = content.replace("assert.equal(res.status, 500);\n  const text = await res.text();\n  assert.ok(text.includes('User deletion is only available in local development.'));", "assert.equal(res.status, 302);\n  assert.ok(res.headers.get('location').includes('User%20deletion%20is%20only%20available%20in%20local%20development.'));");
content = content.replace("assert.equal(res.status, 403);\n  const text = await res.text();\n  assert.ok(text.includes('Cannot delete OWNER or ADMIN accounts.'));", "assert.equal(res.status, 302);\n  assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));");
content = content.replace("assert.equal(res.status, 403);\n  const text = await res.text();\n  assert.ok(text.includes('Cannot delete OWNER or ADMIN accounts.'));", "assert.equal(res.status, 302);\n  assert.ok(res.headers.get('location').includes('Cannot%20delete%20OWNER%20or%20ADMIN%20accounts.'));");
content = content.replace("assert.equal(res.status, 403);", "assert.equal(res.status, 302);\n  assert.ok(res.headers.get('location').includes('/login'));");

fs.writeFileSync('tests/user-delete.test.js', content);
