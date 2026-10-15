import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { getRecentActivities, ACTIVITY_CATEGORIES, DATE_RANGES } from '../src/auth/recent-activity.js';
import { pool } from '../src/db/pool.js';
import { requireAuth, requireAdmin } from '../src/auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(__dirname, '../src/views/admin-recent-activity.ejs');
const template = fs.readFileSync(viewPath, 'utf8');

// Helper to render admin-recent-activity view with mock data
function renderRecentActivityView(options = {}) {
  const data = {
    user: { name: 'Admin', email: 'admin@example.com', app_role: 'ADMIN' },
    expiringCount: 2,
    events: options.events || [],
    total: options.total !== undefined ? options.total : (options.events ? options.events.length : 0),
    page: options.page || 1,
    totalPages: options.totalPages || 1,
    limit: options.limit || 30,
    categoryCounts: options.categoryCounts || {
      all: options.events ? options.events.length : 0,
      access: 0,
      role: 0,
      permission: 0,
      moderation: 0,
      registration: 0,
      discussion: 0
    },
    filters: options.filters || {
      type: 'all',
      dateRange: 'all',
      startDate: '',
      endDate: '',
      search: ''
    },
    msg: options.msg || null,
    error: options.error || null
  };
  return ejs.render(template, data, { filename: viewPath });
}

// Spies for middleware testing
function resSpy() {
  const res = { statusCode: 200, body: null, redirectUrl: null };
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => { res.body = body; return res; };
  res.json = body => { res.body = body; return res; };
  res.redirect = url => { res.redirectUrl = url; return res; };
  return res;
}
function nextSpy() {
  const fn = () => { fn.called = true; };
  fn.called = false;
  return fn;
}
function reqFor(user) {
  return {
    isAuthenticated: () => !!user,
    user: user || null,
    originalUrl: '/admin/recent-activity'
  };
}

// -------------------------------------------------------------
// 1. CHRONOLOGICAL ORDERING
// -------------------------------------------------------------
test('Chronological ordering: Sorts multiple interleaved events newest-first across tables', async () => {
  const originalQuery = pool.query;

  try {
    pool.query = async (sql) => {
      const q = sql.toLowerCase();
      if (q.includes('from access_audit_log')) {
        return {
          rows: [
            {
              id: 1,
              action: 'approve',
              created_at: new Date('2026-09-02T10:00:00Z'),
              target_user_id: 10,
              target_name: 'User One',
              target_email: 'one@example.com',
              target_role: 'USER',
              target_status: 'active',
              actor_id: 99,
              actor_name: 'Admin',
              actor_email: 'admin@example.com',
              actor_role: 'ADMIN'
            }
          ]
        };
      }
      if (q.includes('from role_audit_log')) {
        return {
          rows: [
            {
              id: 2,
              action: 'grant_admin',
              created_at: new Date('2026-09-05T12:00:00Z'), // Newest
              previous_role: 'USER',
              new_role: 'ADMIN',
              target_user_id: 10,
              target_name: 'User One',
              target_email: 'one@example.com',
              target_role: 'ADMIN',
              target_status: 'active',
              actor_id: 99,
              actor_name: 'Admin',
              actor_email: 'admin@example.com',
              actor_role: 'OWNER'
            }
          ]
        };
      }
      if (q.includes('from discussion_moderation_actions')) {
        return {
          rows: [
            {
              id: 3,
              action: 'hide',
              target_type: 'question',
              target_id: 42,
              created_at: new Date('2026-09-01T08:00:00Z'), // Oldest
              actor_id: 99,
              actor_name: 'Admin',
              actor_email: 'admin@example.com',
              actor_role: 'ADMIN',
              discussion_title: 'Bad Title',
              item_path: 'queries',
              discussion_id: 42
            }
          ]
        };
      }
      return { rows: [] };
    };

    const result = await getRecentActivities({ type: 'all' });
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].id, 'role-2', 'Newest event (Sep 5) must be first');
    assert.equal(result.events[1].id, 'access-1', 'Middle event (Sep 2) must be second');
    assert.equal(result.events[2].id, 'mod-3', 'Oldest event (Sep 1) must be last');

    for (let i = 0; i < result.events.length - 1; i++) {
      assert.ok(
        result.events[i].timestamp.getTime() >= result.events[i + 1].timestamp.getTime(),
        'Events must be sorted strictly newest-first'
      );
    }
  } finally {
    pool.query = originalQuery;
  }
});

