import { pool } from '../db/pool.js';
import { ROLES } from './admin.js';
import { syncProductRbacRole, getProductByCode, recordRecurringPremiumSubscriptionEvent, validateProductPromotion, recordPromotionRedemption } from './paidProducts.js';
import { reconcileExpiredUserStatuses } from './users.js';

/**
 * Determines if a user has a valid premium entitlement based on payment source of truth.
 * Manual RBAC assignment (premium_source='manual') is NOT considered entitlement.
 * Valid entitlement = active subscription (recurring) OR one-time with future expiry.
 * When product grants exist, grant validity is the source of truth; do not fall back to access_expires_at.
 */
export function hasValidPremiumEntitlement(user, hasActiveSub, hasProductGrants = false) {
  if (!user) return false;
  if (hasProductGrants || user.has_product_grants || user.hasProductGrants) return false;
  if (user.premium_source === 'one_time' && user.access_expires_at) {
    try {
      return new Date(user.access_expires_at).getTime() > Date.now();
    } catch {
      return false;
    }
  }
  return false;
}

async function ensurePremiumRoleId(client) {
  try {
    await client.query(`INSERT INTO roles (name, description) VALUES ('PREMIUM', 'Built-in Premium role') ON CONFLICT (name) DO NOTHING`);
  } catch {}
  try {
    const res = await client.query(`SELECT id FROM roles WHERE name = 'PREMIUM'`);
    if (res.rowCount > 0) return Number(res.rows[0].id);
  } catch {}
  return null;
}

