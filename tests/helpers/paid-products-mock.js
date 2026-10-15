import { ROLES } from '../../src/auth/admin.js';

export function createMockDb() {
  let roles = [
    { id: 1, name: 'USER' },
    { id: 2, name: 'PREMIUM' },
    { id: 3, name: 'ADMIN' },
    { id: 4, name: 'OWNER' },
    { id: 10, name: 'COURSE_JAVA' }
  ];

  let users = [
    { id: 1, email: 'owner@example.com', app_role: ROLES.OWNER },
    { id: 2, email: 'admin@example.com', app_role: ROLES.ADMIN },
    { id: 10, email: 'user10@example.com', app_role: ROLES.USER },
    { id: 11, email: 'user11@example.com', app_role: ROLES.USER },
    { id: 12, email: 'user12@example.com', app_role: ROLES.USER },
    { id: 13, email: 'user13@example.com', app_role: ROLES.USER },
    { id: 14, email: 'user14@example.com', app_role: ROLES.USER },
    { id: 15, email: 'user15@example.com', app_role: ROLES.USER },
    { id: 20, email: 'user20@example.com', app_role: ROLES.USER },
    { id: 25, email: 'user25@example.com', app_role: ROLES.USER }
  ];

  let paid_products = [
    { id: 100, code: 'PREMIUM', name: 'Premium Membership', role_id: 2, is_enabled: true },
    { id: 200, code: 'JAVA_PRO', name: 'Java Masterclass', role_id: 10, is_enabled: true },
    { id: 300, code: 'ARCHIVED', name: 'Archived Course', role_id: 10, is_enabled: false }
  ];

  let user_roles = [];
  let user_product_grants = [];
  let paid_subscriptions = [];
  let paid_orders = [];
  let paid_product_events = [];
  let nextGrantId = 1;
  let nextEventId = 1;
  let reconciliation_runs = [];
  let nextReconId = 1;

  const mockClient = {
    query: async (sql, params = []) => {
      // Reconciliation run status handling (persistent status for manual & scheduled)
      if (/reconciliation_runs/i.test(sql)) {
        if (/INSERT INTO reconciliation_runs/i.test(sql)) {
          const src = params[0];
          const row = { id: nextReconId++, trigger_source: src, status: 'running', started_at: new Date(), completed_at: null, checked_users: 0, grants_created: 0, grants_revoked: 0, grants_expired: 0, subscriptions_expired: 0, users_expired: 0, roles_granted: 0, roles_revoked: 0, error_message: null, payload: {}, created_at: new Date(), updated_at: new Date() };
          reconciliation_runs.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/UPDATE reconciliation_runs/i.test(sql) && /status = 'completed'/i.test(sql)) {
          const id = Number(params[0]);
          const row = reconciliation_runs.find(r => r.id === id);
          if (row) {
            row.status = 'completed';
            row.completed_at = new Date();
            row.checked_users = Number(params[1]||0);
            row.grants_created = Number(params[2]||0);
            row.grants_revoked = Number(params[3]||0);
            row.grants_expired = Number(params[4]||0);
            row.subscriptions_expired = Number(params[5]||0);
            row.users_expired = Number(params[6]||0);
            row.roles_granted = Number(params[7]||0);
            row.roles_revoked = Number(params[8]||0);
            try { row.payload = JSON.parse(params[9]); } catch { row.payload = params[9]; }
            row.updated_at = new Date();
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/UPDATE reconciliation_runs/i.test(sql) && /status = 'failed'/i.test(sql)) {
          const id = Number(params[0]);
          const row = reconciliation_runs.find(r => r.id === id);
          if (row) {
            row.status = 'failed';
            row.completed_at = new Date();
            row.error_message = params[1];
            row.updated_at = new Date();
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/SELECT \* FROM reconciliation_runs/i.test(sql)) {
          if (/WHERE status IN/i.test(sql)) {
            const rows = reconciliation_runs.filter(r => r.status === 'completed' || r.status === 'failed').sort((a,b)=> new Date(b.started_at)-new Date(a.started_at));
            return { rows: rows.slice(0,1), rowCount: Math.min(rows.length,1) };
          }
          if (/WHERE status = 'running'/i.test(sql)) {
            const rows = reconciliation_runs.filter(r => r.status === 'running');
            return { rows, rowCount: rows.length };
          }
          const sorted = [...reconciliation_runs].sort((a,b)=> new Date(b.started_at)-new Date(a.started_at));
          return { rows: sorted.slice(0,1), rowCount: Math.min(sorted.length,1) };
        }
        if (/pg_try_advisory_lock|pg_advisory_unlock/i.test(sql)) {
          return { rows: [{ pg_try_advisory_lock: true }], rowCount: 1 };
        }
      }
      if (/pg_try_advisory_lock|pg_advisory_unlock/i.test(sql)) {
        return { rows: [{ pg_try_advisory_lock: true }], rowCount: 1 };
      }
      // 1. Roles
      if (/FROM roles WHERE name =/i.test(sql)) {
        const r = roles.find(x => x.name === params[0]);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/FROM roles WHERE id =/i.test(sql)) {
        const r = roles.find(x => x.id === Number(params[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }

      // 2. Products
      if (/SELECT \* FROM paid_products WHERE is_enabled = true/i.test(sql)) {
        const prods = paid_products.filter(p => p.is_enabled);
        return { rows: prods, rowCount: prods.length };
      }
      if (/FROM paid_products/i.test(sql) && /code = \$1/i.test(sql)) {
        const p = paid_products.find(x => x.code === params[0]);
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || '' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM paid_products/i.test(sql) && /id = \$1/i.test(sql)) {
        const p = paid_products.find(x => x.id === Number(params[0]));
        if (p) {
          const r = roles.find(x => x.id === p.role_id);
          return { rows: [{ ...p, role_name: r?.name || '' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 3. Grants count (dry run)
      if (/SELECT COUNT\(\*\)::int AS cnt FROM user_product_grants/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const matches = user_product_grants.filter(g =>
          g.product_id === prodId &&
          g.status === 'active' &&
          g.valid_until &&
          new Date(g.valid_until).getTime() <= now
        );
        return { rows: [{ cnt: matches.length }], rowCount: 1 };
      }

      // 4. Update expired grants (live)
      if (/UPDATE user_product_grants\s+SET status = 'expired'/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const updated = [];
        for (const g of user_product_grants) {
          if (g.product_id === prodId && g.status === 'active' && g.valid_until && new Date(g.valid_until).getTime() <= now) {
            g.status = 'expired';
            g.updated_at = new Date();
            updated.push(g);
          }
        }
        return { rows: updated, rowCount: updated.length };
      }

      // 5. Active grants lookup
      if (/SELECT \* FROM user_product_grants/i.test(sql) && /status = 'active'/i.test(sql)) {
        const uid = Number(params[0]);
        const pid = Number(params[1]);
        const now = Date.now();
        const active = user_product_grants.filter(g =>
          g.user_id === uid &&
          g.product_id === pid &&
          g.status === 'active' &&
          (!g.valid_until || new Date(g.valid_until).getTime() > now)
        );
        return { rows: active, rowCount: active.length };
      }

      // 6. Subscriptions count (dry run)
      if (/SELECT COUNT\(\*\)::int AS cnt FROM paid_subscriptions/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const matches = paid_subscriptions.filter(s =>
          s.product_id === prodId &&
          s.status === 'active' &&
          s.cancel_at_period_end &&
          s.current_period_end &&
          new Date(s.current_period_end).getTime() <= now
        );
        return { rows: [{ cnt: matches.length }], rowCount: 1 };
      }

      // 7. Update expired subscriptions (live)
      if (/UPDATE paid_subscriptions\s+SET status = 'expired'/i.test(sql)) {
        const prodId = Number(params[0]);
        const now = Date.now();
        const updated = [];
        for (const s of paid_subscriptions) {
          if (s.product_id === prodId && s.status === 'active' && s.cancel_at_period_end && s.current_period_end && new Date(s.current_period_end).getTime() <= now) {
            s.status = 'expired';
            s.updated_at = new Date();
            updated.push(s);
          }
        }
        return { rows: updated, rowCount: updated.length };
      }

      // 8. Active subscriptions lookup
      if (/SELECT \* FROM paid_subscriptions/i.test(sql) && /status = 'active'/i.test(sql)) {
        const uid = Number(params[0]);
        const pid = Number(params[1]);
        const now = Date.now();
        const active = paid_subscriptions.filter(s =>
          s.user_id === uid &&
          s.product_id === pid &&
          s.status === 'active' &&
          (!s.current_period_end || new Date(s.current_period_end).getTime() > now)
        );
        return { rows: active, rowCount: active.length };
      }

      // 9. Candidate users query (reconciliation step 4)
      if (/SELECT DISTINCT u\.id/i.test(sql)) {
        const prodId = Number(params[0]);
        const rId = Number(params[1]);
        const prodCode = params[2];
        const all = !!params[3];

        if (all) {
          return { rows: users, rowCount: users.length };
        }

        const candidateSet = new Set();
        for (const g of user_product_grants) {
          if (g.product_id === prodId) candidateSet.add(g.user_id);
        }
        for (const s of paid_subscriptions) {
          if (s.product_id === prodId) candidateSet.add(s.user_id);
        }
        for (const o of paid_orders) {
          if (o.product_id === prodId) candidateSet.add(o.user_id);
        }
        for (const ur of user_roles) {
          if (ur.role_id === rId) candidateSet.add(ur.user_id);
        }

        const candidates = users.filter(u => candidateSet.has(u.id));
        return { rows: candidates, rowCount: candidates.length };
      }

      // 10. Single user lookup
      if (/FROM users WHERE id = \$1/i.test(sql)) {
        const u = users.find(x => x.id === Number(params[0]));
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // 11. User roles lookup
      if (/SELECT/i.test(sql) && /FROM user_roles/i.test(sql) && /WHERE user_id = \$1/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        return { rows: ur ? [ur] : [], rowCount: ur ? 1 : 0 };
      }

      // 12. Insert or update user_roles
      if (/INSERT INTO user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        let src = params[2];
        if (!src && /'payment_system'/i.test(sql)) {
          src = 'payment_system';
        }
        if (!src) src = 'manual';
        const existing = user_roles.find(x => x.user_id === uid && x.role_id === rid);
        if (existing) {
          existing.assignment_source = src;
        } else {
          user_roles.push({ user_id: uid, role_id: rid, assignment_source: src });
        }
        return { rowCount: 1 };
      }

      // 13. Delete from user_roles
      if (/DELETE FROM user_roles/i.test(sql)) {
        const uid = Number(params[0]);
        const rid = Number(params[1]);
        const src = params[2];
        const idx = user_roles.findIndex(x => x.user_id === uid && x.role_id === rid && (src ? x.assignment_source === src : true));
        if (idx !== -1) {
          user_roles.splice(idx, 1);
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }

      // 14. Audit log in paid_product_events
      if (/INSERT INTO paid_product_events/i.test(sql)) {
        const evt = {
          id: nextEventId++,
          product_id: params[0],
          user_id: params[1],
          event_type: params[2],
          provider_event_id: params[3],
          previous_status: params[4],
          new_status: params[5],
          message: params[6],
          payload: params[7],
          created_at: new Date()
        };
        paid_product_events.push(evt);
        return { rows: [evt], rowCount: 1 };
      }

      // Default empty
      return { rows: [], rowCount: 0 };
    }
  };

  return {
    query: mockClient.query,
    addUser: (u) => { users.push(u); return u; },
    addGrant: (g) => {
      const row = { id: nextGrantId++, ...g };
      user_product_grants.push(row);
      return row;
    },
    addSubscription: (s) => {
      paid_subscriptions.push(s);
      return s;
    },
    addRole: (r) => {
      user_roles.push(r);
      return r;
    },
    hasRole: (uid, rid) => user_roles.some(x => x.user_id === uid && x.role_id === rid),
    getRole: (uid, rid) => user_roles.find(x => x.user_id === uid && x.role_id === rid) || null,
    getRoleAssignmentSource: (uid, rid) => {
      const ur = user_roles.find(x => x.user_id === uid && x.role_id === rid);
      return ur ? ur.assignment_source : null;
    },
    getUserRoles: () => [...user_roles],
    getGrants: () => [...user_product_grants],
    getSubscriptions: () => [...paid_subscriptions],
    getEvents: () => [...paid_product_events]
  };
}
