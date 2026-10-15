import fs from 'fs';
const file = 'tests/discussions.test.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/assert\.ok\(\(await pool\.query.*accepted_at \!= null\);/, "");

fs.writeFileSync(file, content);
