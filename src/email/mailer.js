import nodemailer from 'nodemailer';
import { isAdminEmail } from '../auth/admin.js';

const APP_NAME = 'Learn with me';

// Public links in emails are derived from BASE_URL so they always point at the
// host the application is actually served from (the same BASE_URL drives the
// Google OAuth callback and the same-origin checks). The fallback below only
// matters if BASE_URL is not configured at all.
const DEFAULT_PRODUCTION_URL = 'https://learn-with-me.onrender.com';

function appBaseUrl() {
  const configured = (process.env.BASE_URL || '').trim();
  return (configured || DEFAULT_PRODUCTION_URL).replace(/\/+$/, '');
}

// Test seam: lets tests supply a fake transport so no SMTP server is required.
let testTransport = null;
export function setTransport(transport) {
  testTransport = transport;
}

function adminRecipients() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function isConfigured() {
  return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_FROM);
}

function buildTransport() {
  if (testTransport) {
    return testTransport;
  }
  const port = Number.parseInt(process.env.EMAIL_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });
}

// Deliver a message. Never throws: authentication and access-control decisions
// must not depend on email delivery. SMTP credentials are never logged.
async function sendMail({ to, subject, text, html }) {
  if (!testTransport && !isConfigured()) {
    if (process.env.EMAIL_HOST) {
      console.warn('[mail] EMAIL_FROM is not set; skipping email delivery.');
    }
    return null;
  }
  try {
    const info = await buildTransport().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
      html
    });
    console.log(`[mail] Sent "${subject}" to "${String(to)}".`);
    return { ok: true, messageId: info?.messageId || null };
  } catch (error) {
    console.error(`[mail] Failed to send "${subject}" to "${String(to)}": ${error.message}`);
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The expiry is stored as a UTC timestamp; format it in UTC so the calendar
// date shown in the email always matches the date the administrator selected.
function formatExpiryDate(expiry) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(expiry));
}

function formatRequestTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC'
  }).format(new Date(value));
}

// FEATURE 1 — new access request notification to the configured administrators.
// Recipients come only from ADMIN_EMAILS; user-controlled values are escaped for
// the HTML body. Returns { ok, messageId } or null (never rejects).
export async function sendAccessRequestEmail(user) {
  const to = adminRecipients();
  if (!to.length || !user?.email || user.status !== 'pending' || isAdminEmail(user.email)) {
    return null;
  }

  const name = user.name || user.email;
  const requestedAt = formatRequestTime(user.created_at || user.first_login_at || user.last_login_at || new Date());
  const adminDashboardUrl = `${appBaseUrl()}/admin`;

  const text = [
    'A new user is waiting for approval for Learn with me.',
    '',
    `Name: ${name}`,
    `Email: ${user.email}`,
    `Requested: ${requestedAt}`,
    '',
    'Review the request and grant or deny access at:',
    adminDashboardUrl,
    '',
    'Regards,',
    APP_NAME
  ].join('\n');

  const html = [
    '<p>A new user is waiting for approval for <strong>Learn with me</strong>.</p>',
    `<p><strong>Name:</strong> ${escapeHtml(name)}<br>`,
    `<strong>Email:</strong> ${escapeHtml(user.email)}<br>`,
    `<strong>Requested:</strong> ${escapeHtml(requestedAt)}</p>`,
    `<p>Review the request and grant or deny access at:<br>`,
    `<a href="${adminDashboardUrl}">${adminDashboardUrl}</a></p>`,
    `<p>Regards,<br>${APP_NAME}</p>`
  ].join('\n');

  return sendMail({
    to,
    subject: 'New Access Request - Learn with me',
    text,
    html
  });
}

// FEATURE 2 — access approved notification to the approved user. The recipient
// is the server-side users record being approved (never browser input) and the
// email is sent only after the approval persisted. Returns { ok, messageId } or
// null on failure/guard/skip (never rejects).
export async function sendAccessApprovedEmail(user, expiry) {
  const expiryDate = expiry || user?.access_expires_at;
  if (!user?.email || !expiryDate || user.status !== 'active' || isAdminEmail(user.email)) {
    return null;
  }

  const name = user.name || user.email;
  const expiresAt = formatExpiryDate(expiryDate);
  const appUrl = `${appBaseUrl()}/`;

  const text = [
    `Hello ${name},`,
    '',
    'Your access to Learn with me has been approved.',
    '',
    `Access valid until: ${expiresAt}`,
    '',
    'You can now sign in using your Google account:',
    appUrl,
    '',
    'Regards,',
    APP_NAME
  ].join('\n');

  const html = [
    `<p>Hello ${escapeHtml(name)},</p>`,
    '<p>Your access to <strong>Learn with me</strong> has been approved.</p>',
    `<p><strong>Access valid until:</strong> ${escapeHtml(expiresAt)}</p>`,
    '<p>You can now sign in using your Google account:<br>',
    `<a href="${appUrl}">${appUrl}</a></p>`,
    `<p>Regards,<br>${APP_NAME}</p>`
  ].join('\n');

  return sendMail({
    to: user.email,
    subject: 'Access Approved - Learn with me',
    text,
    html
  });
}