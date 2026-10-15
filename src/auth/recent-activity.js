import { pool } from '../db/pool.js';

export const ACTIVITY_CATEGORIES = {
  all: 'All Activities',
  access: 'User Access & Expiry',
  role: 'Role Changes',
  permission: 'Content Permissions',
  moderation: 'Moderation Actions',
  registration: 'User Registrations',
  discussion: 'Discussions & Answers'
};

export const DATE_RANGES = {
  all: 'All Time',
  today: 'Past 24 Hours',
  '7d': 'Past 7 Days',
  '30d': 'Past 30 Days',
  custom: 'Custom Range'
};

/**
 * Fetch and aggregate recent activities from existing tables.
 * Uses ONLY existing tables: access_audit_log, role_audit_log, content_permission_audit_log,
 * discussion_moderation_actions, users, discussions, discussion_replies.
 */
export async function getRecentActivities({
  type = 'all',
  dateRange = 'all',
  startDate = null,
  endDate = null,
  search = '',
  limit = 30,
  page = 1
} = {}) {
  let since = null;
  let until = null;

  const now = new Date();
  if (dateRange === 'today') {
    since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  } else if (dateRange === '7d') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (dateRange === '30d') {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (dateRange === 'custom') {
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) since = d;
    }
    if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        until = d;
      }
    }
  }

  // Calculate fetch limit to cover pagination safely or disable limit if any filter is active
  let fetchLimit = null;
  if (dateRange === 'all' && (!search || !search.trim())) {
    // Standard limit if there is absolutely no active search or date filter to keep queries ultra-fast.
    // 5000 is extremely generous and covers up to 150+ pages.
    fetchLimit = 5000;
  }

  // We fetch matching events from all sources to get accurate pill counts and total results.
  const fetchers = [
    fetchAccessAuditEvents(since, until, fetchLimit, search),
    fetchRoleAuditEvents(since, until, fetchLimit, search),
    fetchContentPermissionAuditEvents(since, until, fetchLimit, search),
    fetchModerationEvents(since, until, fetchLimit, search),
    fetchRegistrationEvents(since, until, fetchLimit, search),
    fetchDiscussionEvents(since, until, fetchLimit, search)
  ];

  const results = await Promise.all(fetchers);
  let allEvents = results.flat();

  // Search filtering in-memory as a secondary guarantee (handles minor dynamic text details and ensures 100% correctness)
  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    allEvents = allEvents.filter(ev => {
      return (
        (ev.title && ev.title.toLowerCase().includes(q)) ||
        (ev.description && ev.description.toLowerCase().includes(q)) ||
        (ev.badgeText && ev.badgeText.toLowerCase().includes(q)) ||
        (ev.targetUser?.name && ev.targetUser.name.toLowerCase().includes(q)) ||
        (ev.targetUser?.email && ev.targetUser.email.toLowerCase().includes(q)) ||
        (ev.actor?.name && ev.actor.name.toLowerCase().includes(q)) ||
        (ev.actor?.email && ev.actor.email.toLowerCase().includes(q)) ||
        (ev.targetContent?.title && ev.targetContent.title.toLowerCase().includes(q)) ||
        (ev.targetContent?.path && ev.targetContent.path.toLowerCase().includes(q))
      );
    });
  }

  // Sort chronological descending
  allEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Category counts based on ALL matches (accurate for the active search/date filters)
  const categoryCounts = {
    all: allEvents.length,
    access: 0,
    role: 0,
    permission: 0,
    moderation: 0,
    registration: 0,
    discussion: 0
  };
  for (const ev of allEvents) {
    if (categoryCounts[ev.category] !== undefined) {
      categoryCounts[ev.category]++;
    }
  }

  // Filter list by selected type category if not 'all'
  let displayEvents = allEvents;
  if (type && type !== 'all') {
    displayEvents = allEvents.filter(ev => ev.category === type);
  }

  const total = displayEvents.length;
  const safeLimit = Math.max(1, limit);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const offset = (currentPage - 1) * safeLimit;
  const paginatedEvents = displayEvents.slice(offset, offset + safeLimit);

  return {
    events: paginatedEvents,
    total,
    page: currentPage,
    totalPages,
    limit: safeLimit,
    categoryCounts,
    filters: {
      type,
      dateRange,
      startDate: startDate || '',
      endDate: endDate || '',
      search: search || ''
    }
  };
}

