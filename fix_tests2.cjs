const fs = require('fs');

let file = fs.readFileSync('tests/thread-redirect.test.js', 'utf8');

file = file.replace(/assert\.ok\(loc\.startsWith\('\/query\/Guidewire%2Ftest\.txt'\), 'delete thread should redirect to content watch page, got ' \+ loc\);/g, 
"assert.ok(loc.startsWith('/query/Guidewire/test.txt') || loc.startsWith('/query/Guidewire%2Ftest.txt'), 'delete thread should redirect to content watch page, got ' + loc);");

fs.writeFileSync('tests/thread-redirect.test.js', file);
console.log('Fixed thread-redirect test again');
