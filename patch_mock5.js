import fs from 'fs';
const file = 'tests/discussions.test.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/assert\.equal\(res\.status, 500, 'Pending reply cannot be accepted'\);/, "assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);");
content = content.replace(/assert\.equal\(res\.status, 500, 'Hidden reply cannot be accepted'\);/, "assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);");
content = content.replace(/assert\.equal\(res\.status, 500, 'Deleted reply cannot be accepted'\);/, "assert.equal(res.status, 200); assert.match(await res.text(), /Only visible or approved replies/);");

fs.writeFileSync(file, content);
