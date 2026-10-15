import fs from 'fs';

const files = [
  'src/views/admin-paid-product-edit.ejs',
  'src/views/admin-promo-edit.ejs',
  'src/views/admin-promo-create.ejs',
  'src/views/admin-paid-product-create.ejs',
  'src/views/admin-paid-product-plan-edit.ejs',
  'src/views/admin-paid-product-plan-create.ejs'
];

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let newContent = content;

  // Insert nav after <main...>
  newContent = newContent.replace(/(<main[^>]*>)/i, "$1\n  <%- include('partials/admin-nav') %>\n");

  if (newContent !== content) {
    fs.writeFileSync(f, newContent);
    console.log(`Updated ${f}`);
  } else {
    console.log(`No match in ${f}`);
  }
});
