import { isAdminEmail, isAdminUser, isOwnerUser } from './admin.js';

function isExpired(user) {
  return !user.access_expires_at || new Date(user.access_expires_at) <= new Date();
}

export function requireAuth(req, res, next) {
  if (!req.isAuthenticated?.() || !req.user) {
    return res.redirect('/login');
  }
  if (isAdminUser(req.user)) {
    return next();
  }
  if (req.user.status === 'pending') {
    return res.redirect('/access-pending');
  }
  if (req.user.status === 'revoked') {
    return res.redirect('/access-revoked');
  }
  if (req.user.status !== 'active' && req.user.status !== 'expired') {
    return res.redirect('/login');
  }
  if (req.user.status === 'expired' || isExpired(req.user)) {
    const publicAccessEnabled = process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED === 'true';
    if (!publicAccessEnabled) {
      return res.redirect('/access-expired');
    }
  }
  next();
}

export function requireApiAuth(req, res, next) {
  if (!req.isAuthenticated?.() || !req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (isAdminUser(req.user)) {
    return next();
  }
  if (req.user.status === 'pending') {
    return res.status(403).json({ error: 'Library access has not been granted yet.' });
  }
  if (req.user.status === 'revoked') {
    return res.status(403).json({ error: 'Library access has been revoked.' });
  }
  if (req.user.status !== 'active' && req.user.status !== 'expired') {
    return res.status(403).json({ error: 'Library access denied.' });
  }
  if (req.user.status === 'expired' || isExpired(req.user)) {
    const publicAccessEnabled = process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED === 'true';
    if (!publicAccessEnabled) {
      return res.status(403).json({ error: 'Library access has expired.' });
    }
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

export function requireOwner(req, res, next) {
  if (!isOwnerUser(req.user)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

export function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const referer = req.get('referer');
  const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');

  if (origin && origin !== baseUrl) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }

  if (!origin && referer && !referer.startsWith(`${baseUrl}/`)) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }

  next();
}