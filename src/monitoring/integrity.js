// src/monitoring/integrity.js — System Health & Integrity Diagnostics
// Strictly read-only diagnostics for RBAC, paid products, entitlements, plans, and user roles.
// This module NEVER mutates, revokes, grants, or repairs data.

import { pool } from '../db/pool.js';
import { ROLES } from '../auth/admin.js';
import { validateUserEntitlement } from '../auth/paidProducts.js';

/**
 * 1. Check for payment-managed roles without a valid active entitlement.
 * Looks for user_roles with assignment_source = 'payment_system' where the user
 * has no active entitlement or valid grant for the associated product.
 * OWNER and ADMIN users are excluded (protected).
 */
export async function checkPaymentRolesWithoutEntitlement(client = pool) {
  try {
    const res = await client.query(
      `SELECT ur.user_id, ur.role_id, ur.assignment_source,
              u.email AS user_email, u.app_role,
              r.name AS role_name,
              p.id AS product_id, p.code AS product_code, p.name AS product_name
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN paid_products p ON (p.role_id = r.id OR (p.code = 'PREMIUM' AND UPPER(r.name) = 'PREMIUM'))
       WHERE ur.assignment_source = 'payment_system'
         AND u.app_role NOT IN ('OWNER', 'ADMIN')
       ORDER BY ur.user_id ASC`
    );

    const issues = [];
    for (const row of res.rows) {
      const productId = row.product_id || (row.role_name === 'PREMIUM' ? 'PREMIUM' : null);
      if (!productId) {
        issues.push({
          userId: row.user_id,
          userEmail: row.user_email,
          roleId: row.role_id,
          roleName: row.role_name,
          productCode: row.product_code || 'UNKNOWN',
          details: `Role "${row.role_name}" is assigned with payment_system source, but no paid product maps to role ID ${row.role_id}.`
        });
        continue;
      }

      const entitlement = await validateUserEntitlement(row.user_id, productId, client);
      if (!entitlement || !entitlement.hasEntitlement) {
        issues.push({
          userId: row.user_id,
          userEmail: row.user_email,
          roleId: row.role_id,
          roleName: row.role_name,
          productCode: row.product_code || (row.role_name === 'PREMIUM' ? 'PREMIUM' : 'N/A'),
          details: `Role "${row.role_name}" assigned via payment_system, but user has no active entitlement or valid grant.`
        });
      }
    }

    return {
      id: 'payment_roles_without_entitlement',
      title: 'Payment-Managed Roles Without Active Entitlement',
      category: 'RBAC & Entitlements',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Users assigned payment-managed roles (assignment_source = "payment_system") despite lacking a valid active entitlement.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'payment_roles_without_entitlement',
      title: 'Payment-Managed Roles Without Active Entitlement',
      category: 'RBAC & Entitlements',
      status: 'healthy',
      count: 0,
      description: 'Users assigned payment-managed roles (assignment_source = "payment_system") despite lacking a valid active entitlement.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: [],
      error: err.message
    };
  }
}

/**
 * 2. Check for active paid entitlements missing their corresponding payment-managed role.
 * Looks for users with active grants or subscriptions for enabled paid products
 * where the user does NOT have the product's role_id in user_roles.
 * OWNER and ADMIN users are excluded (protected).
 */
