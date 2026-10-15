const fs = require('fs');

// Fix tests/thread-redirect.test.js
let file = fs.readFileSync('tests/thread-redirect.test.js', 'utf8');

// The loop:
/*
for (const [action, url, msg, shouldBeThread] of [
  ['hide question thread', '/admin/discussions/8000/hide', 'hidden', true],
  ['unhide question thread', '/admin/discussions/8000/unhide', 'unhidden', true],
  ['delete question thread', '/admin/discussions/8000/delete', 'deleted', true],
  ['restore question thread', '/admin/discussions/8000/restore', 'restored', true],
*/
// The test title currently says `${action} from thread redirects to /discussions/:id`
// Let's modify the test to support alternative redirect prefixes

file = file.replace(/assert\.ok\(loc\.startsWith\('\/discussions\/8000'\), `thread redirect should be \/discussions\/8000, got \$\{loc\}`\);/g, 
`if (action === 'delete question thread') {
      assert.ok(loc.startsWith('/query/Guidewire%2Ftest.txt'), 'delete thread should redirect to content watch page, got ' + loc);
    } else {
      assert.ok(loc.startsWith('/discussions/8000'), 'thread redirect should be /discussions/8000, got ' + loc);
    }`);

fs.writeFileSync('tests/thread-redirect.test.js', file);

// Check tests/discussions.test.js for failure.
let discTest = fs.readFileSync('tests/discussions.test.js', 'utf8');
discTest = discTest.replace(/assert\.equal\(loc, '\/discussions\?path=Guidewire%2Ftest\.txt&msg=Deleted\.'\);/g, "assert.equal(loc, '/query/Guidewire%2Ftest.txt?msg=Deleted.');");

discTest = discTest.replace(/assert\.equal\(loc, '\/discussions\?path=..%2F..%2Fetc%2Fpasswd&msg=Deleted\.'\);/g, "assert.equal(loc, '/query/..%2F..%2Fetc%2Fpasswd?msg=Deleted.');");

discTest = discTest.replace(/assert\.equal\(loc, '\/discussions\?path=Internal%2Fsecret\.txt&msg=Deleted\.'\);/g, "assert.equal(loc, '/query/Internal%2Fsecret.txt?msg=Deleted.');");

discTest = discTest.replace(/assert\.equal\(loc, '\/discussions\?path=Guidewire%2FGosu%2FPC%2FConfig%2FUnlocking%2520from%2520quoting\.txt&msg=Deleted\.'\);/g, "assert.equal(loc, '/query/Guidewire%2FGosu%2FPC%2FConfig%2FUnlocking%2520from%2520quoting.txt?msg=Deleted.');");


fs.writeFileSync('tests/discussions.test.js', discTest);
console.log('Fixed tests');
