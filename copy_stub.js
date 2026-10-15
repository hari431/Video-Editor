const fs = require('fs');

const folders = fs.readFileSync('tests/admin-folders-premium.test.js', 'utf8');
const deleteTest = fs.readFileSync('tests/user-delete.test.js', 'utf8');

const foldersStub = folders.match(/function installPoolStub\(handler\) \{[\s\S]*?return handler \? handler\(sql, params\) : \{ rowCount: 0, rows: \[\] \};\n  \};\n\}/)[0];

const deleteStub = deleteTest.match(/function installPoolStub\(handler\) \{[\s\S]*?return handler \? handler\(sql, params\) : \{ rowCount: 0, rows: \[\] \};\n  \};\n\}/)[0];

const newDelete = deleteTest.replace(deleteStub, foldersStub);
fs.writeFileSync('tests/user-delete.test.js', newDelete);
