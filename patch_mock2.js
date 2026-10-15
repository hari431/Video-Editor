import fs from 'fs';
const file = 'tests/discussions.test.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace("assert.equal(res.status, 302, 'Admin can accept approved reply');", "if (res.status !== 302) console.log(await res.text()); assert.equal(res.status, 302, 'Admin can accept approved reply');");
fs.writeFileSync(file, content);
