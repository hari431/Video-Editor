const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');
content = content.replace('calls.push({ sql, params });', 'calls.push({ sql, params });\n    console.log("SQL:", sql, params);');
fs.writeFileSync('tests/user-delete.test.js', content);
