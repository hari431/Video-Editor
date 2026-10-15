import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import * as users from '../src/auth/users.js';
import { sendAccessRequestEmail, sendAccessApprovedEmail, setTransport } from '../src/email/mailer.js';

let originalQuery = null;
let sent = [];

function installPoolStub(handler) {
  originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (handler) return handler(sql, params);
    return { rowCount: 0, rows: [] };
  };
}

function restorePool() {
  if (originalQuery) {
    pool.query = originalQuery;
    originalQuery = null;
  }
}

// A fake SMTP transport: records every message it would deliver and optionally
// rejects so tests can exercise the "email failed" paths without a mail server.
function fakeTransport(error) {
  return {
    sendMail: message => {
      sent.push(message);
      return error ? Promise.reject(error) : Promise.resolve({ messageId: 'test-message-id' });
    }
  };
}

const ADMIN_EMAILS = ['boss@example.com', 'ops@example.com'];
const PRODUCTION_URL = 'https://learn-with-me.onrender.com';
const PENDING_ROW = {
  id: 1,
  google_user_id: 'google-1',
  email: 'new.user@example.com',
  name: 'New User',
  status: 'pending',
  first_login_at: new Date('2026-08-28T10:00:00.000Z'),
  last_login_at: new Date('2026-08-28T10:00:00.000Z'),
  created_at: new Date('2026-08-28T10:00:00.000Z'),
  access_expires_at: null
};

const ACTIVE_ROW = {
  id: 1,
  google_user_id: 'google-1',
  email: 'new.user@example.com',
  name: 'New User',
  status: 'active',
  created_at: new Date('2026-08-28T10:00:00.000Z'),
  access_expires_at: new Date('2026-09-30T23:59:59.999Z')
};

const ADMIN_ROW = {
  id: 2,
  google_user_id: 'google-admin',
  email: 'boss@example.com',
  name: 'Boss',
  status: 'active',
  created_at: new Date('2026-08-28T10:00:00.000Z'),
  access_expires_at: null
};

test.beforeEach(() => {
  sent = [];
});

test.afterEach(() => {
  restorePool();
  setTransport(null);
  delete process.env.ADMIN_EMAILS;
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_PORT;
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASSWORD;
  delete process.env.EMAIL_FROM;
  delete process.env.BASE_URL;
});

function configureEmail() {
  process.env.ADMIN_EMAILS = ADMIN_EMAILS.join(',');
  process.env.EMAIL_HOST = 'smtp.test';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_USER = 'apikey';
  process.env.EMAIL_PASSWORD = 'secret';
  process.env.EMAIL_FROM = 'Learn with me <library@example.com>';
  process.env.BASE_URL = PRODUCTION_URL;
  setTransport(fakeTransport());
}

test('1. new user creation triggers exactly ONE access-request email', async () => {
  configureEmail();
  installPoolStub(async (sql) => {
    assert.match(sql, /INSERT INTO users/);
    return { rowCount: 1, rows: [PENDING_ROW] };
  });

  const user = await users.createPendingUser({ id: 'google-1', displayName: 'New User', emails: [{ value: 'new.user@example.com' }] });

  assert.equal(user.status, 'pending');
  assert.equal(user.access_expires_at, null);
  assert.equal(sent.length, 1, 'exactly one request email');
  const mail = sent[0];
  assert.equal(mail.subject, 'New Access Request - Learn with me');
  assert.equal(mail.from, 'Learn with me <library@example.com>');
  assert.deepEqual(mail.to, ADMIN_EMAILS, 'recipients are ADMIN_EMAILS only');
  assert.match(mail.text, /New User/);
  assert.match(mail.text, /new.user@example.com/);
  assert.match(mail.text, /waiting for approval/);
  assert.ok(mail.text.includes(`${PRODUCTION_URL}/admin`), 'text links to the BASE_URL admin dashboard');
  assert.match(mail.html, /<strong>Name:<\/strong> New User/);
  assert.ok(mail.html.includes(`${PRODUCTION_URL}/admin`), 'html links to the BASE_URL admin dashboard');
});

