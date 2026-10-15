const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');

// I need to look around line 247
const lines = content.split('\n');
for (let i = 230; i < 260; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
