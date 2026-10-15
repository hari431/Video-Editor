const fs = require('fs');
let content = fs.readFileSync('src/server.js', 'utf8');

const bad = `    }
  }
// Connect-Pg-Simple session store class.`;

const good = `    }
  }).catch(err => {
    console.error('Failed to record view:', err);
  });
}

// Connect-Pg-Simple session store class.`;

content = content.replace(bad, good);
fs.writeFileSync('src/server.js', content);