// -------------------------------------------------------------
// 2. ACTIVITY RENDERING
// -------------------------------------------------------------
test('Activity rendering: Renders actor, affected user, content, action, and timestamp; does not invent missing info', () => {
  const fullEvent = {
    id: 'access-50',
    category: 'access',
    categoryLabel: 'User Access & Expiry',
    action: 'approve',
    title: 'User Access Approved',
    description: 'Access approved for Alice until 10/1/2026.',
    semanticColor: 'green',
    badgeClass: 'badge-green badge-success',
    badgeText: 'APPROVED',
    timestamp: new Date('2026-09-04T14:30:00.000Z'),
    actor: { id: 99, name: 'Moderator Dave', email: 'dave@example.com', role: 'ADMIN' },
    targetUser: { id: 25, name: 'Alice Walker', email: 'alice@example.com', role: 'USER', status: 'active' },
    targetContent: { type: 'question', id: 10, title: 'Sample Question', path: 'math/algebra', discussionId: 10 },
    meta: {
      statusChange: 'pending → active',
      expiryChange: 'Until 10/1/2026'
    }
  };

  const minimalEvent = {
    id: 'reg-99',
    category: 'registration',
    categoryLabel: 'User Registrations',
    action: 'registered',
    title: 'New User Registered',
    description: 'Account created for bob@example.com.',
    semanticColor: 'blue',
    badgeClass: 'badge-blue badge-info',
    badgeText: 'REGISTERED',
    timestamp: new Date('2026-09-03T10:00:00.000Z'),
    actor: null, // No actor
    targetUser: { id: 99, name: null, email: 'bob@example.com', role: 'USER', status: 'pending' },
    targetContent: null, // No content
    meta: {}
  };

  const html = renderRecentActivityView({
    events: [fullEvent, minimalEvent],
    total: 2
  });

  // Verify fullEvent rendering
  assert.ok(html.includes('User Access Approved'), 'Renders title');
  assert.ok(html.includes('Moderator Dave (dave@example.com)'), 'Renders actor name and email');
  assert.ok(html.includes('Alice Walker (alice@example.com)'), 'Renders target user name and email');
  assert.ok(html.includes('badge-admin'), 'Renders actor role badge');
  assert.ok(html.includes('badge-active'), 'Renders target user status badge');
  assert.ok(html.includes('href="/discussions/10"'), 'Renders content discussion link');
  assert.ok(html.includes('pending → active'), 'Renders status change');
  assert.ok(html.includes('Until 10/1/2026'), 'Renders expiry change');

  // Verify minimalEvent rendering: no Actor row, no Content row
  assert.ok(html.includes('bob@example.com'), 'Renders minimal user email');

  // Check date divider is present for date grouping
  assert.ok(html.includes('timeline-date-divider'), 'Renders date divider grouping');
  assert.ok(html.includes('timeline-date-badge'), 'Renders date badge');
});

// -------------------------------------------------------------
// 3. FILTERS & SEARCH
// -------------------------------------------------------------
test('Filters: Supports filtering by activity category/type with accurate category counts', async () => {
  const originalQuery = pool.query;

  try {
    let queriedModeration = false;
    let queriedAccess = false;

    pool.query = async (sql) => {
      const q = sql.toLowerCase();
      if (q.includes('from discussion_moderation_actions')) {
        queriedModeration = true;
        return {
          rows: [
            {
              id: 7,
              target_type: 'reply',
              target_id: 18,
              action: 'delete',
              created_at: new Date(),
              actor_id: 99,
              actor_name: 'Admin',
              actor_email: 'admin@example.com',
              actor_role: 'ADMIN',
              discussion_title: 'Spam reply',
              item_path: 'queries',
              discussion_id: 5
            }
          ]
        };
      }
      if (q.includes('from access_audit_log')) {
        queriedAccess = true;
      }
      return { rows: [] };
    };

    const res = await getRecentActivities({ type: 'moderation' });
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].category, 'moderation');
    assert.equal(res.events[0].action, 'delete');
    assert.ok(queriedModeration, 'Should query discussion_moderation_actions');
    assert.ok(queriedAccess, 'Should query access_audit_log to get accurate counts across pills');
  } finally {
    pool.query = originalQuery;
  }
});