export async function checkActiveEntitlementsMissingRoles(client = pool) {
  try {
    const grantsRes = await client.query(
      `SELECT DISTINCT g.user_id, g.product_id, g.valid_until,
              u.email AS user_email, u.app_role,
              p.code AS product_code, p.name AS product_name, p.role_id,
              r.name AS role_name
       FROM user_product_grants g
       JOIN users u ON u.id = g.user_id
       JOIN paid_products p ON p.id = g.product_id
       JOIN roles r ON r.id = p.role_id
       WHERE g.status = 'active'
         AND (g.valid_until IS NULL OR g.valid_until > NOW())
         AND u.app_role NOT IN ('OWNER', 'ADMIN')
         AND NOT EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = g.user_id AND ur.role_id = p.role_id
         )
       ORDER BY g.user_id ASC`
    );

    const subsRes = await client.query(
      `SELECT DISTINCT s.user_id, s.product_id, s.current_period_end AS valid_until,
              u.email AS user_email, u.app_role,
              p.code AS product_code, p.name AS product_name, p.role_id,
              r.name AS role_name
       FROM paid_subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN paid_products p ON p.id = s.product_id
       JOIN roles r ON r.id = p.role_id
       WHERE s.status IN ('active', 'authenticated')
         AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
         AND u.app_role NOT IN ('OWNER', 'ADMIN')
         AND NOT EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = s.user_id AND ur.role_id = p.role_id
         )
       ORDER BY s.user_id ASC`
    );

    const seen = new Set();
    const issues = [];
    for (const row of [...grantsRes.rows, ...subsRes.rows]) {
      const key = `${row.user_id}_${row.product_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const expiryStr = row.valid_until ? new Date(row.valid_until).toISOString().split('T')[0] : 'ongoing';
      issues.push({
        userId: row.user_id,
        userEmail: row.user_email,
        productId: row.product_id,
        productCode: row.product_code,
        productName: row.product_name,
        roleId: row.role_id,
        roleName: row.role_name,
        validUntil: row.valid_until,
        details: `Active entitlement exists for "${row.product_name}" (${row.product_code}) until ${expiryStr}, but role "${row.role_name}" is missing in user_roles.`
      });
    }

    return {
      id: 'active_entitlements_missing_roles',
      title: 'Active Entitlements Missing Payment-Managed Role',
      category: 'RBAC & Entitlements',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Users with valid active paid entitlements or subscriptions whose corresponding RBAC role is missing from user_roles.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'active_entitlements_missing_roles',
      title: 'Active Entitlements Missing Payment-Managed Role',
      category: 'RBAC & Entitlements',
      status: 'healthy',
      count: 0,
      description: 'Users with valid active paid entitlements or subscriptions whose corresponding RBAC role is missing from user_roles.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: [],
      error: err.message
    };
  }
}

/**
 * 3. Check for expired paid entitlements still retaining payment-managed roles.
 * Looks for users whose grants or subscriptions are expired (status = 'expired' or date in past)
 * who still retain assignment_source = 'payment_system' in user_roles and have no active entitlement.
 * OWNER and ADMIN users are excluded (protected).
 */
export async function checkExpiredEntitlementsRetainingRoles(client = pool) {
  try {
    const res = await client.query(
      `SELECT ur.user_id, ur.role_id,
              u.email AS user_email, u.app_role,
              r.name AS role_name,
              p.id AS product_id, p.code AS product_code, p.name AS product_name
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       JOIN roles r ON r.id = ur.role_id
       JOIN paid_products p ON (p.role_id = r.id OR (p.code = 'PREMIUM' AND UPPER(r.name) = 'PREMIUM'))
       WHERE ur.assignment_source = 'payment_system'
         AND u.app_role NOT IN ('OWNER', 'ADMIN')
         AND (
           EXISTS (
             SELECT 1 FROM user_product_grants g
             WHERE g.user_id = ur.user_id AND g.product_id = p.id
               AND (g.status = 'expired' OR (g.valid_until IS NOT NULL AND g.valid_until <= NOW()))
           )
           OR EXISTS (
             SELECT 1 FROM paid_subscriptions s
             WHERE s.user_id = ur.user_id AND s.product_id = p.id
               AND (s.status = 'expired' OR (s.current_period_end IS NOT NULL AND s.current_period_end <= NOW()))
           )
           OR (p.code = 'PREMIUM' AND EXISTS (
             SELECT 1 FROM premium_subscriptions ps
             WHERE ps.user_id = ur.user_id
               AND (ps.status = 'expired' OR (ps.current_period_end IS NOT NULL AND ps.current_period_end <= NOW()))
           ))
         )
       ORDER BY ur.user_id ASC`
    );

    const issues = [];
    for (const row of res.rows) {
      const entitlement = await validateUserEntitlement(row.user_id, row.product_id, client);
      if (!entitlement || !entitlement.hasEntitlement) {
        issues.push({
          userId: row.user_id,
          userEmail: row.user_email,
          productId: row.product_id,
          productCode: row.product_code,
          roleId: row.role_id,
          roleName: row.role_name,
          details: `Entitlement for "${row.product_name}" (${row.product_code}) expired, but payment role "${row.role_name}" still remains assigned.`
        });
      }
    }

    return {
      id: 'expired_entitlements_retaining_roles',
      title: 'Expired Paid Entitlements Retaining Payment-Managed Roles',
      category: 'RBAC & Entitlements',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Users whose paid access expired but still retain their payment-managed RBAC role (reconciliation pending).',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'expired_entitlements_retaining_roles',
      title: 'Expired Paid Entitlements Retaining Payment-Managed Roles',
      category: 'RBAC & Entitlements',
      status: 'healthy',
      count: 0,
      description: 'Users whose paid access expired but still retain their payment-managed RBAC role (reconciliation pending).',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: [],
      error: err.message
    };
  }
}

/**
 * 4. Check for enabled paid products with no active plan.
 * Enabled products without active plans cannot be purchased by users.
 */
export async function checkEnabledProductsWithoutActivePlans(client = pool) {
  try {
    const res = await client.query(
      `SELECT p.id, p.code, p.name, p.role_id, r.name AS role_name
       FROM paid_products p
       LEFT JOIN roles r ON r.id = p.role_id
       WHERE p.is_enabled = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM paid_product_plans pl
           WHERE pl.product_id = p.id AND pl.is_active = TRUE
         )
       ORDER BY p.id ASC`
    );

    const issues = res.rows.map(row => ({
      productId: row.id,
      productCode: row.code,
      productName: row.name,
      roleName: row.role_name || `ID ${row.role_id}`,
      details: `Product "${row.name}" (${row.code}) is enabled for customers, but has 0 active plans configured.`
    }));

    return {
      id: 'enabled_products_without_plans',
      title: 'Enabled Paid Products With No Active Plan',
      category: 'Paid Products & Plans',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Paid products currently marked enabled that have no active pricing plans available for checkout.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Manage Paid Products',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'enabled_products_without_plans',
      title: 'Enabled Paid Products With No Active Plan',
      category: 'Paid Products & Plans',
      status: 'healthy',
      count: 0,
      description: 'Paid products currently marked enabled that have no active pricing plans available for checkout.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Manage Paid Products',
      items: [],
      error: err.message
    };
  }
}

/**
 * 5. Check for recurring plans missing Razorpay Plan ID.
 * Recurring plans require a Razorpay Plan ID for automated subscription creation.
 */
export async function checkRecurringPlansMissingRazorpayId(client = pool) {
  try {
    const res = await client.query(
      `SELECT pl.id, pl.code AS plan_code, pl.name AS plan_name, pl.is_active, pl.billing_type,
              p.id AS product_id, p.code AS product_code, p.name AS product_name
       FROM paid_product_plans pl
       JOIN paid_products p ON p.id = pl.product_id
       WHERE pl.billing_type = 'recurring'
         AND (pl.razorpay_plan_id IS NULL OR TRIM(pl.razorpay_plan_id) = '')
       ORDER BY pl.id ASC`
    );

    const issues = res.rows.map(row => ({
      planId: row.id,
      planCode: row.plan_code,
      planName: row.plan_name,
      productCode: row.product_code,
      productName: row.product_name,
      isActive: Boolean(row.is_active),
      details: `Recurring plan "${row.plan_name}" (${row.plan_code}) for product "${row.product_name}" is missing a Razorpay Plan ID${row.is_active ? ' (PLAN IS ACTIVE)' : ' (inactive)'}.`
    }));

    const hasActiveMissing = issues.some(i => i.isActive);

    return {
      id: 'recurring_plans_missing_razorpay_id',
      title: 'Recurring Plans Missing Razorpay Plan ID',
      category: 'Paid Products & Plans',
      status: issues.length > 0 ? (hasActiveMissing ? 'critical' : 'warning') : 'healthy',
      count: issues.length,
      description: 'Recurring billing plans lacking a Razorpay Plan ID, preventing subscription checkouts from initiating properly.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Configure Plans',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'recurring_plans_missing_razorpay_id',
      title: 'Recurring Plans Missing Razorpay Plan ID',
      category: 'Paid Products & Plans',
      status: 'healthy',
      count: 0,
      description: 'Recurring billing plans lacking a Razorpay Plan ID, preventing subscription checkouts from initiating properly.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Configure Plans',
      items: [],
      error: err.message
    };
  }
}

/**
 * 6. Check for default roles referencing invalid/inconsistent role configuration.
 * - Role marked default_role = TRUE that is associated with a paid product or PREMIUM
 *   (conflicts with paid access because default roles are granted for free upon activation).
 * - Role marked default_role = TRUE that grants no folder permissions in folder_roles.
 */
export async function checkDefaultRolesInconsistencies(client = pool) {
  try {
    const res = await client.query(
      `SELECT r.id, r.name, r.description, r.default_role, r.ads_available,
              p.id AS paid_product_id, p.code AS paid_product_code, p.name AS paid_product_name,
              COUNT(fr.folder_path)::int AS folder_count
       FROM roles r
       LEFT JOIN paid_products p ON p.role_id = r.id
       LEFT JOIN folder_roles fr ON fr.role_id = r.id
       WHERE r.default_role = TRUE
       GROUP BY r.id, r.name, r.description, r.default_role, r.ads_available, p.id, p.code, p.name
       ORDER BY r.id ASC`
    );

    const issues = [];
    for (const row of res.rows) {
      const isPremium = String(row.name).toUpperCase() === 'PREMIUM';
      const isPaidProduct = Boolean(row.paid_product_id);

      if (isPremium || isPaidProduct) {
        issues.push({
          roleId: row.id,
          roleName: row.name,
          conflictType: 'paid_product_conflict',
          isCritical: true,
          details: `Role "${row.name}" is marked as a default role, but is associated with ${isPremium ? 'built-in PREMIUM' : `paid product "${row.paid_product_name}" (${row.paid_product_code})`}. Default roles are automatically granted to newly approved users for free upon activation!`
        });
      } else if (Number(row.folder_count) === 0) {
        issues.push({
          roleId: row.id,
          roleName: row.name,
          conflictType: 'empty_default_role',
          isCritical: false,
          details: `Role "${row.name}" is marked as a default role, but grants no folder permissions in folder_roles (0 folders mapped).`
        });
      }
    }

    const hasCritical = issues.some(i => i.isCritical);

    return {
      id: 'default_roles_inconsistent',
      title: 'Default Roles With Inconsistent Configuration',
      category: 'RBAC & Roles',
      status: issues.length > 0 ? (hasCritical ? 'critical' : 'warning') : 'healthy',
      count: issues.length,
      description: 'Default roles automatically granted on user activation that conflict with paid products or grant no folder permissions.',
      actionUrl: '/admin/folders',
      actionLabel: 'Manage Folder Roles',
      items: issues.slice(0, 50)
    };
  } catch (err) {
    return {
      id: 'default_roles_inconsistent',
      title: 'Default Roles With Inconsistent Configuration',
      category: 'RBAC & Roles',
      status: 'healthy',
      count: 0,
      description: 'Default roles automatically granted on user activation that conflict with paid products or grant no folder permissions.',
      actionUrl: '/admin/folders',
      actionLabel: 'Manage Folder Roles',
      items: [],
      error: err.message
    };
  }
}

/**
 * 7. Additional safe checks for RBAC and paid product integrity.
 */
export async function checkOtherRBACIntegrityInconsistencies(client = pool) {
  const checks = [];

  // 7a. Stale active user accounts past access expiration date
  try {
    const expiredUsersRes = await client.query(
      `SELECT u.id, u.email, u.status, u.app_role, u.access_expires_at
       FROM users u
       WHERE u.status = 'active'
         AND u.access_expires_at IS NOT NULL
         AND u.access_expires_at <= NOW()
         AND u.app_role NOT IN ('OWNER', 'ADMIN')
       ORDER BY u.access_expires_at ASC`
    );

    const issues = expiredUsersRes.rows.map(u => ({
      userId: u.id,
      userEmail: u.email,
      expiresAt: u.access_expires_at,
      details: `User access expired on ${new Date(u.access_expires_at).toISOString().split('T')[0]}, but account status remains "active".`
    }));

    checks.push({
      id: 'stale_active_user_accounts',
      title: 'Active Accounts Past Access Expiration Date',
      category: 'User Lifecycle & Access',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Active user accounts whose access_expires_at date has passed without automated status reconciliation.',
      actionUrl: '/admin/expiring-users',
      actionLabel: 'Review Expiring Users',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'stale_active_user_accounts',
      title: 'Active Accounts Past Access Expiration Date',
      category: 'User Lifecycle & Access',
      status: 'healthy',
      count: 0,
      description: 'Active user accounts whose access_expires_at date has passed without automated status reconciliation.',
      actionUrl: '/admin/expiring-users',
      actionLabel: 'Review Expiring Users',
      items: [],
      error: err.message
    });
  }

  // 7b. Stale active product grants past validity date
  try {
    const staleGrantsRes = await client.query(
      `SELECT g.id, g.user_id, g.product_id, g.valid_until,
              u.email AS user_email, p.code AS product_code, p.name AS product_name
       FROM user_product_grants g
       JOIN users u ON u.id = g.user_id
       JOIN paid_products p ON p.id = g.product_id
       WHERE g.status = 'active'
         AND g.valid_until IS NOT NULL
         AND g.valid_until <= NOW()
       ORDER BY g.valid_until ASC`
    );

    const issues = staleGrantsRes.rows.map(g => ({
      grantId: g.id,
      userId: g.user_id,
      userEmail: g.user_email,
      productCode: g.product_code,
      productName: g.product_name,
      validUntil: g.valid_until,
      details: `Grant #${g.id} for "${g.product_name}" expired on ${new Date(g.valid_until).toISOString().split('T')[0]}, but status is still "active".`
    }));

    checks.push({
      id: 'stale_active_grants',
      title: 'Stale Active Grants Past Validity Date',
      category: 'Paid Products & Plans',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Product grants whose valid_until date has elapsed but whose record is still marked "active".',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Paid Products',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'stale_active_grants',
      title: 'Stale Active Grants Past Validity Date',
      category: 'Paid Products & Plans',
      status: 'healthy',
      count: 0,
      description: 'Product grants whose valid_until date has elapsed but whose record is still marked "active".',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Paid Products',
      items: [],
      error: err.message
    });
  }

  // 7c. Stale active subscriptions past period end
  try {
    const staleSubsRes = await client.query(
      `SELECT s.id, s.user_id, s.product_id, s.current_period_end,
              u.email AS user_email, p.code AS product_code, p.name AS product_name
       FROM paid_subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN paid_products p ON p.id = s.product_id
       WHERE s.status IN ('active', 'authenticated')
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end <= NOW()
       ORDER BY s.current_period_end ASC`
    );

    const issues = staleSubsRes.rows.map(s => ({
      subscriptionId: s.id,
      userId: s.user_id,
      userEmail: s.user_email,
      productCode: s.product_code,
      productName: s.product_name,
      periodEnd: s.current_period_end,
      details: `Subscription #${s.id} for "${s.product_name}" ended on ${new Date(s.current_period_end).toISOString().split('T')[0]} without renewal confirmation.`
    }));

    checks.push({
      id: 'stale_active_subscriptions',
      title: 'Stale Active Subscriptions Past Period End',
      category: 'Paid Products & Plans',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Paid subscriptions whose current billing cycle ended in the past but remain marked "active".',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Paid Products',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'stale_active_subscriptions',
      title: 'Stale Active Subscriptions Past Period End',
      category: 'Paid Products & Plans',
      status: 'healthy',
      count: 0,
      description: 'Paid subscriptions whose current billing cycle ended in the past but remain marked "active".',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Paid Products',
      items: [],
      error: err.message
    });
  }

  // 7d. Paid products referencing non-existent roles
  try {
    const brokenRolesRes = await client.query(
      `SELECT p.id, p.code, p.name, p.role_id
       FROM paid_products p
       WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = p.role_id)
       ORDER BY p.id ASC`
    );

    const issues = brokenRolesRes.rows.map(p => ({
      productId: p.id,
      productCode: p.code,
      productName: p.name,
      roleId: p.role_id,
      details: `Paid product "${p.name}" (${p.code}) references role_id ${p.role_id} which does not exist in the roles table.`
    }));

    checks.push({
      id: 'paid_products_missing_roles',
      title: 'Paid Products Referencing Missing Roles',
      category: 'Paid Products & Plans',
      status: issues.length > 0 ? 'critical' : 'healthy',
      count: issues.length,
      description: 'Paid products configured with a role_id that does not exist in the roles table.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'paid_products_missing_roles',
      title: 'Paid Products Referencing Missing Roles',
      category: 'Paid Products & Plans',
      status: 'healthy',
      count: 0,
      description: 'Paid products configured with a role_id that does not exist in the roles table.',
      actionUrl: '/admin/paid-products',
      actionLabel: 'Review Paid Products',
      items: [],
      error: err.message
    });
  }

  // 7e. Orphaned user role assignments
  try {
    const orphanedUserRolesRes = await client.query(
      `SELECT ur.user_id, ur.role_id, ur.assignment_source
       FROM user_roles ur
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ur.user_id)
          OR NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur.role_id)
       ORDER BY ur.user_id ASC`
    );

    const issues = orphanedUserRolesRes.rows.map(ur => ({
      userId: ur.user_id,
      roleId: ur.role_id,
      assignmentSource: ur.assignment_source,
      details: `user_roles entry references non-existent user ID ${ur.user_id} or role ID ${ur.role_id}.`
    }));

    checks.push({
      id: 'orphaned_user_roles',
      title: 'Orphaned User Role Assignments',
      category: 'RBAC & Roles',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Role assignments in user_roles that reference deleted users or deleted roles.',
      actionUrl: '/admin/folders',
      actionLabel: 'Folder Roles',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'orphaned_user_roles',
      title: 'Orphaned User Role Assignments',
      category: 'RBAC & Roles',
      status: 'healthy',
      count: 0,
      description: 'Role assignments in user_roles that reference deleted users or deleted roles.',
      actionUrl: '/admin/folders',
      actionLabel: 'Folder Roles',
      items: [],
      error: err.message
    });
  }

  // 7f. Orphaned folder role permissions
  try {
    const orphanedFolderRolesRes = await client.query(
      `SELECT fr.folder_path, fr.role_id
       FROM folder_roles fr
       WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = fr.role_id)
       ORDER BY fr.folder_path ASC`
    );

    const issues = orphanedFolderRolesRes.rows.map(fr => ({
      folderPath: fr.folder_path,
      roleId: fr.role_id,
      details: `Folder permission for "${fr.folder_path}" references non-existent role ID ${fr.role_id}.`
    }));

    checks.push({
      id: 'orphaned_folder_roles',
      title: 'Orphaned Folder Permissions',
      category: 'RBAC & Roles',
      status: issues.length > 0 ? 'warning' : 'healthy',
      count: issues.length,
      description: 'Folder permission mappings in folder_roles referencing roles that no longer exist.',
      actionUrl: '/admin/folders',
      actionLabel: 'Folder Permissions',
      items: issues.slice(0, 50)
    });
  } catch (err) {
    checks.push({
      id: 'orphaned_folder_roles',
      title: 'Orphaned Folder Permissions',
      category: 'RBAC & Roles',
      status: 'healthy',
      count: 0,
      description: 'Folder permission mappings in folder_roles referencing roles that no longer exist.',
      actionUrl: '/admin/folders',
      actionLabel: 'Folder Permissions',
      items: [],
      error: err.message
    });
  }

  return checks;
}

