/**
 * Standalone Filmymoji POC Router
 *
 * Exposes standalone R&D visual POC route:
 * GET /filmymoji-poc -> Serves standalone 3D Character Face Replacement POC viewer.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function registerFilmymojiPocRoutes(app) {
  // Serve the standalone Phase 1 Filmymoji visual POC
  app.get('/filmymoji-poc', (req, res) => {
    res.sendFile(path.join(publicDir, 'filmymoji-poc.html'));
  });

  app.get('/filmymoji-poc.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'filmymoji-poc.html'));
  });
}
