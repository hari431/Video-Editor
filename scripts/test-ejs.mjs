import ejs from 'ejs';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/views/admin-folders.ejs', 'utf8');
const lines = src.split('\n');

// Test cumulative lines 1-N to find where it first breaks
for (let n = 1; n <= lines.length; n++) {
  const chunk = lines.slice(0, n).join('\n');
  try {
    ejs.compile(chunk);
  } catch {
    // Find the first failing line
    console.error(`First fail at line ${n}: ${lines[n-1].trim().substring(0, 100)}`);
    // Now test just this line in context of line n-1
    for (let m = Math.max(1, n - 3); m <= n + 3 && m <= lines.length; m++) {
      const ctx = lines.slice(Math.max(0, m - 2), m + 1).join('\n');
      try {
        ejs.compile(ctx);
      } catch (e2) {
        console.error(`  Context lines ${m-1}-${m+1} FAIL: ${lines[m-1]?.trim().substring(0, 100)}`);
      }
    }
    break;
  }
}
