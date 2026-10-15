const fs = require('fs');
let content = fs.readFileSync('tests/admin-folders-premium.test.js', 'utf8');
content = content.replace('calls.push({ sql, params });', 'calls.push({ sql, params });\n    console.log("SQL FOLDERS:", sql);');
fs.writeFileSync('tests/admin-folders-premium.test.js', content);
