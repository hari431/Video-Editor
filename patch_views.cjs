const fs = require('fs');

const views = ['src/views/video.ejs', 'src/views/item.ejs', 'src/views/query.ejs'];

views.forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Remove inline JS in video.ejs
    if (file === 'src/views/video.ejs') {
      const startTag = `// 1. AJAX Form Submission for Discussions`;
      const endTag = `// 2. Video Progress Tracking`;
      
      const startIndex = content.indexOf(startTag);
      const endIndex = content.indexOf(endTag);
      
      if (startIndex !== -1 && endIndex !== -1) {
        // Find the beginning of the line for startTag
        const before = content.substring(0, startIndex);
        const after = content.substring(endIndex);
        content = before + after;
      }
    }
    
    // Inject script tag
    if (!content.includes('discussion-form.js')) {
      content = content.replace('</body>', '<script src="/discussion-form.js" defer></script>\n</body>');
      fs.writeFileSync(file, content);
      console.log('Patched ' + file);
    }
  }
});
