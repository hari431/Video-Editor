const fs = require('fs');
let content = fs.readFileSync('tests/user-delete.test.js', 'utf8');
content = content.replace("if (sql.includes('SELECT * FROM users WHERE id = ')) {", "if (sql.includes('SELECT * FROM users WHERE id = ')) {\n      console.log('>>> MATCHED USERS', params);\n");
fs.writeFileSync('tests/user-delete.test.js', content);