async function syncPremiumRbacRole(userId, hasEntitlement, client) {
  // Sync Premium RBAC through the generic framework if available
  try {
    const product = await getProductByCode('PREMIUM', client);
    if (product) {
      const genericRes = await syncProductRbacRole(userId, product.id, client);
      if (genericRes && genericRes.action !== 'error') {
        const actionMap = {
          granted: 'granted',
          revoked: 'revoked',
          skipped_protected: 'skipped_protected',
          preserved_manual: 'preserved_manual',
          already_entitled: 'no_change',
          not_entitled: 'no_change'
        };
        return { rbacAction: actionMap[genericRes.action] || 'no_change' };
      }
    }
  } catch {}

  const premiumRoleId = await ensurePremiumRoleId(client);
  if (premiumRoleId == null) return { rbacAction: 'no_role' };
  try {
    const check = await client.query('SELECT assignment_source FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, premiumRoleId]);
    const hasRbacPremium = check.rowCount > 0;
    const existingSource = hasRbacPremium ? check.rows[0].assignment_source : null;

    if (hasEntitlement && !hasRbacPremium) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assignment_source) 
         VALUES ($1, $2, 'payment_system') 
         ON CONFLICT (user_id, role_id) 
         DO UPDATE SET assignment_source = 'payment_system'`,
        [userId, premiumRoleId]
      );
      return { rbacAction: 'granted' };
    }
    if (!hasEntitlement && hasRbacPremium) {
      if (existingSource === 'manual') {
        return { rbacAction: 'preserved_manual' };
      }
      await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, premiumRoleId]);
      return { rbacAction: 'revoked' };
    }
    return { rbacAction: 'no_change' };
  } catch (e) {
    return { rbacAction: 'error', error: e.message };
  }
}

/**
 * Syncs the user's role and premium_source based on payment entitlement (source of truth).
 * Handles both recurring (subscription) and one-time (expiry) entitlements.
 * Safe and idempotent: preserves OWNER/ADMIN, preserves manual premium, and logs changes.
 * - Grants PREMIUM when entitlement exists but role is missing (fixes missing)
 * - Revokes PREMIUM when entitlement expired/cancelled and source is payment-derived (fixes stale)
 * - Never creates entitlement from manual RBAC
 */
export async function syncUserPremiumRole(userId, client = pool) {
  const userResult = await client.query(
    'SELECT id, email, app_role, premium_source, access_expires_at FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rowCount === 0) return null;
  const user = userResult.rows[0];

  const currentRole = user.app_role;
  // OWNER/ADMIN are protected – never modify or sync roles
  if (currentRole === ROLES.OWNER || currentRole === ROLES.ADMIN) {
    return null;
  }

  const currentSource = user.premium_source;

  // Fetch active subscriptions and grants for this user
  const subResult = await client.query(
    `SELECT id, status FROM premium_subscriptions 
     WHERE user_id = $1 AND provider = 'razorpay' AND status IN ('active', 'authenticated')
       AND (current_period_end IS NULL OR current_period_end > NOW())
     LIMIT 1`,
    [userId]
  );
  const paidSubResult = await client.query(
    `SELECT id, status FROM paid_subscriptions 
     WHERE user_id = $1 AND product_id = (SELECT id FROM paid_products WHERE code='PREMIUM')
       AND status IN ('active', 'authenticated')
       AND (current_period_end IS NULL OR current_period_end > NOW())
     LIMIT 1`,
    [userId]
  );
  const grantResult = await client.query(
    `SELECT g.id FROM user_product_grants g
     JOIN paid_products p ON g.product_id = p.id
     WHERE g.user_id = $1 AND (p.code = 'PREMIUM' OR LOWER(p.code) = 'premium') AND g.status = 'active'
       AND (g.valid_until IS NULL OR g.valid_until > NOW())
     LIMIT 1`,
    [userId]
  );
  const anyGrantResult = await client.query(
    `SELECT g.id FROM user_product_grants g
     JOIN paid_products p ON g.product_id = p.id
     WHERE g.user_id = $1 AND (p.code = 'PREMIUM' OR LOWER(p.code) = 'premium')
     LIMIT 1`,
    [userId]
  );
  const hasActiveGrant = grantResult.rowCount > 0;
  const hasAnyGrant = anyGrantResult.rowCount > 0;
  const hasActiveSub = subResult.rowCount > 0 || paidSubResult.rowCount > 0 || hasActiveGrant;
  let hasEntitlement;
  if (hasAnyGrant) {
    // Grants are source of truth for all products (including PREMIUM) — subscription cannot revive expired grant
    hasEntitlement = hasActiveGrant;
  } else {
    hasEntitlement = hasValidPremiumEntitlement(user, hasActiveSub, hasAnyGrant);
  }

  let appRoleResult = null;

  if (hasEntitlement) {
      // Entitlement exists – ensure PREMIUM role
      if (currentRole !== ROLES.PREMIUM) {
        const newSource = hasActiveSub ? 'subscription' : 'one_time';
        if (hasActiveSub) {
          await client.query(
            `UPDATE users SET app_role = 'PREMIUM', premium_source = 'subscription', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
        } else {
          await client.query(
            `UPDATE users SET app_role = 'PREMIUM', premium_source = 'one_time', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
        }
        await client.query(
          `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) 
           VALUES ($1, NULL, $2, $3, 'grant_premium')`,
          [userId, currentRole || ROLES.USER, ROLES.PREMIUM]
        );
        appRoleResult = { action: 'granted', previousRole: currentRole, newSource };
      } else if (hasActiveSub && currentSource !== 'subscription') {
        if (currentSource === 'one_time' || currentSource == null) {
          await client.query(
            `UPDATE users SET premium_source = 'subscription', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          appRoleResult = { action: 'source_corrected', previousSource: currentSource, newSource: 'subscription' };
        } else {
          appRoleResult = { action: 'no_change' };
        }
      } else if (!hasActiveSub && hasValidPremiumEntitlement(user, false, hasAnyGrant) && currentSource !== 'one_time') {
        if (currentSource == null) {
          await client.query(
            `UPDATE users SET premium_source = 'one_time', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          appRoleResult = { action: 'source_corrected', previousSource: currentSource, newSource: 'one_time' };
        } else {
          appRoleResult = { action: 'no_change' };
        }
      } else if (currentRole === ROLES.PREMIUM && currentSource == null) {
        if (hasActiveSub) {
          await client.query(
            `UPDATE users SET premium_source = 'subscription', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          appRoleResult = { action: 'source_corrected', previousSource: null, newSource: 'subscription' };
        } else {
          await client.query(
            `UPDATE users SET premium_source = 'one_time', updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          appRoleResult = { action: 'source_corrected', previousSource: null, newSource: 'one_time' };
        }
      } else {
        appRoleResult = { action: 'no_change' };
      }
    } else {
      // No valid entitlement – revoke stale PREMIUM if payment-derived
      if (currentRole === ROLES.PREMIUM) {
        if (currentSource !== 'manual') {
          await client.query(
            `UPDATE users SET app_role = 'USER', premium_source = NULL, updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          await client.query(
            `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) 
             VALUES ($1, NULL, $2, $3, 'revoke_premium')`,
            [userId, ROLES.PREMIUM, ROLES.USER]
          );
          appRoleResult = { action: 'revoked', previousSource: currentSource };
        } else {
          appRoleResult = { action: 'preserved_manual' };
        }
      } else {
        appRoleResult = { action: 'no_change' };
      }
    }

  const rbacResult = await syncPremiumRbacRole(userId, hasEntitlement, client);

  // Return combined result, preserving original action for backward compatibility
  const combinedAction = appRoleResult ? appRoleResult.action : 'no_change';
  return {
    action: combinedAction,
    previousRole: appRoleResult?.previousRole,
    newSource: appRoleResult?.newSource,
    previousSource: appRoleResult?.previousSource,
    hasEntitlement,
    rbac: rbacResult,
    ...(appRoleResult || {})
  };
}

