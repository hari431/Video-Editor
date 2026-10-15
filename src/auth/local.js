// src/auth/local.js — Minimal, dependency-light local password gate.
//
// Replaces the original Google-OAuth + Postgres session stack with a single
// shared password held in APP_PASSWORD and an in-memory express-session. The
// app is a local, single-user tool; this is intentionally simple.
//
// Not a user database: every authenticated visitor is equal (no roles).
import crypto from 'node:crypto';
import session from 'express-session';

const SESSION_COOKIE = 'bvs.sid';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Constant-time comparison on fixed-length digests.
function passwordMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(sha256(provided), sha256(expected));
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createLocalAuth(app) {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) {
    console.warn(
      '[auth] APP_PASSWORD is not set — the app is running UNPROTECTED. ' +
      'This is acceptable only for local, single-user use. Set APP_PASSWORD to require a password.'
    );
  }

  app.use(session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12
    }
  }));

  function isAuthed(req) {
    return Boolean(req.session && req.session.authed);
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    const next_ = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${next_}`);
  }

  function requireApiAuth(req, res, next) {
    if (isAuthed(req)) return next();
    return res.status(401).json({ error: 'Authentication required.' });
  }

  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    const next_ = typeof req.query.next === 'string' ? req.query.next : '/';
    res.type('html').send(renderLoginPage({ next: next_, error: null }));
  });

  app.post('/login', (req, res) => {
    const next_ = typeof req.body?.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
    const provided = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!appPassword || passwordMatches(provided, appPassword)) {
      req.session.authed = true;
      req.session.user = { name: 'local' };
      return req.session.save(() => res.redirect(next_));
    }
    return res.status(401).type('html').send(renderLoginPage({ next: next_, error: 'Incorrect password.' }));
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  return { requireAuth, requireApiAuth, isAuthed };
}

function renderLoginPage({ next, error }) {
  const safeNext = escapeHtml(next || '/');
  const errorBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · BrowserVideoStudio</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
  form { background: #1e293b; padding: 32px; border-radius: 14px; box-shadow: 0 20px 45px -20px rgba(0,0,0,.7); width: min(92vw, 340px); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #94a3b8; }
  label { display: block; font-size: 12px; margin-bottom: 6px; color: #cbd5e1; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 14px; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: none; border-radius: 8px; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .err { color: #f87171; font-size: 13px; margin: 0 0 12px; }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>BrowserVideoStudio</h1>
    <p class="sub">Enter the local password to continue.</p>
    ${errorBlock}
    <input type="hidden" name="next" value="${safeNext}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
