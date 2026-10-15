const fs = require('fs');
let content = fs.readFileSync('tests/account.test.js', 'utf8');
content = content.replace("app_role: 'USER' };", "app_role: 'USER', access_expires_at: new Date(Date.now() + 100000).toISOString() };");
fs.writeFileSync('tests/account.test.js', content);