async function fetchAccessAuditEvents(since, until, limit, search) {
  try {
    const where = [];
    const params = [];
    if (since) {
      params.push(since);
      where.push(`a.created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until);
      where.push(`a.created_at <= $${params.length}`);
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where.push(`(
        a.action ILIKE $${params.length}
        OR u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR adm.name ILIKE $${params.length}
        OR adm.email ILIKE $${params.length}
      )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let sql = `
      SELECT
        a.id, a.action, a.previous_status, a.new_status,
        a.previous_expires_at, a.new_expires_at, a.created_at,
        u.id AS target_user_id, u.name AS target_name, COALESCE(u.email, a.target_email) AS target_email,
        u.app_role AS target_role, u.status AS target_status,
        adm.id AS actor_id, adm.name AS actor_name, adm.email AS actor_email, adm.app_role AS actor_role
      FROM access_audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN users adm ON adm.id = a.admin_user_id
      ${whereClause}
      ORDER BY a.created_at DESC
    `;

    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await pool.query(sql, params);
    return res.rows.map(r => {
      const act = (r.action || '').toLowerCase();
      let semanticColor = 'gray';
      let badgeClass = 'badge-gray badge-neutral';
      let badgeText = (r.action || '').toUpperCase();
      let title = 'Access Change';
      let description = '';

      const targetLabel = r.target_name ? `${r.target_name} (${r.target_email || 'user'})` : (r.target_email || 'User');
      const newExpiryStr = r.new_expires_at ? new Date(r.new_expires_at).toLocaleDateString() : 'no expiration';
      const prevExpiryStr = r.previous_expires_at ? new Date(r.previous_expires_at).toLocaleDateString() : 'none';

      if (act === 'approve') {
        semanticColor = 'green';
        badgeClass = 'badge-green badge-success';
        badgeText = 'APPROVED';
        title = 'User Access Approved';
        description = `Access approved for ${targetLabel} until ${newExpiryStr}.`;
      } else if (act === 'extend') {
        semanticColor = 'amber';
        badgeClass = 'badge-amber badge-warning';
        badgeText = 'EXTENDED';
        title = 'Access Extended';
        description = `Access extended to ${newExpiryStr} (previously ${prevExpiryStr}) for ${targetLabel}.`;
      } else if (act === 'revoke') {
        semanticColor = 'red';
        badgeClass = 'badge-red badge-revoked badge-critical';
        badgeText = 'REVOKED';
        title = 'Access Revoked';
        description = `Access revoked for ${targetLabel} (${r.previous_status || 'active'} → revoked).`;
      } else if (act === 'reactivate') {
        semanticColor = 'green';
        badgeClass = 'badge-green badge-success';
        badgeText = 'REACTIVATED';
        title = 'User Reactivated';
        description = `Access reactivated for ${targetLabel} (${r.previous_status || 'revoked'} → active).`;
      } else if (act === 'register') {
        semanticColor = 'blue';
        badgeClass = 'badge-blue badge-info';
        badgeText = 'REGISTERED';
        title = 'User Registered';
        description = `New user registered: ${targetLabel}.`;
      } else if (act === 'default_roles_assigned') {
        semanticColor = 'blue';
        badgeClass = 'badge-blue badge-info';
        badgeText = 'DEFAULT ROLES';
        title = 'Default Roles Assigned';
        description = `Default roles assigned to ${targetLabel}.`;
      } else if (act === 'expire') {
        semanticColor = 'amber';
        badgeClass = 'badge-amber badge-warning';
        badgeText = 'EXPIRED';
        title = 'User Access Expired';
        description = `Access expired for ${targetLabel}.`;
      } else if (act === 'delete') {
        semanticColor = 'red';
        badgeClass = 'badge-red badge-critical';
        badgeText = 'DELETED';
        title = 'User Deleted';
        description = `User account deleted: ${targetLabel}.`;
      } else {
        description = `Access updated (${act}) for ${targetLabel}.`;
      }

      return {
        id: `access-${r.id}`,
        category: 'access',
        categoryLabel: 'User Access & Expiry',
        action: r.action,
        title,
        description,
        semanticColor,
        badgeClass,
        badgeText,
        timestamp: new Date(r.created_at),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role } : null,
        targetUser: { id: r.target_user_id, name: r.target_name, email: r.target_email, role: r.target_role, status: r.target_status },
        targetContent: null,
        meta: {
          previousStatus: r.previous_status,
          newStatus: r.new_status,
          previousExpiresAt: r.previous_expires_at,
          newExpiresAt: r.new_expires_at,
          statusChange: r.previous_status && r.new_status ? `${r.previous_status} → ${r.new_status}` : null,
          expiryChange: r.new_expires_at ? `Until ${newExpiryStr}` : null
        }
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchRoleAuditEvents(since, until, limit, search) {
  try {
    const where = [];
    const params = [];
    if (since) {
      params.push(since);
      where.push(`r.created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until);
      where.push(`r.created_at <= $${params.length}`);
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where.push(`(
        r.action ILIKE $${params.length}
        OR r.previous_role ILIKE $${params.length}
        OR r.new_role ILIKE $${params.length}
        OR u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR act.name ILIKE $${params.length}
        OR act.email ILIKE $${params.length}
      )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let sql = `
      SELECT
        r.id, r.action, r.previous_role, r.new_role, r.created_at,
        u.id AS target_user_id, u.name AS target_name, u.email AS target_email,
        u.app_role AS target_role, u.status AS target_status,
        act.id AS actor_id, act.name AS actor_name, act.email AS actor_email, act.app_role AS actor_role
      FROM role_audit_log r
      LEFT JOIN users u ON u.id = r.target_user_id
      LEFT JOIN users act ON act.id = r.actor_user_id
      ${whereClause}
      ORDER BY r.created_at DESC
    `;

    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await pool.query(sql, params);
    return res.rows.map(r => {
      const act = (r.action || '').toLowerCase();
      const targetLabel = r.target_name ? `${r.target_name} (${r.target_email || 'user'})` : (r.target_email || 'User');
      const semanticColor = 'purple';
      let badgeClass = 'badge-purple badge-admin';
      let badgeText = (r.action || '').toUpperCase();
      let title = 'Role Change';
      let description = '';

      if (act === 'grant_admin') {
        badgeClass = 'badge-purple badge-admin';
        badgeText = 'ADMIN GRANTED';
        title = 'Admin Role Granted';
        description = `Granted ADMIN role to ${targetLabel} (${r.previous_role || 'USER'} → ${r.new_role || 'ADMIN'}).`;
      } else if (act === 'revoke_admin') {
        badgeClass = 'badge-purple badge-admin';
        badgeText = 'ADMIN REVOKED';
        title = 'Admin Role Revoked';
        description = `Removed ADMIN role from ${targetLabel} (${r.previous_role || 'ADMIN'} → ${r.new_role || 'USER'}).`;
      } else {
        badgeClass = 'badge-purple';
        badgeText = (r.new_role || 'ROLE').toUpperCase();
        description = `Role changed for ${targetLabel}: ${r.previous_role || 'none'} → ${r.new_role}.`;
      }

      return {
        id: `role-${r.id}`,
        category: 'role',
        categoryLabel: 'Role Changes',
        action: r.action,
        title,
        description,
        semanticColor,
        badgeClass,
        badgeText,
        timestamp: new Date(r.created_at),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role } : null,
        targetUser: { id: r.target_user_id, name: r.target_name, email: r.target_email, role: r.target_role, status: r.target_status },
        targetContent: null,
        meta: {
          previousRole: r.previous_role,
          newRole: r.new_role,
          roleChange: `${r.previous_role || 'none'} → ${r.new_role}`
        }
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchContentPermissionAuditEvents(since, until, limit, search) {
  try {
    const where = [];
    const params = [];
    if (since) {
      params.push(since);
      where.push(`c.created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until);
      where.push(`c.created_at <= $${params.length}`);
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where.push(`(
        c.action ILIKE $${params.length}
        OR c.permission ILIKE $${params.length}
        OR u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR act.name ILIKE $${params.length}
        OR act.email ILIKE $${params.length}
      )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let sql = `
      SELECT
        c.id, c.action, c.permission, c.created_at,
        u.id AS target_user_id, u.name AS target_name, u.email AS target_email,
        u.app_role AS target_role, u.status AS target_status,
        act.id AS actor_id, act.name AS actor_name, act.email AS actor_email, act.app_role AS actor_role
      FROM content_permission_audit_log c
      LEFT JOIN users u ON u.id = c.target_user_id
      LEFT JOIN users act ON act.id = c.actor_user_id
      ${whereClause}
      ORDER BY c.created_at DESC
    `;

    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await pool.query(sql, params);
    return res.rows.map(r => {
      const act = (r.action || '').toUpperCase();
      const permName = r.permission === 'COPY_QUERY' ? 'Copy Query' : r.permission === 'DOWNLOAD_PDF' ? 'Download PDF' : r.permission;
      const targetLabel = r.target_name ? `${r.target_name} (${r.target_email || 'user'})` : (r.target_email || 'User');
      const isGrant = act === 'GRANT';

      const semanticColor = 'purple';
      return {
        id: `perm-${r.id}`,
        category: 'permission',
        categoryLabel: 'Content Permissions',
        action: r.action,
        title: `Permission ${isGrant ? 'Granted' : 'Revoked'}: ${permName}`,
        description: `${isGrant ? 'Granted' : 'Revoked'} ${permName} permission for ${targetLabel}.`,
        semanticColor,
        badgeClass: 'badge-purple',
        badgeText: `${act}: ${r.permission}`,
        timestamp: new Date(r.created_at),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role } : null,
        targetUser: { id: r.target_user_id, name: r.target_name, email: r.target_email, role: r.target_role, status: r.target_status },
        targetContent: null,
        meta: {
          permission: r.permission,
          permissionName: permName,
          action: r.action
        }
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchModerationEvents(since, until, limit, search) {
  try {
    const where = [];
    const params = [];
    if (since) {
      params.push(since);
      where.push(`m.created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until);
      where.push(`m.created_at <= $${params.length}`);
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where.push(`(
        m.action ILIKE $${params.length}
        OR m.target_type ILIKE $${params.length}
        OR act.name ILIKE $${params.length}
        OR act.email ILIKE $${params.length}
        OR d.title ILIKE $${params.length}
        OR dr_d.title ILIKE $${params.length}
        OR d.item_path ILIKE $${params.length}
        OR dr_d.item_path ILIKE $${params.length}
      )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let sql = `
      SELECT
        m.id, m.target_type, m.target_id, m.action, m.created_at,
        act.id AS actor_id, act.name AS actor_name, act.email AS actor_email, act.app_role AS actor_role,
        COALESCE(d.title, dr_d.title) AS discussion_title,
        COALESCE(d.item_path, dr_d.item_path) AS item_path,
        COALESCE(d.id, dr.discussion_id) AS discussion_id
      FROM discussion_moderation_actions m
      LEFT JOIN users act ON act.id = m.actor_user_id
      LEFT JOIN discussions d ON (m.target_type = 'question' AND d.id = m.target_id)
      LEFT JOIN discussion_replies dr ON (m.target_type = 'reply' AND dr.id = m.target_id)
      LEFT JOIN discussions dr_d ON (m.target_type = 'reply' AND dr_d.id = dr.discussion_id)
      ${whereClause}
      ORDER BY m.created_at DESC
    `;

    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await pool.query(sql, params);
    return res.rows.map(r => {
      const act = (r.action || '').toLowerCase();
      const targetTypeLabel = r.target_type === 'question' ? 'Question' : 'Reply';
      let semanticColor = 'gray';
      let badgeClass = 'badge-gray badge-neutral';
      let badgeText = (r.action || '').toUpperCase();

      if (act === 'hide') {
        semanticColor = 'amber';
        badgeClass = 'badge-amber badge-warning badge-hidden';
        badgeText = 'HIDDEN';
      } else if (act === 'unhide') {
        semanticColor = 'green';
        badgeClass = 'badge-green badge-success';
        badgeText = 'UNHIDDEN';
      } else if (act === 'delete') {
        semanticColor = 'red';
        badgeClass = 'badge-red badge-deleted badge-critical';
        badgeText = 'DELETED';
      } else if (act === 'restore') {
        semanticColor = 'green';
        badgeClass = 'badge-green badge-success';
        badgeText = 'RESTORED';
      }

      const contentDesc = r.discussion_title ? `"${r.discussion_title}"` : `${targetTypeLabel} #${r.target_id}`;

      return {
        id: `mod-${r.id}`,
        category: 'moderation',
        categoryLabel: 'Moderation Actions',
        action: r.action,
        title: `${targetTypeLabel} ${badgeText.charAt(0) + badgeText.slice(1).toLowerCase()}`,
        description: `${targetTypeLabel} ${contentDesc} was ${act === 'delete' ? 'deleted' : act + 'd'} by moderator.`,
        semanticColor,
        badgeClass,
        badgeText,
        timestamp: new Date(r.created_at),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role } : null,
        targetUser: null,
        targetContent: {
          type: r.target_type,
          id: r.target_id,
          title: r.discussion_title,
          path: r.item_path,
          discussionId: r.discussion_id
        },
        meta: {
          targetType: r.target_type,
          targetId: r.target_id
        }
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchRegistrationEvents(since, until, limit, search) {
  try {
    const where = [];
    const params = [];
    if (since) {
      params.push(since);
      where.push(`u.created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until);
      where.push(`u.created_at <= $${params.length}`);
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where.push(`(
        u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR u.status ILIKE $${params.length}
        OR u.app_role ILIKE $${params.length}
      )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let sql = `
      SELECT
        u.id, u.name, u.email, u.status, u.app_role, u.created_at
      FROM users u
      ${whereClause}
      ORDER BY u.created_at DESC
    `;

    if (limit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await pool.query(sql, params);
    return res.rows.map(r => {
      const isPending = r.status === 'pending';
      const isRevoked = r.status === 'revoked';
      let semanticColor = 'blue';
      let badgeClass = 'badge-blue badge-info';
      let badgeText = 'REGISTERED';

      if (isPending) {
        semanticColor = 'amber';
        badgeClass = 'badge-amber badge-pending';
        badgeText = 'PENDING REGISTRATION';
      } else if (isRevoked) {
        semanticColor = 'red';
        badgeClass = 'badge-red badge-revoked';
        badgeText = 'REGISTRATION REVOKED';
      }

      return {
        id: `reg-${r.id}`,
        category: 'registration',
        categoryLabel: 'User Registrations',
        action: 'registered',
        title: isPending ? 'Pending User Registration' : 'New User Registered',
        description: `Account created for ${r.name || r.email || 'New user'} with initial status ${r.status}.`,
        semanticColor,
        badgeClass,
        badgeText,
        timestamp: new Date(r.created_at),
        actor: null,
        targetUser: {
          id: r.id,
          name: r.name,
          email: r.email,
          role: r.app_role,
          status: r.status
        },
        targetContent: null,
        meta: {
          status: r.status,
          role: r.app_role
        }
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchDiscussionEvents(since, until, limit, search) {
  try {
    const events = [];

    // Questions created
    const dWhere = [];
    const dParams = [];
    if (since) {
      dParams.push(since);
      dWhere.push(`d.created_at >= $${dParams.length}`);
    }
    if (until) {
      dParams.push(until);
      dWhere.push(`d.created_at <= $${dParams.length}`);
    }
    if (search && search.trim()) {
      dParams.push(`%${search.trim()}%`);
      dWhere.push(`(
        d.title ILIKE $${dParams.length}
        OR d.item_path ILIKE $${dParams.length}
        OR d.status ILIKE $${dParams.length}
        OR u.name ILIKE $${dParams.length}
        OR u.email ILIKE $${dParams.length}
      )`);
    }
    const dWhereClause = dWhere.length ? `WHERE ${dWhere.join(' AND ')}` : '';

    let dSql = `
      SELECT
        d.id, d.title, d.item_path, d.status, d.created_at,
        u.id AS author_id, u.name AS author_name, u.email AS author_email, u.app_role AS author_role
      FROM discussions d
      LEFT JOIN users u ON u.id = d.user_id
      ${dWhereClause}
      ORDER BY d.created_at DESC
    `;

    if (limit) {
      dParams.push(limit);
      dSql += ` LIMIT $${dParams.length}`;
    }

    const dRes = await pool.query(dSql, dParams);
    for (const r of dRes.rows) {
      events.push({
        id: `disc-${r.id}`,
        category: 'discussion',
        categoryLabel: 'Discussions & Answers',
        action: 'discussion_created',
        title: 'New Discussion Question',
        description: `Question "${r.title}" posted on ${r.item_path || 'content'}.`,
        semanticColor: 'blue',
        badgeClass: 'badge-blue badge-info',
        badgeText: 'QUESTION',
        timestamp: new Date(r.created_at),
        actor: r.author_id ? { id: r.author_id, name: r.author_name, email: r.author_email, role: r.author_role } : null,
        targetUser: null,
        targetContent: {
          type: 'question',
          id: r.id,
          title: r.title,
          path: r.item_path,
          discussionId: r.id
        },
        meta: {
          status: r.status
        }
      });
    }

    // Accepted answers
    const aWhere = ['dr.accepted_at IS NOT NULL'];
    const aParams = [];
    if (since) {
      aParams.push(since);
      aWhere.push(`dr.accepted_at >= $${aParams.length}`);
    }
    if (until) {
      aParams.push(until);
      aWhere.push(`dr.accepted_at <= $${aParams.length}`);
    }
    if (search && search.trim()) {
      aParams.push(`%${search.trim()}%`);
      aWhere.push(`(
        u.name ILIKE $${aParams.length}
        OR u.email ILIKE $${aParams.length}
        OR d.title ILIKE $${aParams.length}
        OR d.item_path ILIKE $${aParams.length}
      )`);
    }
    const aWhereClause = `WHERE ${aWhere.join(' AND ')}`;

    let aSql = `
      SELECT
        dr.id, dr.discussion_id, dr.accepted_at,
        u.id AS author_id, u.name AS author_name, u.email AS author_email, u.app_role AS author_role,
        d.title AS discussion_title, d.item_path
      FROM discussion_replies dr
      JOIN discussions d ON d.id = dr.discussion_id
      LEFT JOIN users u ON u.id = dr.user_id
      ${aWhereClause}
      ORDER BY dr.accepted_at DESC
    `;

    if (limit) {
      aParams.push(limit);
      aSql += ` LIMIT $${aParams.length}`;
    }

    const aRes = await pool.query(aSql, aParams);
    for (const r of aRes.rows) {
      events.push({
        id: `ans-${r.id}`,
        category: 'discussion',
        categoryLabel: 'Discussions & Answers',
        action: 'answer_accepted',
        title: 'Solution / Answer Accepted',
        description: `An answer on "${r.discussion_title || 'discussion'}" was marked as accepted.`,
        semanticColor: 'green',
        badgeClass: 'badge-green badge-success',
        badgeText: 'ANSWER ACCEPTED',
        timestamp: new Date(r.accepted_at),
        actor: r.author_id ? { id: r.author_id, name: r.author_name, email: r.author_email, role: r.author_role } : null,
        targetUser: null,
        targetContent: {
          type: 'reply',
          id: r.id,
          title: r.discussion_title,
          path: r.item_path,
          discussionId: r.discussion_id
        },
        meta: {
          replyId: r.id,
          discussionId: r.discussion_id
        }
      });
    }

    return events;
  } catch (err) {
    return [];
  }
}
