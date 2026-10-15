const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');

// For Test 4
content = content.replace(
  "const res = await http('/admin/users/10/delete', {\n    method: 'POST',\n    headers: { 'Cookie': OWNER_COOKIE },\n    redirect: 'manual'\n  });",
  "const res = await http('/admin/users/10/delete', {\n    method: 'POST',\n    headers: { 'Cookie': ADMIN_COOKIE },\n    redirect: 'manual'\n  });"
);

// For Test 6
content = content.replace(
  "assert.ok(res.headers.get('location').includes('/login'));",
  "assert.ok(res.headers.get('location').includes('/access-expired'));"
);

fs.writeFileSync('tests/user-delete.test.js', content);
