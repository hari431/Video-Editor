const fs = require('fs');
let css = fs.readFileSync('src/public/styles.css', 'utf8');
css = css.replace(
  /\.breadcrumbs\{display:flex;gap:8px;flex-wrap:wrap;color:#8a94a6;font-size:14px;margin-bottom:20px\}/,
  ".breadcrumbs{display:flex;gap:8px;flex-wrap:wrap;color:#8a94a6;font-size:14px;margin-bottom:20px;position:sticky;top:72px;background:#f6f8fb;z-index:9;padding:12px 0;margin-top:-12px;}"
);
fs.writeFileSync('src/public/styles.css', css);
