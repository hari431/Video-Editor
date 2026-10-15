const fs = require('fs');
let css = fs.readFileSync('src/public/styles.css', 'utf8');

css = css.replace(
  /\.sticky-query-head \{\n  position: sticky;\n  top: 72px;/,
  ".sticky-query-head {\n  position: sticky;\n  top: 114px;"
);

fs.writeFileSync('src/public/styles.css', css);
