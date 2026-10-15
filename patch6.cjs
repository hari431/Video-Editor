const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');
content = content.replace("test('1. local deletion removes the user and all dependent records', async () => {", "test('debug auth', async () => {\n  const res = await fetch('http://127.0.0.1:'+port+'/debug-auth', { headers: { Cookie: OWNER_COOKIE } });\n  console.log('DEBUG AUTH:', await res.json());\n});\n\ntest('1. local deletion removes the user and all dependent records', async () => {");
fs.writeFileSync('tests/user-delete.test.js', content);