/**
 * Safe bulk reconciliation for missing/stale PREMIUM roles.
 * Iterates over all non-OWNER/ADMIN users and syncs each via syncUserPremiumRole.
 * Idempotent and safe to run repeatedly; preserves manual and OWNER/ADMIN.
 * Returns summary { checked, granted, revoked, preserved, errors }.
 */
export async function reconcileAllPremiumRoles(opts = {}) {
  const dryRun = !!opts.dryRun;
  const limit = opts.limit ? parseInt(opts.limit, 10) : 5000;
  const client = opts.client || pool;
  // Fetch candidate users – exclude OWNER/ADMIN (protected). Include all others to catch both missing and stale.
  const usersRes = await client.query(
    `SELECT id, app_role, premium_source, access_expires_at FROM users WHERE COALESCE(app_role,'USER') NOT IN ('OWNER','ADMIN') LIMIT $1`,
    [limit]
  );
  let checked = 0;
  let granted = 0;
  let revoked = 0;
  let corrected = 0;
  let usersExpired = 0;
  const errors = [];

  try {
    const userStatusRes = await reconcileExpiredUserStatuses({ client, dryRun });
    usersExpired = userStatusRes.usersExpired || 0;
  } catch (err) {
    errors.push({ userId: 'SYSTEM_USER_STATUS', error: err.message });
  }
  // For RBAC dry-run, need premium role id once
  let premiumRoleIdForDryRun = null;
  if (dryRun) {
    try {
      const pr = await client.query(`SELECT id FROM roles WHERE name = 'PREMIUM'`);
      if (pr.rowCount > 0) premiumRoleIdForDryRun = Number(pr.rows[0].id);
    } catch {}
  }
  for (const row of usersRes.rows) {
    checked++;
    try {
      if (dryRun) {
        // Dry-run: evaluate without writing
        const subRes = await client.query(
          `SELECT id FROM premium_subscriptions WHERE user_id=$1 AND provider='razorpay' AND status IN ('active','authenticated') AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1`,
          [row.id]
        );
        const paidSubRes = await client.query(
          `SELECT id FROM paid_subscriptions WHERE user_id=$1 AND product_id = (SELECT id FROM paid_products WHERE code='PREMIUM') AND status IN ('active','authenticated') AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1`,
          [row.id]
        );
        const grantRes = await client.query(
          `SELECT g.id FROM user_product_grants g
           JOIN paid_products p ON g.product_id = p.id
           WHERE g.user_id = $1 AND (p.code = 'PREMIUM' OR LOWER(p.code) = 'premium') AND g.status = 'active'
             AND (g.valid_until IS NULL OR g.valid_until > NOW())
           LIMIT 1`,
          [row.id]
        );
        const anyGrantRes = await client.query(
          `SELECT g.id FROM user_product_grants g
           JOIN paid_products p ON g.product_id = p.id
           WHERE g.user_id = $1 AND (p.code = 'PREMIUM' OR LOWER(p.code) = 'premium')
           LIMIT 1`,
          [row.id]
        );
        const hasActiveSub = subRes.rowCount > 0 || paidSubRes.rowCount > 0 || grantRes.rowCount > 0;
        const hasProductGrants = anyGrantRes.rowCount > 0;
        const hasEntitlement = hasProductGrants ? grantRes.rowCount > 0 : hasValidPremiumEntitlement(row, hasActiveSub, hasProductGrants);
        // App role checks
        if (hasEntitlement && row.app_role !== ROLES.PREMIUM) granted++;
        else if (!hasEntitlement && row.app_role === ROLES.PREMIUM && (row.premium_source === 'subscription' || row.premium_source === 'one_time')) revoked++;
        // RBAC checks (user_roles)
        if (premiumRoleIdForDryRun != null) {
          try {
            const rbacCheck = await client.query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [row.id, premiumRoleIdForDryRun]);
            const hasRbacPremium = rbacCheck.rowCount > 0;
            if (hasEntitlement && !hasRbacPremium) granted++;
            else if (!hasEntitlement && hasRbacPremium) revoked++;
          } catch {}
        }
      } else {
        const res = await syncUserPremiumRole(row.id, client);
        if (res) {
          if (res.action === 'granted') granted++;
          else if (res.action === 'revoked') revoked++;
          else if (res.action === 'source_corrected') corrected++;
          // Also count RBAC changes
          if (res.rbac) {
            if (res.rbac.rbacAction === 'granted') granted++;
            else if (res.rbac.rbacAction === 'revoked') revoked++;
          }
        }
      }
    } catch (e) {
      errors.push({ userId: row.id, error: e.message });
    }
  }
  return { checked, granted, revoked, corrected, usersExpired, errors, dryRun };
}

