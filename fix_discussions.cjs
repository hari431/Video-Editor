const fs = require('fs');

// Fix 1: Remove the duplicate event listener in src/public/discussions.js
let jsFile = fs.readFileSync('src/public/discussions.js', 'utf8');

jsFile = jsFile.replace(/document\.addEventListener\('submit', function \(event\) \{\n  var form = event\.target\.closest\('\.discussion-delete-form'\);\n  if \(!form\) return;\n  if \(!confirm\('Are you sure you want to delete this\?'\)\) \{\n    event\.preventDefault\(\);\n  \}\n\}\);/g, '');

fs.writeFileSync('src/public/discussions.js', jsFile);

// Fix 2: Redirect to contentRouteForPath after deletion in src/server.js
let serverFile = fs.readFileSync('src/server.js', 'utf8');

const oldRedirect = "res.redirect('/discussions?path=' + encodeURIComponent(itemPath) + '&msg=' + encodeURIComponent('Deleted.'));";
const newRedirect = "res.redirect(contentRouteForPath(itemPath) + itemPath.split('/').map(encodeURIComponent).join('/') + '?msg=' + encodeURIComponent('Deleted.'));";

if (serverFile.includes(oldRedirect)) {
    serverFile = serverFile.replace(oldRedirect, newRedirect);
} else {
    console.error('Could not find old redirect in server.js');
}

fs.writeFileSync('src/server.js', serverFile);
console.log('Fixed server.js and discussions.js');
