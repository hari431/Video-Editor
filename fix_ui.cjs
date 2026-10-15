const fs = require('fs');

const views = [
  'src/views/account.ejs',
  'src/views/item.ejs',
  'src/views/library.ejs',
  'src/views/liked.ejs',
  'src/views/new-content.ejs',
  'src/views/plans.ejs',
  'src/views/premium.ejs',
  'src/views/query.ejs',
  'src/views/video.ejs'
];

for (const file of views) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/<small>Access until <%= .*? %><\/small>\s*/g, '');
  content = content.replace(/<p><strong>Legacy Premium Access Until:<\/strong> <%= .*? %><\/p>\s*/g, '');
  content = content.replace(/<p><strong>Status:<\/strong> <%= user.is_active \? 'Active' : 'Inactive' %><\/p>\s*/g, '<p><strong>Status:</strong> Active</p>\n    ');
  fs.writeFileSync(file, content);
}
console.log('UI files updated');