test('2. subsequent login of an existing pending user does NOT send another request email', async () => {
  configureEmail();
  let calls = 0;
  installPoolStub(async () => {
    calls += 1;
    if (calls <= 1) return { rowCount: 1, rows: [PENDING_ROW] };
    return { rowCount: 1, rows: [{ ...PENDING_ROW, name: 'New User (updated)' }] };
  });

  await users.createPendingUser({ id: 'google-1', displayName: 'New User', emails: [{ value: 'new.user@example.com' }] });
  assert.equal(sent.length, 1, 'creation sends one');

  await users.touchExistingUser(1, { id: 'google-1', displayName: 'New User (updated)', emails: [{ value: 'new.user@example.com' }] });
  assert.equal(sent.length, 1, 'returning login sends nothing');
});

test('3. admin login does NOT trigger a request email', async () => {
  configureEmail();
  installPoolStub(async () => ({ rowCount: 1, rows: [ADMIN_ROW] }));

  await users.createAdminUser({ id: 'google-admin', displayName: 'Boss', emails: [{ value: 'boss@example.com' }] });
  await users.normalizeAdminUser(2, { id: 'google-admin', displayName: 'Boss', emails: [{ value: 'boss@example.com' }] });
  assert.equal(sent.length, 0, 'no email for administrator logins');

  const direct = await sendAccessRequestEmail({ ...ADMIN_ROW, status: 'pending' });
  assert.equal(direct, null, 'mailer itself never emails a pending-shaped admin account');
});

test('4. successful approval triggers exactly ONE approval email to the approved user', async () => {
  configureEmail();
  let call = 0;
  installPoolStub(async (sql) => {
    call += 1;
    if (/^SELECT/.test(sql)) return { rowCount: 1, rows: [PENDING_ROW] };
    if (/^UPDATE users/.test(sql)) return { rowCount: 1, rows: [ACTIVE_ROW] };
    if (/^INSERT INTO access_audit_log/.test(sql)) return { rowCount: 1 };
    return { rowCount: 0, rows: [] };
  });

  const approved = await users.approveUser(2, 1, ACTIVE_ROW.access_expires_at);

  assert.equal(approved.status, 'active');
  assert.equal(approved.access_expires_at.toISOString(), ACTIVE_ROW.access_expires_at.toISOString());
  assert.equal(sent.length, 1, 'exactly one approval email');
  const mail = sent[0];
  assert.equal(mail.subject, 'Access Approved - Learn with me');
  assert.equal(mail.to, 'new.user@example.com', 'goes to the approved user (server-side record)');
  assert.match(mail.text, /Hello New User/);
  assert.match(mail.text, /access to Learn with me has been approved/);
  assert.match(mail.text, /Access valid until: September 30, 2026/);
  assert.ok(mail.text.includes(`${PRODUCTION_URL}/`), 'text links to the BASE_URL home');
  assert.match(mail.html, /Hello New User/);
  assert.match(mail.html, /September 30, 2026/);
});

test('5. failed approval does NOT trigger the approval email', async () => {
  configureEmail();
  let call = 0;
  installPoolStub(async (sql) => {
    call += 1;
    if (call === 1) return { rowCount: 1, rows: [PENDING_ROW] }; // pre-check read
    throw new Error('database update failed'); // approval update fails
  });

  await assert.rejects(
    () => users.approveUser(2, 1, new Date('2026-09-30T23:59:59.999Z')),
    /database update failed/
  );
  assert.equal(sent.length, 0, 'no email when approval fails');
});

test('6. email failure does NOT prevent user creation', async () => {
  process.env.ADMIN_EMAILS = ADMIN_EMAILS.join(',');
  process.env.EMAIL_HOST = 'smtp.test';
  process.env.EMAIL_FROM = 'Learn with me <library@example.com>';
  setTransport(fakeTransport(new Error('SMTP connection refused')));

  installPoolStub(async () => ({ rowCount: 1, rows: [PENDING_ROW] }));

  const user = await users.createPendingUser({ id: 'google-1', displayName: 'New User', emails: [{ value: 'new.user@example.com' }] });
  assert.equal(user.status, 'pending');
  assert.equal(sent.length, 1, 'delivery was attempted once');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(user.status, 'pending', 'user stays pending even though email failed');
});

