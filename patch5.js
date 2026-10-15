const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');
content = content.replace("test('1. local deletion removes the user and all dependent records', async () => {", "test('debug session', async () => {\n  const res = await fetch('http://127.0.0.1:'+port+'/admin/users/99/delete', { method: 'POST', headers: { Cookie: OWNER_COOKIE } });\n  console.log('DEBUG:', await res.text());\n});\n\ntest('1. local deletion removes the user and all dependent records', async () => {");
fs.writeFileSync('tests/user-delete.test.js', content);