/**
 * Handles incoming Razorpay subscription webhooks with safety, out-of-order, and duplicate delivery checks.
 */
export async function handleSubscriptionWebhook(payload, eventId, webhookEvent = null) {
  const entity = payload?.subscription?.entity;
  if (!entity || !entity.id) {
    throw new Error('Invalid webhook payload: subscription entity missing.');
  }

  const subId = entity.id;
  const status = entity.status; // active, cancelled, expired, completed, authenticated, etc.
  const planId = entity.plan_id;
  const customerId = entity.customer_id;
  let cancelAtPeriodEnd = !!entity.cancel_at_period_end;

  // Timestamps (convert UNIX epoch seconds to Date objects)
  const currentStart = entity.current_start ? new Date(entity.current_start * 1000) : (entity.created_at ? new Date(entity.created_at * 1000) : null);
  const currentEnd = entity.current_end ? new Date(entity.current_end * 1000) : (entity.charge_at ? new Date(entity.charge_at * 1000) : null);

  // Extract payment details if available (e.g. from subscription.charged)
  const paymentEntity = payload?.payment?.entity;
  const paymentId = paymentEntity?.id || entity?.payment_id || null;
  const paymentStatus = paymentEntity?.status || null;
  const invoiceId = paymentEntity?.invoice_id || entity?.invoice_id || null;

  // Resolve user_id from notes
  let userIdStr = entity.notes?.userId || entity.notes?.user_id;
  if (!userIdStr) {
    // Fallback: query DB for existing record
    const existing = await pool.query(
      'SELECT user_id FROM premium_subscriptions WHERE provider_subscription_id = $1',
      [subId]
    );
    if (existing.rowCount > 0) {
      userIdStr = existing.rows[0].user_id;
    }
  }

  if (!userIdStr) {
    throw new Error(`Cannot resolve user_id for subscription ${subId}.`);
  }

  const userId = parseInt(userIdStr, 10);
  if (isNaN(userId)) {
    throw new Error(`Invalid user_id "${userIdStr}" for subscription ${subId}.`);
  }

  const client = pool; // We can perform operations on the default pool safely (single pool transactions)
  const pgClient = await client.connect();

  try {
    await pgClient.query('BEGIN');

    // Check if subscription corresponds to a generic product plan in paid_product_plans
    const planRes = await pgClient.query(
      `SELECT p.*, prod.id AS product_id, prod.code AS product_code, prod.is_enabled AS product_enabled 
       FROM paid_product_plans p 
       JOIN paid_products prod ON p.product_id = prod.id 
       WHERE p.razorpay_plan_id = $1 OR p.id = $2`,
      [planId, parseInt(entity.notes?.planId || entity.notes?.plan_id, 10) || null]
    );
    const genericPlan = planRes.rows[0];

    if (genericPlan) {
      // Check duplicate delivery
      if (eventId) {
        const eventCheck = await pgClient.query(
          'SELECT id FROM paid_product_events WHERE provider_event_id = $1 AND event_type = $2',
          [eventId, webhookEvent || `subscription_${status}`]
        );
        if (eventCheck.rowCount > 0) {
          await pgClient.query('COMMIT');
          return { skipped: true, reason: 'Duplicate event' };
        }
      }

      // F2: Generic out-of-order protection (mirrors legacy authoritativeStates guard)
      // Prevent stale created/authenticated/pending from overwriting active/cancelled/expired
      {
        const existingPaid = await pgClient.query(
          'SELECT id, status, current_period_end, cancel_at_period_end FROM paid_subscriptions WHERE provider_subscription_id=$1',
          [subId]
        );
        if (existingPaid.rowCount > 0) {
          const existing = existingPaid.rows[0];
          const authoritativeStates = ['active', 'completed', 'cancelled', 'expired'];
          const staleIncomingStates = ['created', 'authenticated', 'pending'];
          if (authoritativeStates.includes(existing.status) && staleIncomingStates.includes(status)) {
            await pgClient.query(
              `INSERT INTO paid_product_events (product_id, user_id, event_type, provider_event_id, previous_status, new_status, message, payload, created_at)
               VALUES ($1,$2,'out_of_order_skipped',$3,$4,$5,$6,$7,NOW())`,
              [genericPlan.product_id, userId, eventId, existing.status, status, 'Out of order stale status ignored for generic subscription.', JSON.stringify({ subId, status })]
            );
            await pgClient.query('COMMIT');
            return { skipped: true, reason: 'Stale out of order status ignored' };
          }
          if ((existing.status === 'cancelled' || existing.status === 'expired') && status === 'active') {
            const existingEnd = existing.current_period_end ? new Date(existing.current_period_end).getTime() : 0;
            const incomingEnd = currentEnd ? currentEnd.getTime() : 0;
            if (incomingEnd <= existingEnd) {
              await pgClient.query(
                `INSERT INTO paid_product_events (product_id, user_id, event_type, provider_event_id, previous_status, new_status, message, payload, created_at)
                 VALUES ($1,$2,'out_of_order_skipped',$3,$4,$5,$6,$7,NOW())`,
                [genericPlan.product_id, userId, eventId, existing.status, status, 'Out of order active ignored to protect cancellation.', JSON.stringify({ subId, status })]
              );
              await pgClient.query('COMMIT');
              return { skipped: true, reason: 'Out of order event' };
            }
          }
          // Preserve cancel_at_period_end flag: never regress true -> false from stale event
          if (existing.cancel_at_period_end && !cancelAtPeriodEnd) {
            cancelAtPeriodEnd = true;
          }
        }
      }

      const promoCode = entity.notes?.promoCode || entity.notes?.promo_code || null;
      const isSuccessfulPayment = 
        webhookEvent === 'subscription.charged' || 
        (status === 'active' && (webhookEvent === 'subscription.activated' || !webhookEvent));

      if (promoCode && isSuccessfulPayment) {
        const { validateProductPromotion, recordPromotionRedemption } = await import('./paidProducts.js');
        const promoResult = await validateProductPromotion(userId, promoCode, genericPlan.product_id, 'recurring', pgClient);
        if (promoResult.valid) {
          await recordPromotionRedemption({
            userId,
            promotionIdOrCode: promoResult.promo.id || promoResult.promo.code,
            providerReference: subId,
            originalAmount: genericPlan.price_amount_paise,
            discountAmount: 0,
            finalAmount: genericPlan.price_amount_paise
          }, pgClient);
        }
      }

      const { recordGenericRecurringSubscriptionEvent } = await import('./paidProducts.js');
      await recordGenericRecurringSubscriptionEvent({
        userId,
        productId: genericPlan.product_id,
        planId: genericPlan.id,
        providerSubscriptionId: subId,
        status,
        currentPeriodStart: currentStart,
        currentPeriodEnd: currentEnd,
        cancelAtPeriodEnd,
        paymentId,
        invoiceId,
        amountPaise: paymentEntity?.amount || null,
        currency: paymentEntity?.currency || 'INR',
        promoCode,
        eventId,
        eventType: webhookEvent,
        metadata: { customer_id: customerId, plan_id: planId }
      }, pgClient);

      await pgClient.query('COMMIT');
      return { success: true };
    }

    // Fetch existing subscription to check for out-of-order events or duplicates
    const existingResult = await pgClient.query(
      'SELECT id, status, current_period_end FROM premium_subscriptions WHERE provider_subscription_id = $1',
      [subId]
    );

    let dbSubId = null;
    let prevStatus = null;

    if (existingResult.rowCount > 0) {
      const existing = existingResult.rows[0];
      dbSubId = existing.id;
      prevStatus = existing.status;

      // Idempotency: Duplicate delivery check
      const eventCheck = await pgClient.query(
        'SELECT id FROM premium_subscription_events WHERE provider_event_id = $1 AND event_type = $2',
        [eventId, `razorpay_${status}`]
      );
      if (eventCheck.rowCount > 0) {
        // Already processed this event! Rollback and return safely (idempotent success)
        await pgClient.query('ROLLBACK');
        return { skipped: true, reason: 'Duplicate event' };
      }

      // Out-of-order safety check:
      // A late-arriving authenticated, created, or pending event must not downgrade an already active, completed, or cancelled/expired subscription.
      const authoritativeStates = ['active', 'completed', 'cancelled', 'expired'];
      const staleIncomingStates = ['created', 'authenticated', 'pending'];
      
      if (authoritativeStates.includes(existing.status) && staleIncomingStates.includes(status)) {
        await pgClient.query(
          `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, dbSubId, 'out_of_order_skipped', eventId, existing.status, status, 'Out of order stale status change ignored.']
        );
        await pgClient.query('COMMIT');
        return { skipped: true, reason: 'Stale out of order status ignored' };
      }

      // If we already have a cancelled or expired status, do not transition it back to active
      // unless the incoming current_period_end is later (renewal).
      if ((existing.status === 'cancelled' || existing.status === 'expired') && status === 'active') {
        const existingEnd = existing.current_period_end ? new Date(existing.current_period_end).getTime() : 0;
        const incomingEnd = currentEnd ? currentEnd.getTime() : 0;
        if (incomingEnd <= existingEnd) {
          // Skip updating status, log warning event and commit
          await pgClient.query(
            `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, dbSubId, 'out_of_order_skipped', eventId, existing.status, status, 'Out of order webhook ignored to protect cancellation status.']
          );
          await pgClient.query('COMMIT');
          return { skipped: true, reason: 'Out of order event' };
        }
      }

      // Update existing subscription details
      await pgClient.query(
        `UPDATE premium_subscriptions 
         SET status = $1, current_period_start = $2, current_period_end = $3, cancel_at_period_end = $4, updated_at = NOW()
         WHERE id = $5`,
        [status, currentStart, currentEnd, cancelAtPeriodEnd, dbSubId]
      );
    } else {
      // Insert new subscription record
      const insertResult = await pgClient.query(
        `INSERT INTO premium_subscriptions (user_id, provider, provider_customer_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end) 
         VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [userId, customerId, subId, planId, status, currentStart, currentEnd, cancelAtPeriodEnd]
      );
      dbSubId = insertResult.rows[0].id;
    }

    // Determine successful payment state (charged event OR transition to active/authenticated status)
    const isSuccessfulPayment = 
      webhookEvent === 'subscription.charged' || 
      (status === 'active' && (webhookEvent === 'subscription.activated' || !webhookEvent));

    const currentEndStr = currentEnd ? currentEnd.toISOString() : 'N/A';

    let alreadyExtended = false;
    if (isSuccessfulPayment) {
      // 1. Check if we already extended for this specific billing cycle period end
      if (currentEnd) {
        const periodCheck = await pgClient.query(
          "SELECT id FROM premium_subscription_events WHERE subscription_id = $1 AND message LIKE $2",
          [dbSubId, `%Period End: ${currentEnd.toISOString()}%`]
        );
        if (periodCheck.rowCount > 0) {
          alreadyExtended = true;
        }
      }

      // 2. Fallback to Payment ID check
      if (!alreadyExtended && paymentId) {
        const paymentCheck = await pgClient.query(
          "SELECT id FROM premium_subscription_events WHERE user_id = $1 AND (message LIKE $2 OR provider_event_id = $3)",
          [userId, `%Payment ID: ${paymentId}%`, eventId]
        );
        if (paymentCheck.rowCount > 0) {
          alreadyExtended = true;
        }
      } else if (!alreadyExtended && invoiceId) {
        const invoiceCheck = await pgClient.query(
          "SELECT id FROM premium_subscription_events WHERE user_id = $1 AND (message LIKE $2 OR provider_event_id = $3)",
          [userId, `%Invoice ID: ${invoiceId}%`, eventId]
        );
        if (invoiceCheck.rowCount > 0) {
          alreadyExtended = true;
        }
      }

      // 3. Fallback to Event ID check for exact duplicate webhook deliveries
      if (!alreadyExtended) {
        const eventCheck = await pgClient.query(
          "SELECT id FROM premium_subscription_events WHERE provider_event_id = $1",
          [eventId]
        );
        if (eventCheck.rowCount > 0) {
          alreadyExtended = true;
        }
      }
    }

    let extensionMsg = '';
    if (isSuccessfulPayment && !alreadyExtended) {
      const userCheck = await pgClient.query(
        'SELECT premium_source FROM users WHERE id = $1',
        [userId]
      );
      const u = userCheck.rows[0];
      if (u && u.premium_source !== 'manual') {
        const days = genericPlan?.duration_days || parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
        await pgClient.query(
          `UPDATE users 
           SET access_expires_at = COALESCE(GREATEST(access_expires_at, NOW()), NOW()) + ($2 || ' days')::interval,
               status = 'active',
               updated_at = NOW()
           WHERE id = $1`,
          [userId, days]
        );
        extensionMsg = `Successfully extended premium membership by ${days} days. Period End: ${currentEndStr}. Payment ID: ${paymentId || 'N/A'}. Invoice ID: ${invoiceId || 'N/A'}.`;

        // Record promotion redemption for recurring subscription if a promoCode was applied
        const promoCode = entity.notes?.promoCode || entity.notes?.promo_code || null;
        if (promoCode) {
          const cleanCode = promoCode.trim().toUpperCase();
          const promoResult = await validatePromoCode(userId, cleanCode, 'recurring');
          if (promoResult.valid) {
            await recordPromotionRedemption({
              userId,
              promotionIdOrCode: promoResult.promo.code,
              providerReference: subId,
              originalAmount: promoResult.baseAmount * 100,
              discountAmount: promoResult.discountAmount * 100,
              finalAmount: promoResult.finalAmount * 100
            }, pgClient);
            extensionMsg += ` Promo redeemed: ${promoResult.promo.code}.`;
          }
        }
      } else {
        extensionMsg = `User has manual premium - skipped auto-extension.`;
      }
    } else if (alreadyExtended) {
      extensionMsg = `Skipped duplicate extension. Period End: ${currentEndStr}. Payment ID: ${paymentId || 'N/A'}.`;
    }

    // Log subscription event for auditing
    const fullMsg = extensionMsg 
      ? `Webhook event processed successfully for status: ${status}. ${extensionMsg}`
      : `Webhook event processed successfully for status: ${status}`;

    await pgClient.query(
      `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, dbSubId, `razorpay_${status}`, eventId, prevStatus, status, fullMsg]
    );

    // Generic Paid Products framework integration: paid_subscriptions + paid_orders + subscription-cycle grants
    try {
      await recordRecurringPremiumSubscriptionEvent({
        userId,
        providerSubscriptionId: subId,
        status,
        currentPeriodStart: currentStart,
        currentPeriodEnd: currentEnd,
        cancelAtPeriodEnd,
        paymentId,
        invoiceId,
        amountPaise: paymentEntity?.amount || null,
        currency: paymentEntity?.currency || 'INR',
        promoCode: entity.notes?.promoCode || entity.notes?.promo_code || null,
        eventId,
        eventType: webhookEvent,
        metadata: { customer_id: customerId, plan_id: planId }
      }, pgClient);
    } catch (err) {
      console.warn('Generic recurring payment integration notice:', err.message);
    }

    // Sync role update
    await syncUserPremiumRole(userId, pgClient);

    await pgClient.query('COMMIT');
    return { success: true };
  } catch (err) {
    try { await pgClient.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    pgClient.release();
  }
}

