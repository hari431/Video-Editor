import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendAccessRequestEmail, sendAccessApprovedEmail, setTransport } from '../src/email/mailer.js';

const OLD_PRODUCTION_URL = 'gosu-query-library.onrender.com';
const NEW_PRODUCTION_URL = 'https://learn-with-me.onrender.com';

let sent = [];

function fakeTransport() {
  return {
    sendMail: message => {
      sent.push(message);
      return Promise.resolve({ messageId: 'test-message-id' });
    }
  };
}

test.afterEach(() => {
  sent = [];
  setTransport(null);
  delete process.env.ADMIN_EMAILS;
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_FROM;
  delete process.env.BASE_URL;
});

const SOURCE_FILES = [
  'src/email/mailer.js',
  'src/auth/passport.js',
  'src/auth/middleware.js',
  'src/auth/users.js',
  'src/auth/admin.js',
  'src/server.js',
  'src/library/local.js',
  'src/library/tree.js',
  'src/public/app.js',
  'src/views/library.ejs',
  'src/views/query.ejs',
  'src/views/login.ejs',
  'src/views/admin.ejs',
  'src/views/error.ejs',
  'src/views/privacy.ejs',
  'src/views/terms.ejs',
  'src/views/access-pending.ejs',
  'src/views/access-revoked.ejs',
  'src/views/access-expired.ejs'
];

test('the old production URL is not hard-coded anywhere in application source', async () => {
  for (const file of SOURCE_FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes(OLD_PRODUCTION_URL), `${file} must not hard-code ${OLD_PRODUCTION_URL}`);
    assert.ok(!source.includes('https://gosu-query-library'), `${file} must not hard-code the old production URL`);
  }
});

test('Google OAuth callback URL is built from BASE_URL, not a hard-coded host', async () => {
  const source = await readFile(new URL('../src/auth/passport.js', import.meta.url), 'utf8');
  assert.match(source, /callbackURL: `\$\{process\.env\.BASE_URL\}\/auth\/google\/callback`/);
});

test('same-origin protection compares against BASE_URL', async () => {
  const source = await readFile(new URL('../src/auth/middleware.js', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.BASE_URL/);
});

test('email links are derived from BASE_URL (mailer source has no hard-coded app host)', async () => {
  const source = await readFile(new URL('../src/email/mailer.js', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.BASE_URL/);
  assert.ok(!source.includes(OLD_PRODUCTION_URL), 'mailer no longer hard-codes the old URL');
});

test('privacy and terms links are relative and work on any host', async () => {
  for (const file of ['src/views/login.ejs', 'src/views/library.ejs', 'src/views/privacy.ejs', 'src/views/terms.ejs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    // library/privacy/terms now delegate footer to partial; verify via footer partial
    if (source.includes("partials/footer")) {
      continue;
    }
    assert.match(source, /href="\/privacy"/, `${file} keeps the relative /privacy link`);
    assert.match(source, /href="\/terms"/, `${file} keeps the relative /terms link`);
    assert.ok(!source.includes('https://'), `${file} contains no absolute production URL`);
  }
  const footer = await readFile(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /href="\/privacy"/, `footer keeps the relative /privacy link`);
  assert.match(footer, /href="\/terms"/, `footer keeps the relative /terms link`);
  assert.ok(!footer.includes('https://gosu-query-library'), `footer contains no absolute old URL`);
});

test('access-request email links use the configured BASE_URL', async () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.BASE_URL = 'https://learn.example.org';
  setTransport(fakeTransport());

  await sendAccessRequestEmail({
    id: 1,
    email: 'user@example.com',
    name: 'User',
    status: 'pending',
    created_at: new Date('2026-08-28T10:00:00.000Z')
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/learn\.example\.org\/admin/);
  assert.match(sent[0].html, /https:\/\/learn\.example\.org\/admin/);
});

test('approval email links use the configured BASE_URL', async () => {
  process.env.BASE_URL = 'https://learn.example.org';
  setTransport(fakeTransport());

  await sendAccessApprovedEmail(
    { id: 2, email: 'user@example.com', name: 'User', status: 'active' },
    new Date('2026-09-30T23:59:59.999Z')
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/learn\.example\.org\//);
  assert.match(sent[0].html, /https:\/\/learn\.example\.org\//);
});

test('email links fall back to the new production URL when BASE_URL is unset', async () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  delete process.env.BASE_URL;
  setTransport(fakeTransport());

  await sendAccessRequestEmail({
    id: 1,
    email: 'user@example.com',
    name: 'User',
    status: 'pending',
    created_at: new Date('2026-08-28T10:00:00.000Z')
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(`${NEW_PRODUCTION_URL.replace(/[/\\]/g, '\\$&')}\/admin`));
  assert.ok(!sent[0].text.includes(OLD_PRODUCTION_URL));
});