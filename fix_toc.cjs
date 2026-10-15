const fs = require('fs');
let css = fs.readFileSync('src/public/styles.css', 'utf8');

css = css.replace(
  /\.knowledge-toc \{\n  position: sticky;\n  top: 92px;/,
  ".knowledge-toc {\n  position: sticky;\n  top: 120px;"
);

fs.writeFileSync('src/public/styles.css', css);