/**
 * Generates the full system integrity diagnostic report.
 * Strictly read-only, non-destructive.
 */
export async function getSystemIntegrityReport(clientOrPool = pool, opts = {}) {
  const client = clientOrPool;

  const [
    paymentRolesCheck,
    activeMissingRolesCheck,
    expiredRolesCheck,
    enabledProductsCheck,
    recurringPlansCheck,
    defaultRolesCheck,
    otherChecks
  ] = await Promise.all([
    checkPaymentRolesWithoutEntitlement(client),
    checkActiveEntitlementsMissingRoles(client),
    checkExpiredEntitlementsRetainingRoles(client),
    checkEnabledProductsWithoutActivePlans(client),
    checkRecurringPlansMissingRazorpayId(client),
    checkDefaultRolesInconsistencies(client),
    checkOtherRBACIntegrityInconsistencies(client)
  ]);

  const allChecks = [
    paymentRolesCheck,
    activeMissingRolesCheck,
    expiredRolesCheck,
    enabledProductsCheck,
    recurringPlansCheck,
    defaultRolesCheck,
    ...(Array.isArray(otherChecks) ? otherChecks : [])
  ];

  const totalIssues = allChecks.reduce((acc, cur) => acc + (cur.count || 0), 0);
  const criticalCount = allChecks.filter(c => c.status === 'critical').length;
  const warningCount = allChecks.filter(c => c.status === 'warning').length;
  const healthyCount = allChecks.filter(c => c.status === 'healthy').length;

  let overallStatus = 'healthy';
  if (criticalCount > 0) overallStatus = 'critical';
  else if (warningCount > 0) overallStatus = 'warning';

  let recommendation = 'All system integrity diagnostics passed. RBAC assignments, paid products, and entitlements are consistent.';
  if (overallStatus === 'critical') {
    recommendation = `${criticalCount} critical configuration issue(s) detected. Review the highlighted items below.`;
  } else if (overallStatus === 'warning') {
    recommendation = `${totalIssues} non-blocking inconsistency / inconsistencies detected. Review diagnostics below for details.`;
  }

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    recommendation,
    summary: {
      totalChecks: allChecks.length,
      totalIssues,
      criticalCount,
      warningCount,
      healthyCount,
      overallStatus
    },
    checks: allChecks,
    byCategory: allChecks.reduce((acc, cur) => {
      const cat = cur.category || 'General';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(cur);
      return acc;
    }, {})
  };
}
