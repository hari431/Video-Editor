/**
 * Standalone 3D Avatar Face Replacement Router
 *
 * Exposes standalone R&D visual route:
 * GET /avatar-face-replacement -> Serves 3D Avatar Face Replacement viewer.
 * GET /sample-avatar-video.mp4 -> Serves local bundled sample video.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function registerAvatarFaceReplacementRoutes(app) {
  app.use('/src/avatar-face-replacement', express.static(__dirname));
  app.use('/avatar-assets', express.static(path.join(publicDir, 'avatar-assets')));

  app.get('/avatar-face-replacement', (req, res) => {
    res.sendFile(path.join(publicDir, 'avatar-face-replacement.html'));
  });

  app.get('/avatar-face-replacement.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'avatar-face-replacement.html'));
  });

  app.get('/sample-avatar-video.mp4', (req, res) => {
    const samplePath = path.resolve(__dirname, '../../poc/remotion-video-poc/public/main.mp4');
    if (fs.existsSync(samplePath)) {
      res.sendFile(samplePath);
    } else {
      res.redirect('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4');
    }
  });
}

export const registerFilmymojiPocRoutes = registerAvatarFaceReplacementRoutes;
