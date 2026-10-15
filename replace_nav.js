const fs = require('fs');
const glob = require('glob'); // wait, I don't need glob if I just pass the files

const files = [
  'src/views/admin-recent-activity.ejs',
  'src/views/admin-paid-product-edit.ejs',
  'src/views/admin-discussions.ejs',
  'src/views/admin-user-activity.ejs',
  'src/views/admin.ejs',
  'src/views/admin-promo-edit.ejs',
  'src/views/admin-promo-create.ejs',
  'src/views/admin-system.ejs',
  'src/views/admin-promotions.ejs',
  'src/views/admin-folders.ejs',
  'src/views/admin-paid-product-create.ejs',
  'src/views/admin-expiring-users.ejs',
  'src/views/admin-paid-product-plan-edit.ejs',
  'src/views/admin-audit-logs.ejs',
  'src/views/admin-paid-product-plan-create.ejs',
  'src/views/admin-paid-products.ejs',
  'src/views/admin-premium.ejs',
  'src/views/admin-analytics.ejs'
];

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let newContent = content;

  // Replace <div style="margin-bottom:18px"><a ... </div>
  newContent = newContent.replace(/<div[^>]*?>\s*(?:<a[^>]+class="nav-link"[^>]*>.*?<\/a>\s*(?:·|&middot;|\s)*)+\s*<\/div>/isg, "<%- include('partials/admin-nav') %>");

  // Replace <p style="margin-top:24px"><a ... </p> (like in folders)
  newContent = newContent.replace(/<p[^>]*?>\s*(?:<a[^>]+class="nav-link"[^>]*>.*?<\/a>\s*(?:·|&middot;|\s)*)+\s*<\/p>/isg, "<%- include('partials/admin-nav') %>");

  // Replace <p class="muted"><a ... </p>
  newContent = newContent.replace(/<p[^>]*?>\s*<a[^>]+class="nav-link"[^>]*>.*?<\/a>\s*·\s*<a[^>]+class="nav-link"[^>]*>.*?<\/a>.*?<\/p>/isg, "<%- include('partials/admin-nav') %>");

  if (newContent !== content) {
    fs.writeFileSync(f, newContent);
    console.log(`Updated ${f}`);
  } else {
    console.log(`No match in ${f}`);
  }
});
