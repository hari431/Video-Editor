const fs = require('fs');
let content = fs.readFileSync('tests/account.test.js', 'utf8');
content = content.replace("assert.ok(html.includes('<strong>Status:</strong> Active'), 'Should show Active status');", 
  "if (!html.includes('<strong>Status:</strong> Active')) console.log(html); assert.ok(html.includes('<strong>Status:</strong> Active'), 'Should show Active status');");
fs.writeFileSync('tests/account.test.js', content);
