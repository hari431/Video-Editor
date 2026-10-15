import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:url';

test('Developer Tools - Express Routing Integrity Check', async (t) => {

  await t.test('all 10 developer tools GET routes must be registered in server.js', () => {
    const serverPath = new URL('../src/server.js', import.meta.url);
    const src = fs.readFileSync(serverPath, 'utf8');

    const expectedRoutes = [
      '/admin/developer-tools/sql-stitcher',
      '/admin/developer-tools/payload-decoder',
      '/admin/developer-tools/stack-analyzer',
      '/admin/developer-tools/pdf-inspector',
      '/admin/developer-tools/diff',
      '/admin/developer-tools/pcf-explorer',
      '/admin/developer-tools/typelist-generator',
      '/admin/developer-tools/docx-inspector',
      '/admin/developer-tools/csv-analyzer',
      '/admin/developer-tools/hash-inspector',
      '/admin/developer-tools/regex-tester',
      '/admin/developer-tools/encoding-converter',
      '/admin/developer-tools/jwt-decoder',
      '/admin/developer-tools/timestamp-converter'
    ];

    expectedRoutes.forEach(route => {
      // Build a regex matching: app.get('route' or "route"
      const regex = new RegExp(`app\\.get\\(\\s*['"]${route}['"]`);
      assert.ok(
        regex.test(src),
        `Source code in server.js must register GET handler for "${route}"`
      );
    });
  });
});
