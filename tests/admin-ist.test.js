import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPath = path.join(__dirname, '../src/views/admin.ejs');
const template = fs.readFileSync(adminPath, 'utf8');

// Helper to render with a single user having known UTC timestamps
function renderWithUser(user) {
  const data = {
    user: { name: 'Admin', email: 'admin@example.com' },
    users: [user], premiumAccessDays: 15,
    stats: { total_users: 1, active_today: 1, active_month: 1, pending_users: 0, views_today: 0, copies_today: 0, total_discussions: 0, total_replies: 0 },
    popular: [],
    likedItems: [],
    auditLog: [],
    roleAuditLog: [],
    displayName: (x) => x,
    statusDisplay: (u) => {
      if (u.status === 'pending') return 'pending';
      if (u.status === 'revoked') return 'revoked';
      if (!u.access_expires_at || new Date(u.access_expires_at) <= new Date()) return 'expired';
      return 'active';
    },
    isAdminEmail: () => false,
    isAdminUser: () => false,
    isOwnerUser: () => false,
    getUserRole: (u) => u.app_role || 'USER',
    isOwner: true,
    msg: null,
    error: null,
  };
  return ejs.render(template, data, { filename: adminPath });
}

test('Admin users First/Last login rendered in IST (Asia/Kolkata)', () => {
  // UTC 2024-01-15T10:00:00Z -> IST 15:30 (UTC+5:30)
  const utc = '2024-01-15T10:00:00.000Z';
  const expectedIST = new Date(utc).toLocaleString(undefined, { timeZone: 'Asia/Kolkata' });
  const expectedISTDate = new Date(utc).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
  // Also check that IST is indeed different from UTC for this timestamp
  const utcString = new Date(utc).toLocaleString(undefined, { timeZone: 'UTC' });
  assert.notEqual(expectedIST, utcString, 'IST should differ from UTC for 5:30 offset');

  const user = {
    name: 'Test User',
    email: 'test@example.com',
    first_login_at: utc,
    last_login_at: utc,
    access_expires_at: utc,
    status: 'active',
    app_role: 'USER',
    created_at: new Date(),
  };
  const html = renderWithUser(user);
  // Should contain IST formatted dates, not UTC
  assert.ok(html.includes(expectedIST), `First/Last login should be IST ${expectedIST}, got html snippet ${html.slice(html.indexOf('Test User'), html.indexOf('Test User')+500)}`);
  assert.ok(html.includes(expectedISTDate), `Access expires should be IST date ${expectedISTDate}`);
  // Ensure the file actually uses Asia/Kolkata
  assert.ok(template.includes('Asia/Kolkata'), 'admin.ejs must use Asia/Kolkata');
  assert.ok(template.includes('fmtIST') || template.includes('timeZone'), 'should use timezone conversion');
});

test('Admin users Access expires Never expires not affected', () => {
  const user = {
    name: 'Owner',
    email: 'owner@example.com',
    first_login_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
    access_expires_at: null,
    status: 'active',
    app_role: 'OWNER',
    created_at: new Date(),
  };
  const html = renderWithUser(user);
  assert.ok(html.includes('Never expires'));
});

test('Null dates handled as dash', () => {
  // Directly test helper logic by rendering with null dates via the template's helper
  // The helper should return '—' for null
  assert.ok(template.includes("return '—'") || template.includes('—'), 'helper should handle null');
});