test('7. email failure does NOT undo a successful approval', async () => {
  process.env.ADMIN_EMAILS = ADMIN_EMAILS.join(',');
  process.env.EMAIL_HOST = 'smtp.test';
  process.env.EMAIL_FROM = 'Learn with me <library@example.com>';
  setTransport(fakeTransport(new Error('SMTP connection refused')));

  let call = 0;
  installPoolStub(async (sql) => {
    call += 1;
    if (/^SELECT/.test(sql)) return { rowCount: 1, rows: [PENDING_ROW] };
    if (/^UPDATE users/.test(sql)) return { rowCount: 1, rows: [ACTIVE_ROW] };
    if (/^INSERT INTO access_audit_log/.test(sql)) return { rowCount: 1 };
    return { rowCount: 0, rows: [] };
  });

  const approved = await users.approveUser(2, 1, ACTIVE_ROW.access_expires_at);
  assert.equal(approved.status, 'active', 'approval persisted despite email failure');
  assert.equal(sent.length, 1, 'delivery was attempted once');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(approved.access_expires_at.toISOString(), ACTIVE_ROW.access_expires_at.toISOString());
});

test('8. approval email recipient is the approved user served from the DB record', async () => {
  configureEmail();
  let call = 0;
  installPoolStub(async (sql) => {
    call += 1;
    if (/^SELECT/.test(sql)) return { rowCount: 1, rows: [{ ...PENDING_ROW, email: 'db-only@example.com' }] };
    if (/^UPDATE users/.test(sql)) return { rowCount: 1, rows: [{ ...ACTIVE_ROW, email: 'db-only@example.com' }] };
    if (/^INSERT INTO access_audit_log/.test(sql)) return { rowCount: 1 };
    return { rowCount: 0, rows: [] };
  });

  await users.approveUser(2, 1, ACTIVE_ROW.access_expires_at);
  assert.equal(sent[0].to, 'db-only@example.com');
});

test('9. request email goes ONLY to ADMIN_EMAILS (never browser input)', async () => {
  configureEmail();
  installPoolStub(async () => ({ rowCount: 1, rows: [PENDING_ROW] }));

  await users.createPendingUser({ id: 'google-1', displayName: 'New User', emails: [{ value: 'new.user@example.com' }] });
  assert.deepEqual(sent[0].to, ADMIN_EMAILS, 'recipients derive from ADMIN_EMAILS, case/whitespace normalized');

  delete process.env.ADMIN_EMAILS;
  const otherMail = await sendAccessRequestEmail({ id: 3, email: 'new.user@example.com', name: 'New User', status: 'pending' });
  assert.equal(otherMail, null, 'mailer sends nothing when ADMIN_EMAILS is empty');
});

test('10. revoke/reactivate behaviour is unchanged and sends no email', async () => {
  configureEmail();
  let call = 0;
  installPoolStub(async (sql) => {
    call += 1;
    if (/^SELECT/.test(sql)) {
      return { rowCount: 1, rows: [{ ...ACTIVE_ROW, status: 'active' }] };
    }
    if (/^UPDATE users/.test(sql)) {
      return { rowCount: 1, rows: [{ ...ACTIVE_ROW, status: sql.includes("'revoked'") ? 'revoked' : 'active' }] };
    }
    if (/^INSERT INTO access_audit_log/.test(sql)) return { rowCount: 1 };
    return { rowCount: 0, rows: [] };
  });

  const revoked = await users.revokeUser(2, 1);
  assert.equal(revoked.status, 'revoked');
  const reactivated = await users.reactivateUser(2, 1, new Date('2026-09-30T23:59:59.999Z'));
  assert.equal(reactivated.status, 'active');
  assert.equal(sent.length, 0, 'revoke/reactivate send no notification emails');
  assert.equal(call, 6, 'revoke (SELECT+UPDATE+audit) and reactivate (SELECT+UPDATE+audit)');
});

test('user-provided values are HTML-escaped in email bodies', async () => {
  configureEmail();
  const tricky = { ...PENDING_ROW, name: 'Hacker <script>alert(1)</script>' };
  installPoolStub(async () => ({ rowCount: 1, rows: [tricky] }));

  await users.createPendingUser({ id: 'google-1', displayName: tricky.name, emails: [{ value: 'new.user@example.com' }] });
  assert.ok(!sent[0].html.includes('<script>'), 'no raw script tag in HTML body');
  assert.match(sent[0].html, /&lt;script&gt;/);
});

test('unconfigured email still allows login (email is optional)', async () => {
  installPoolStub(async () => ({ rowCount: 1, rows: [PENDING_ROW] }));
  const user = await users.createPendingUser({ id: 'google-1', displayName: 'New User', emails: [{ value: 'new.user@example.com' }] });
  assert.equal(user.status, 'pending');
  assert.equal(sent.length, 0, 'no transport used when EMAIL_HOST is unset');
});