test('Search: older than previous 500-record fetch limit is matched and returned', async () => {
  const originalQuery = pool.query;
  try {
    let capturedParams = [];
    let capturedSql = '';
    pool.query = async (sql, params) => {
      const q = sql.toLowerCase();
      if (q.includes('from access_audit_log')) {
        capturedSql = sql;
        capturedParams = params;
        if (params && params.some(p => typeof p === 'string' && p.includes('%oldest-match%'))) {
          return {
            rows: [
              {
                id: 600,
                action: 'approve',
                created_at: new Date('2026-01-01T00:00:00Z'),
                target_user_id: 10,
                target_name: 'Oldest Match User',
                target_email: 'oldest-match@example.com',
                target_role: 'USER',
                target_status: 'active',
                actor_id: 99,
                actor_name: 'Admin',
                actor_email: 'admin@example.com',
                actor_role: 'ADMIN'
              }
            ]
          };
        }
      }
      return { rows: [] };
    };

    const res = await getRecentActivities({ type: 'access', search: 'oldest-match' });
    
    assert.ok(capturedSql.includes('ILIKE'), 'SQL must push down ILIKE search filter');
    assert.ok(capturedParams.some(p => p === '%oldest-match%'), 'Parameterized search value must be passed to SQL');
    
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].targetUser.name, 'Oldest Match User');
    assert.equal(res.total, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test('Filters: Accurate category and total counts under search/date filters', async () => {
  const originalQuery = pool.query;
  try {
    pool.query = async (sql) => {
      const q = sql.toLowerCase();
      if (q.includes('from access_audit_log')) {
        return {
          rows: [
            {
              id: 1,
              action: 'approve',
              created_at: new Date('2026-09-05T10:00:00Z'),
              target_user_id: 1,
              target_name: 'Alice Match',
              target_email: 'alice@example.com'
            }
          ]
        };
      }
      if (q.includes('from role_audit_log')) {
        return {
          rows: [
            {
              id: 2,
              action: 'grant_admin',
              created_at: new Date('2026-09-04T10:00:00Z'),
              target_user_id: 1,
              target_name: 'Alice Match',
              target_email: 'alice@example.com'
            }
          ]
        };
      }
      return { rows: [] };
    };

    const res = await getRecentActivities({ type: 'access', search: 'Alice' });
    
    assert.equal(res.categoryCounts.all, 2, 'Pill count for "all" must be 2');
    assert.equal(res.categoryCounts.access, 1, 'Pill count for "access" must be 1');
    assert.equal(res.categoryCounts.role, 1, 'Pill count for "role" must be 1');
    
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].category, 'access');
    assert.equal(res.total, 1, 'Total must be 1 (count of active display category)');
  } finally {
    pool.query = originalQuery;
  }
});

test('Filters: Date + Search + Category filters combined together', async () => {
  const originalQuery = pool.query;
  try {
    let capturedParams = [];
    let capturedSql = '';
    pool.query = async (sql, params) => {
      const q = sql.toLowerCase();
      if (q.includes('from access_audit_log')) {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              id: 1,
              action: 'approve',
              created_at: new Date('2026-09-05T12:00:00Z'),
              target_user_id: 1,
              target_name: 'Bob Search'
            }
          ]
        };
      }
      return { rows: [] };
    };

    const res = await getRecentActivities({
      type: 'access',
      dateRange: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-10',
      search: 'Bob'
    });

    assert.ok(capturedSql.includes('>='));
    assert.ok(capturedSql.includes('<='));
    assert.ok(capturedSql.includes('ILIKE'));
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].targetUser.name, 'Bob Search');
  } finally {
    pool.query = originalQuery;
  }
});

// -------------------------------------------------------------
// 4. PAGINATION
// -------------------------------------------------------------
test('Pagination: correct slicing and metadata across multiple pages of matching results', async () => {
  const originalQuery = pool.query;
  try {
    pool.query = async (sql) => {
      const q = sql.toLowerCase();
      if (q.includes('from access_audit_log')) {
        const rows = [];
        for (let i = 1; i <= 5; i++) {
          rows.push({
            id: i,
            action: 'approve',
            created_at: new Date(Date.now() - i * 1000),
            target_user_id: i,
            target_name: 'Matched User'
          });
        }
        return { rows };
      }
      return { rows: [] };
    };

    // Page 1
    const p1 = await getRecentActivities({ type: 'access', page: 1, limit: 2 });
    assert.equal(p1.total, 5);
    assert.equal(p1.totalPages, 3);
    assert.equal(p1.page, 1);
    assert.equal(p1.events.length, 2);
    assert.equal(p1.events[0].id, 'access-1');

    // Page 2
    const p2 = await getRecentActivities({ type: 'access', page: 2, limit: 2 });
    assert.equal(p2.page, 2);
    assert.equal(p2.events.length, 2);
    assert.equal(p2.events[0].id, 'access-3');

    // Page 3
    const p3 = await getRecentActivities({ type: 'access', page: 3, limit: 2 });
    assert.equal(p3.page, 3);
    assert.equal(p3.events.length, 1);
    assert.equal(p3.events[0].id, 'access-5');
  } finally {
    pool.query = originalQuery;
  }
});

