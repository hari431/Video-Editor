// src/app.js — Standalone BrowserVideoStudio server.
//
// A deliberately small replacement for the original src/server.js monolith.
// It serves exactly two things: the Video Editor (primary) and the Screen
// Recorder (secondary). No database, no OAuth, no library, no external
// integrations.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerVideoEditorRoutes } from './video/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// View locals shared by every render.
app.use((req, res, next) => {
  res.locals.siteName = 'Video Editor';
  res.locals.currentUrl = req.originalUrl || '/';
  next();
});

// Landing page: the two entry points.
app.get('/', (req, res) => {
  res.render('landing', { activeApp: 'home' });
});

// Editor (primary) + recorder (secondary) + their APIs.
registerVideoEditorRoutes(app);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => {
  res.status(404).type('html').send('<!doctype html><h1>404</h1><p>Not found.</p>');
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).type('html').send('<!doctype html><h1>500</h1><p>Something went wrong.</p>');
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`BrowserVideoStudio listening on http://localhost:${PORT}`);
});
