const fs = require('fs');
let c = fs.readFileSync('src/views/video.ejs', 'utf8');
console.log('File size:', c.length);
console.log('Has try:', c.includes('try'));
console.log('Has catch:', c.includes('catch'));
console.log('Has <%:', c.includes('<%'));
console.log('Has %>:', c.includes('%>'));
// Print lines around catch blocks
const lines = c.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('catch') || lines[i].includes('try') || lines[i].includes('</script>')) {
    console.log((i+1) + ': ' + lines[i]);
  }
}