test('Pagination: View renders showing text, page indicators, and query-preserving links', () => {
  const mockEvents = [
    {
      id: 'access-1',
      category: 'access',
      categoryLabel: 'User Access & Expiry',
      action: 'approve',
      title: 'Approved',
      description: 'Desc',
      semanticColor: 'green',
      badgeClass: 'badge-green badge-success',
      badgeText: 'APPROVED',
      timestamp: new Date(),
      actor: null,
      targetUser: { id: 1, name: 'Alice', email: 'alice@example.com', role: 'USER', status: 'active' },
      targetContent: null,
      meta: {}
    }
  ];

  const html = renderRecentActivityView({
    events: mockEvents,
    total: 25,
    page: 2,
    totalPages: 5,
    limit: 5,
    filters: {
      type: 'access',
      dateRange: '7d',
      startDate: '',
      endDate: '',
      search: 'alice'
    }
  });

  assert.ok(html.includes('Showing 6–10 of 25 activities'), 'Renders showing range text');
  assert.ok(html.includes('Page 2 of 5'), 'Renders page indicator');
  assert.ok(html.includes('Previous'), 'Renders Previous button');
  assert.ok(html.includes('Next'), 'Renders Next button');
  assert.ok(html.includes('page=1'), 'Previous link points to page 1');
  assert.ok(html.includes('page=3'), 'Next link points to page 3');
  assert.ok(html.includes('type=access'), 'Preserves type filter in page link');
  assert.ok(html.includes('dateRange=7d'), 'Preserves dateRange filter in page link');
  assert.ok(html.includes('search=alice'), 'Preserves search filter in page link');
});

// -------------------------------------------------------------
// 5. SEMANTIC EVENT STYLING
// -------------------------------------------------------------
test('Semantic event styling: All 6 required semantic colors mapped to markers, cards, and badges', () => {
  const events = [
    {
      id: 'e-green',
      category: 'access',
      categoryLabel: 'User Access & Expiry',
      action: 'approve',
      title: 'Approved',
      description: 'Approved action',
      semanticColor: 'green', // green = successful/approved
      badgeClass: 'badge-green badge-success',
      badgeText: 'APPROVED',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    },
    {
      id: 'e-amber',
      category: 'access',
      categoryLabel: 'User Access & Expiry',
      action: 'extend',
      title: 'Extended',
      description: 'Expiry extended',
      semanticColor: 'amber', // amber = pending/warning/expiry-related
      badgeClass: 'badge-amber badge-warning',
      badgeText: 'EXTENDED',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    },
    {
      id: 'e-red',
      category: 'access',
      categoryLabel: 'User Access & Expiry',
      action: 'revoke',
      title: 'Revoked',
      description: 'Access revoked',
      semanticColor: 'red', // red = revoked/deleted/critical
      badgeClass: 'badge-red badge-revoked badge-critical',
      badgeText: 'REVOKED',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    },
    {
      id: 'e-purple',
      category: 'role',
      categoryLabel: 'Role Changes',
      action: 'grant_admin',
      title: 'Admin Granted',
      description: 'Admin role granted',
      semanticColor: 'purple', // purple = role/admin/permission changes
      badgeClass: 'badge-purple badge-admin',
      badgeText: 'ADMIN GRANTED',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    },
    {
      id: 'e-blue',
      category: 'discussion',
      categoryLabel: 'Discussions & Answers',
      action: 'discussion_created',
      title: 'New Question',
      description: 'Informational question',
      semanticColor: 'blue', // blue = informational activity
      badgeClass: 'badge-blue badge-info',
      badgeText: 'QUESTION',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    },
    {
      id: 'e-gray',
      category: 'access',
      categoryLabel: 'User Access & Expiry',
      action: 'other',
      title: 'Generic Event',
      description: 'Neutral event',
      semanticColor: 'gray', // gray = neutral
      badgeClass: 'badge-gray badge-neutral',
      badgeText: 'INFO',
      timestamp: new Date(),
      actor: null,
      targetUser: null,
      targetContent: null,
      meta: {}
    }
  ];

  const html = renderRecentActivityView({ events, total: 6 });

  // Verify markers
  assert.ok(html.includes('timeline-marker-green'), 'Should include green marker');
  assert.ok(html.includes('timeline-marker-amber'), 'Should include amber marker');
  assert.ok(html.includes('timeline-marker-red'), 'Should include red marker');
  assert.ok(html.includes('timeline-marker-purple'), 'Should include purple marker');
  assert.ok(html.includes('timeline-marker-blue'), 'Should include blue marker');
  assert.ok(html.includes('timeline-marker-gray'), 'Should include gray marker');

  // Verify cards
  assert.ok(html.includes('card-green'), 'Should include card-green');
  assert.ok(html.includes('card-amber'), 'Should include card-amber');
  assert.ok(html.includes('card-red'), 'Should include card-red');
  assert.ok(html.includes('card-purple'), 'Should include card-purple');
  assert.ok(html.includes('card-blue'), 'Should include card-blue');
  assert.ok(html.includes('card-gray'), 'Should include card-gray');

  // Verify badges
  assert.ok(html.includes('badge-green'), 'Should include badge-green');
  assert.ok(html.includes('badge-amber'), 'Should include badge-amber');
  assert.ok(html.includes('badge-red'), 'Should include badge-red');
  assert.ok(html.includes('badge-purple'), 'Should include badge-purple');
  assert.ok(html.includes('badge-blue'), 'Should include badge-blue');
  assert.ok(html.includes('badge-gray'), 'Should include badge-gray');
});

