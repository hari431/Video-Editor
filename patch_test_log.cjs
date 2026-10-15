const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');
content = content.replace("const text = await res.text();", "const text = await res.text();\n  console.log('RESPONSE:', res.status, text);");
fs.writeFileSync('tests/user-delete.test.js', content);