/**
 * Fetches premium subscription state and manually assigned premium details for a user.
 */
export async function getSubscriptionDetailsForUser(userId) {
  const result = await pool.query(
    `SELECT s.*, u.app_role, u.premium_source 
     FROM users u
     LEFT JOIN premium_subscriptions s ON s.user_id = u.id AND s.provider = 'razorpay'
     WHERE u.id = $1
     ORDER BY s.updated_at DESC
     LIMIT 1`,
    [userId]
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
}

/**
 * Resolves promotion codes parsed from env PREMIUM_PROMO_CODES_JSON.
 */
export function getPromoCodes() {
  const json = process.env.PREMIUM_PROMO_CODES_JSON;
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch (err) {
    console.error('Failed to parse PREMIUM_PROMO_CODES_JSON:', err);
    return [];
  }
}

/**
 * Validates promotion code server-side.
 */
export async function validatePromoCode(userId, promoCode, membershipType) {
  if (!promoCode || typeof promoCode !== 'string') {
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }

  // Get PREMIUM product ID
  const product = await getProductByCode('PREMIUM', pool);
  
  if (product) {
    const result = await validateProductPromotion(userId, promoCode, product.id, membershipType, pool);
    if (!result.valid) {
      return result;
    }

    const baseAmount = membershipType === 'recurring'
      ? parseInt(process.env.PREMIUM_MONTHLY_AMOUNT_INR || '300', 10)
      : parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10);

    let discountAmount = 0;
    const promo = result.promo;
    if (promo.discount_type === 'percentage') {
      discountAmount = Math.floor((baseAmount * promo.discount_value) / 100);
    } else if (promo.discount_type === 'flat') {
      discountAmount = promo.discount_value;
    }

    discountAmount = Math.min(discountAmount, baseAmount);
    let finalAmount = baseAmount - discountAmount;
    if (finalAmount < 1) {
      finalAmount = 1;
      discountAmount = baseAmount - 1;
    }

    return {
      valid: true,
      promo: {
        code: promo.code,
        type: promo.discount_type,
        value: promo.discount_value,
        recurringOfferId: promo.recurring_offer_id || null
      },
      baseAmount,
      discountAmount,
      finalAmount,
      recurringOfferId: membershipType === 'recurring' ? promo.recurring_offer_id : null
    };
  }

  // Fallback: If PREMIUM product is not configured in the DB (like in legacy tests),
  // fallback entirely to the old environment variables-based validation
  const cleanCode = promoCode.trim().toUpperCase();
  const promos = getPromoCodes();
  const promo = promos.find(p => p.code.toUpperCase() === cleanCode);
  if (!promo) {
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }
  if (promo.enabled === false) {
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }

  // Check user registration date vs eligibilityDays
  const userRes = await pool.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  if (userRes.rowCount === 0) {
    return { valid: false, error: 'User not found.' };
  }
  const user = userRes.rows[0];

  if (promo.eligibilityDays && promo.eligibilityDays > 0) {
    const elapsedMs = Date.now() - new Date(user.created_at).getTime();
    const elapsedDays = elapsedMs / (24 * 3600 * 1000);
    if (elapsedDays > promo.eligibilityDays) {
      return { valid: false, error: 'You are no longer eligible for this promotion.' };
    }
  }

  // Check user has not already redeemed that promotion
  const redemptionRes = await pool.query(
    'SELECT id FROM premium_promo_redemptions WHERE user_id = $1 AND promotion_code = $2',
    [userId, promo.code]
  );
  if (redemptionRes.rowCount > 0) {
    return { valid: false, error: 'You have already redeemed this promotion.' };
  }

  // Check max redemptions
  if (promo.maxRedemptions && promo.maxRedemptions > 0) {
    const totalRes = await pool.query(
      'SELECT COUNT(*) as count FROM premium_promo_redemptions WHERE promotion_code = $1',
      [promo.code]
    );
    const count = parseInt(totalRes.rows[0].count, 10);
    if (count >= promo.maxRedemptions) {
      return { valid: false, error: 'This promotion has reached its maximum usage limit.' };
    }
  }

  // Check type specific conditions (e.g. recurring needs recurringOfferId)
  if (membershipType === 'recurring' && !promo.recurringOfferId) {
    return { valid: false, error: 'This promotion cannot be applied to recurring subscriptions.' };
  }

  // Calculate discounted amount
  const baseAmount = membershipType === 'recurring'
    ? parseInt(process.env.PREMIUM_MONTHLY_AMOUNT_INR || '300', 10)
    : parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10);

  let discountAmount = 0;
  if (promo.type === 'percentage') {
    discountAmount = Math.floor((baseAmount * promo.value) / 100);
  } else if (promo.type === 'flat') {
    discountAmount = promo.value;
  }

  discountAmount = Math.min(discountAmount, baseAmount);
  let finalAmount = baseAmount - discountAmount;
  if (finalAmount < 1) {
    finalAmount = 1;
    discountAmount = baseAmount - 1;
  }

  return {
    valid: true,
    promo,
    baseAmount,
    discountAmount,
    finalAmount,
    recurringOfferId: membershipType === 'recurring' ? promo.recurringOfferId : null
  };
}