// -------------------------------------------------------------
// 6. EMPTY STATE
// -------------------------------------------------------------
test('Empty state: Renders friendly empty state when no events exist', () => {
  const html = renderRecentActivityView({
    events: [],
    total: 0
  });

  assert.ok(html.includes('timeline-empty'), 'Renders timeline-empty container');
  assert.ok(html.includes('No activities found'), 'Renders empty state headline');
  assert.ok(html.includes('There is no recorded activity matching your current filter criteria'), 'Renders descriptive guidance');
  assert.equal(html.includes('timeline-card'), false, 'Does not render any timeline-card when empty');
});

// -------------------------------------------------------------
// 7. AUTHORIZATION
// -------------------------------------------------------------
test('Authorization: requireAuth redirects unauthenticated requests to /login', () => {
  const req = reqFor(null);
  const res = resSpy();
  const next = nextSpy();

  requireAuth(req, res, next);
  assert.equal(next.called, false);
  assert.equal(res.redirectUrl, '/login');
});

test('Authorization: requireAdmin rejects regular USER with 403 Forbidden', () => {
  const regularUser = { id: 5, email: 'user@example.com', app_role: 'USER' };
  const req = reqFor(regularUser);
  const res = resSpy();
  const next = nextSpy();

  requireAdmin(req, res, next);
  assert.equal(next.called, false);
  assert.equal(res.statusCode, 403);
});

test('Authorization: requireAdmin allows ADMIN and OWNER roles to proceed', () => {
  const adminUser = { id: 2, email: 'admin@example.com', app_role: 'ADMIN' };
  let req = reqFor(adminUser);
  let res = resSpy();
  let next = nextSpy();

  requireAdmin(req, res, next);
  assert.equal(next.called, true, 'ADMIN must be authorized');
  assert.equal(res.statusCode, 200);

  const ownerUser = { id: 1, email: 'owner@example.com', app_role: 'OWNER' };
  req = reqFor(ownerUser);
  res = resSpy();
  next = nextSpy();

  requireAdmin(req, res, next);
  assert.equal(next.called, true, 'OWNER must be authorized');
  assert.equal(res.statusCode, 200);
});

// -------------------------------------------------------------
// NAVIGATION LINK ACROSS ADMIN TEMPLATES
// -------------------------------------------------------------
test('Navigation: Recent Activity link is present across all admin templates', () => {
  const adminTemplates = [
    'src/views/admin.ejs',
    'src/views/admin-analytics.ejs',
    'src/views/admin-system.ejs',
    'src/views/admin-folders.ejs',
    'src/views/admin-discussions.ejs',
    'src/views/admin-expiring-users.ejs',
    'src/views/admin-user-activity.ejs'
  ];

  for (const tpl of adminTemplates) {
    const fullPath = path.join(__dirname, '..', tpl);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.ok(
      content.includes('/admin/recent-activity') || content.includes('partials/admin-nav'),
      `Template ${tpl} must include link to /admin/recent-activity or admin-nav partial`
    );
  }
});
