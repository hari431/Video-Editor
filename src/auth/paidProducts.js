import { pool } from '../db/pool.js';
import { ROLES } from './admin.js';
import { reconcileExpiredUserStatuses } from './users.js';

/**
 * Core Paid Product Framework (Generic across all paid products and plans)
 * 
 * Supports:
 * - Generic Product & Plan Lookups
 * - Paid Order Creation and Status Transitions
 * - Paid Subscriptions Lifecycle Management
 * - Append-Only Entitlement Grants (user_product_grants)
 * - Generic Entitlement Validation
 * - Product-Scoped Payment-Managed RBAC Synchronization (respecting assignment_source)
 * - Strict Protection for OWNER and ADMIN roles
 * - Full Protection for manual RBAC assignments
 */

// ── 1. Product and Plan Lookups ──────────────────────────────────────────────

/**
 * Retrieves a product by its unique code (e.g., 'PREMIUM').
 */
export async function getProductByCode(code, client = pool) {
  if (!code) return null;
  const res = await client.query(
    `SELECT p.*, r.name AS role_name 
     FROM paid_products p
     LEFT JOIN roles r ON p.role_id = r.id
     WHERE p.code = $1`,
    [code]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves an active product by code only if enabled.
 */
export async function getActiveProductByCode(code, client = pool) {
  if (!code) return null;
  const res = await client.query(
    `SELECT p.*, r.name AS role_name 
     FROM paid_products p
     JOIN roles r ON p.role_id = r.id
     WHERE p.code = $1 AND p.is_enabled = TRUE`,
    [code]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves a product by its primary key ID.
 */
export async function getProductById(productId, client = pool) {
  if (!productId) return null;
  if (isNaN(Number(productId))) return null;
  const res = await client.query(
    `SELECT p.*, r.name AS role_name 
     FROM paid_products p
     LEFT JOIN roles r ON p.role_id = r.id
     WHERE p.id = $1`,
    [productId]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves a plan by product ID and plan code.
 */
export async function getPlanByCode(productId, planCode, client = pool) {
  if (!productId || !planCode) return null;
  const res = await client.query(
    `SELECT * FROM paid_product_plans 
     WHERE product_id = $1 AND code = $2`,
    [productId, planCode]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves all active plans for a given product.
 */
export async function getActivePlansForProduct(productId, client = pool) {
  if (!productId) return [];
  const res = await client.query(
    `SELECT * FROM paid_product_plans 
     WHERE product_id = $1 AND is_active = TRUE 
     ORDER BY price_amount_paise ASC`,
    [productId]
  );
  return res.rows;
}

/**
 * Retrieves all products with their associated roles.
 */
export async function getAllProductsWithRoles(client = pool) {
  const res = await client.query(
    `SELECT p.*, r.name AS role_name 
     FROM paid_products p
     LEFT JOIN roles r ON p.role_id = r.id
     ORDER BY p.id ASC`
  );
  return res.rows;
}

/**
 * Retrieves all product plans, ordered by product and price.
 */
export async function getAllPlans(client = pool) {
  const res = await client.query(
    `SELECT * FROM paid_product_plans 
     ORDER BY product_id ASC, price_amount_paise ASC`
  );
  return res.rows;
}

/**
 * Counts the number of active entitlements for a product.
 */
export async function countActiveProductGrants(productId, client = pool) {
  const res = await client.query(
    `SELECT COUNT(*)::integer AS count FROM user_product_grants
     WHERE product_id = $1
       AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())`,
    [productId]
  );
  return res.rows[0].count;
}

/**
 * Counts the unique active users/members for a product, taking into account legacy users if product is PREMIUM.
 */
export async function countUniqueActiveProductMembers(productId, client = pool) {
  const prod = await getProductById(productId, client);
  if (!prod) return 0;

  const res = await client.query(
    `SELECT DISTINCT user_id FROM user_product_grants
     WHERE product_id = $1
       AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())`,
    [productId]
  );
  const userIds = new Set(res.rows.map(r => Number(r.user_id)));

  if (prod.code === 'PREMIUM') {
    const legacy = await client.query(
      `SELECT id FROM users WHERE app_role = 'PREMIUM'`
    );
    legacy.rows.forEach(r => userIds.add(Number(r.id)));
  }

  return userIds.size;
}

/**
 * Batched version of countUniqueActiveProductMembers — replaces N sequential queries with one grouped query.
 * Preserves COUNT(DISTINCT user_id) semantics, PREMIUM legacy union (Set), zero-member products, and ordering.
 * Returns Map/productId->count equivalent to calling countUniqueActiveProductMembers per product.
 */
export async function countUniqueActiveProductMembersBatch(products, client = pool) {
  const map = new Map();
  if (!products || products.length === 0) return map;
  const productIds = products.map(p => Number(p.id)).filter(id => Number.isFinite(id));
  if (productIds.length === 0) return map;
  // Default 0 for all products (preserves zero-member case)
  for (const p of products) map.set(Number(p.id), 0);
  // One grouped query for grant-based distinct members
  const grouped = await client.query(
    `SELECT product_id, COUNT(DISTINCT user_id)::int AS cnt
     FROM user_product_grants
     WHERE product_id = ANY($1::bigint[])
       AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())
     GROUP BY product_id`,
    [productIds]
  );
  for (const row of grouped.rows) {
    map.set(Number(row.product_id), Number(row.cnt));
  }
  // PREMIUM legacy union — must mirror original Set union, not simple sum
  for (const prod of products) {
    if (prod.code === 'PREMIUM') {
      const pid = Number(prod.id);
      const grantRes = await client.query(
        `SELECT DISTINCT user_id FROM user_product_grants
         WHERE product_id = $1
           AND status = 'active'
           AND (valid_until IS NULL OR valid_until > NOW())`,
        [pid]
      );
      const userIds = new Set(grantRes.rows.map(r => Number(r.user_id)));
      const legacy = await client.query(`SELECT id FROM users WHERE app_role = 'PREMIUM'`);
      legacy.rows.forEach(r => userIds.add(Number(r.id)));
      map.set(pid, userIds.size);
    }
  }
  return map;
}

/**
 * Checks if a user is currently an active member of a product.
 */
export async function isUserActiveMemberOfProduct(userId, productId, client = pool) {
  if (!userId || !productId) return false;

  const grantsRes = await client.query(
    `SELECT 1 FROM user_product_grants
     WHERE user_id = $1 AND product_id = $2 AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())
     LIMIT 1`,
    [userId, productId]
  );
  if (grantsRes.rowCount > 0) return true;

  const prod = await getProductById(productId, client);
  if (prod && prod.code === 'PREMIUM') {
    const userRes = await client.query(
      `SELECT app_role FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows[0]?.app_role === 'PREMIUM') return true;
  }
  return false;
}

/**
 * Validates offering capacity and throws an error if at capacity.
 */
export async function verifyAndEnforceCapacity(userId, productId, client = pool) {
  if (!productId) return;

  // Lock the product row FOR UPDATE to ensure concurrency-safe checks
  const prodRes = await client.query(
    `SELECT id, code, name, max_active_members FROM paid_products WHERE id = $1 FOR UPDATE`,
    [productId]
  );
  const product = prodRes.rows[0];
  if (!product) return;

  const limit = product.max_active_members;
  if (limit === null || limit === undefined) {
    return; // Unlimited
  }

  // If user is already active, renewing/adding plans does not consume a new slot
  const isCurrentlyActive = await isUserActiveMemberOfProduct(userId, productId, client);
  if (isCurrentlyActive) {
    return;
  }

  const currentCount = await countUniqueActiveProductMembers(productId, client);
  if (currentCount >= limit) {
    throw new Error('This offering is currently at capacity and new memberships are temporarily unavailable.');
  }
}

/**
 * Counts the number of active entitlements for a plan.
 */
export async function countActivePlanGrants(planId, client = pool) {
  const res = await client.query(
    `SELECT COUNT(*)::integer AS count FROM user_product_grants
     WHERE plan_id = $1
       AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())`,
    [planId]
  );
  return res.rows[0].count;
}

/**
 * Updates a product's enabled status.
 */
export async function setProductEnabled(productId, isEnabled, client = pool) {
  const current = await getProductById(productId, client);
  if (!current) return null;

  if (current.is_enabled && !isEnabled) {
    const activeGrantsCount = await countActiveProductGrants(productId, client);
    if (activeGrantsCount > 0) {
      throw new Error('Cannot disable product because there are active user entitlements depending on it.');
    }
  }

  const res = await client.query(
    `UPDATE paid_products 
     SET is_enabled = $1, updated_at = NOW() 
     WHERE id = $2 
     RETURNING *`,
    [isEnabled, productId]
  );
  return res.rows[0] || null;
}

/**
 * Updates a plan's active status.
 */
export async function setPlanActive(planId, isActive, client = pool) {
  const current = await getPlanById(planId, client);
  if (!current) return null;

  if (current.is_active && !isActive) {
    const activeGrantsCount = await countActivePlanGrants(planId, client);
    if (activeGrantsCount > 0) {
      throw new Error('Cannot disable plan because there are active user entitlements depending on it.');
    }
  }

  const res = await client.query(
    `UPDATE paid_product_plans 
     SET is_active = $1, updated_at = NOW() 
     WHERE id = $2 
     RETURNING *`,
    [isActive, planId]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves a plan by its primary key ID.
 */
export async function getPlanById(planId, client = pool) {
  if (!planId) return null;
  if (isNaN(Number(planId))) return null;
  const res = await client.query(
    `SELECT * FROM paid_product_plans WHERE id = $1`,
    [planId]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves all available roles.
 */
export async function getAllRoles(client = pool) {
  const res = await client.query(
    `SELECT id, name, description FROM roles ORDER BY name ASC`
  );
  return res.rows;
}

/**
 * Creates a new paid product.
 */
export async function createPaidProduct({ code, name, description = '', role_id, is_enabled = true, max_active_members = null }, client = pool) {
  if (!code || !name || !role_id) {
    throw new Error('Code, name, and role are required fields.');
  }
  // Prevent duplicate product code
  const existing = await getProductByCode(code, client);
  if (existing) {
    throw new Error(`Product code "${code}" already exists.`);
  }

  let parsedLimit = null;
  if (max_active_members !== null && max_active_members !== undefined && max_active_members !== '') {
    const parsed = parseInt(max_active_members, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      parsedLimit = parsed;
    }
  }

  const res = await client.query(
    `INSERT INTO paid_products (code, name, description, role_id, is_enabled, max_active_members, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, NOW(), NOW())
     RETURNING *`,
    [code.trim().toUpperCase(), name.trim(), description.trim(), role_id, is_enabled, parsedLimit]
  );
  return res.rows[0] || null;
}

/**
 * Updates an existing paid product.
 */
export async function updatePaidProduct(productId, { name, description = '', role_id, is_enabled, max_active_members = null }, client = pool) {
  if (!productId || !name || !role_id) {
    throw new Error('Product ID, name, and role are required fields.');
  }

  const current = await getProductById(productId, client);
  if (!current) {
    throw new Error('Product not found.');
  }

  // Guard: Prevent changing role_id if there are active entitlements
  if (Number(current.role_id) !== Number(role_id)) {
    const activeGrantsCount = await countActiveProductGrants(productId, client);
    if (activeGrantsCount > 0) {
      throw new Error('Cannot change the mapped RBAC role because there are currently active user grants depending on this product\'s current role.');
    }
  }

  // Guard: Prevent disabling product if there are active entitlements
  if (current.is_enabled && !is_enabled) {
    const activeGrantsCount = await countActiveProductGrants(productId, client);
    if (activeGrantsCount > 0) {
      throw new Error('Cannot disable product because there are active user entitlements depending on it.');
    }
  }

  let parsedLimit = null;
  if (max_active_members !== null && max_active_members !== undefined && max_active_members !== '') {
    const parsed = parseInt(max_active_members, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      parsedLimit = parsed;
    }
  }

  const res = await client.query(
    `UPDATE paid_products
     SET name = $1, description = $2, role_id = $3, is_enabled = $4, max_active_members = $5, updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [name.trim(), description.trim(), role_id, is_enabled, parsedLimit, productId]
  );
  return res.rows[0] || null;
}

/**
 * Deletes an existing paid product.
 */
export async function deletePaidProduct(productId, client = pool) {
  if (!productId) {
    throw new Error('Product ID is required.');
  }

  const current = await getProductById(productId, client);
  if (!current) {
    throw new Error('Product not found.');
  }

  if (current.metadata && (current.metadata.is_system === true || current.metadata.is_system === 'true' || current.metadata.protected === true || current.metadata.protected === 'true')) {
    throw new Error('Protected/system products cannot be deleted.');
  }
  
  if (current.code && (current.code.toLowerCase() === 'premium' || current.code.toLowerCase() === 'system')) {
     throw new Error('Protected/system products cannot be deleted.');
  }

  // 1. All plans must be deactivated first
  const plansRes = await client.query('SELECT * FROM paid_product_plans WHERE product_id = $1', [productId]);
  const plans = plansRes.rows;
  if (plans && plans.some(p => p.is_active)) {
    throw new Error('Cannot delete product: All plans must be deactivated first.');
  }

  // 2. Product must be disabled
  if (current.is_enabled) {
    throw new Error('Cannot delete product: Product must be disabled first.');
  }

  // 3. Block if there are active entitlements
  const activeGrantsCount = await countActiveProductGrants(productId, client);
  if (activeGrantsCount > 0) {
    throw new Error('Cannot delete product: There are active user entitlements depending on it.');
  }

  // Delete product (plans will cascade based on ON DELETE CASCADE, but let's be safe or just let DB cascade)
  const res = await client.query(
    `DELETE FROM paid_products
     WHERE id = $1
     RETURNING *`,
    [productId]
  );
  return res.rows[0] || null;
}

/**
 * Creates a new product plan.
 */
export async function createPaidProductPlan({
  product_id,
  code,
  name,
  billing_type,
  price_amount_paise,
  currency = 'INR',
  duration_days = null,
  razorpay_plan_id = null,
  is_active = true
}, client = pool) {
  if (!product_id || !code || !name || !billing_type || price_amount_paise === undefined) {
    throw new Error('Product ID, code, name, billing type, and price are required fields.');
  }
  if (!['recurring', 'one_time'].includes(billing_type)) {
    throw new Error('Invalid billing type. Must be either recurring or one_time.');
  }
  if (price_amount_paise < 0) {
    throw new Error('Price cannot be negative.');
  }

  // Guard: Validate recurring plans require a Razorpay Plan ID
  if (billing_type === 'recurring' && (!razorpay_plan_id || !razorpay_plan_id.trim())) {
    throw new Error('Recurring plans require a Razorpay Plan ID.');
  }
  // Guard: Validate one-time plans require duration_days
  if (billing_type === 'one_time' && (duration_days === null || duration_days === undefined || duration_days === '')) {
    throw new Error('One-time plans require duration in days.');
  }

  // Prevent duplicate plan code for the same product
  const existing = await getPlanByCode(product_id, code, client);
  if (existing) {
    throw new Error(`Plan code "${code}" already exists for this product.`);
  }

  const res = await client.query(
    `INSERT INTO paid_product_plans (
       product_id, code, name, billing_type, price_amount_paise, currency, duration_days, razorpay_plan_id, is_active, metadata, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, NOW(), NOW())
     RETURNING *`,
    [
      product_id,
      code.trim().toLowerCase(),
      name.trim(),
      billing_type,
      price_amount_paise,
      currency.trim().toUpperCase(),
      duration_days,
      razorpay_plan_id ? razorpay_plan_id.trim() : null,
      is_active
    ]
  );
  return res.rows[0] || null;
}

/**
 * Updates an existing product plan.
 */
export async function updatePaidProductPlan(planId, {
  name,
  billing_type,
  price_amount_paise,
  currency = 'INR',
  duration_days = null,
  razorpay_plan_id = null,
  is_active = true
}, client = pool) {
  if (!planId || !name || !billing_type || price_amount_paise === undefined) {
    throw new Error('Plan ID, name, billing type, and price are required.');
  }
  if (!['recurring', 'one_time'].includes(billing_type)) {
    throw new Error('Invalid billing type. Must be either recurring or one_time.');
  }
  if (price_amount_paise < 0) {
    throw new Error('Price cannot be negative.');
  }

  const current = await getPlanById(planId, client);
  if (!current) {
    throw new Error('Plan not found.');
  }

  // Guard: Validate recurring plans require a Razorpay Plan ID
  if (billing_type === 'recurring' && (!razorpay_plan_id || !razorpay_plan_id.trim())) {
    throw new Error('Recurring plans require a Razorpay Plan ID.');
  }
  // Guard: Validate one-time plans require duration_days
  if (billing_type === 'one_time' && (duration_days === null || duration_days === undefined || duration_days === '')) {
    throw new Error('One-time plans require duration in days.');
  }

  // Guard: Prevent disabling plan if there are active entitlements
  if (current.is_active && !is_active) {
    const activeGrantsCount = await countActivePlanGrants(planId, client);
    if (activeGrantsCount > 0) {
      throw new Error('Cannot disable plan because there are active user entitlements depending on it.');
    }
  }

  const res = await client.query(
    `UPDATE paid_product_plans
     SET name = $1,
         billing_type = $2,
         price_amount_paise = $3,
         currency = $4,
         duration_days = $5,
         razorpay_plan_id = $6,
         is_active = $7,
         updated_at = NOW()
     WHERE id = $8
     RETURNING *`,
    [
      name.trim(),
      billing_type,
      price_amount_paise,
      currency.trim().toUpperCase(),
      duration_days,
      razorpay_plan_id ? razorpay_plan_id.trim() : null,
      is_active,
      planId
    ]
  );
  return res.rows[0] || null;
}

// ── 2. Paid Orders Lifecycle ──────────────────────────────────────────────────

/**
 * Creates an immutable order record in status 'created'.
 */
export async function createPaidOrder({
  userId,
  productId,
  planId = null,
  amountPaise,
  currency = 'INR',
  provider = 'razorpay',
  providerOrderId = null,
  promoCode = null,
  discountPaise = 0,
  metadata = {}
}, client = pool) {
  if (!userId || !productId || amountPaise == null) {
    throw new Error('userId, productId, and amountPaise are required to create a paid order');
  }

  const res = await client.query(
    `INSERT INTO paid_orders (
       user_id, product_id, plan_id, amount_paise, currency, status,
       provider, provider_order_id, promo_code, discount_paise, metadata,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $9, $10, NOW(), NOW())
     RETURNING *`,
    [
      userId,
      productId,
      planId,
      amountPaise,
      currency,
      provider,
      providerOrderId,
      promoCode,
      discountPaise,
      JSON.stringify(metadata)
    ]
  );
  return res.rows[0];
}

/**
 * Updates order status to 'paid', 'failed', or 'refunded'.
 */
export async function updatePaidOrderStatus(orderId, {
  status,
  providerPaymentId = null,
  metadata = null
}, client = pool) {
  const allowed = ['created', 'paid', 'failed', 'refunded'];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid order status: ${status}`);
  }

  const setClauses = ['status = $2', 'updated_at = NOW()'];
  const params = [orderId, status];
  let paramIdx = 3;

  if (providerPaymentId != null) {
    setClauses.push(`provider_payment_id = $${paramIdx++}`);
    params.push(providerPaymentId);
  }
  if (metadata != null) {
    setClauses.push(`metadata = metadata || $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(metadata));
  }

  const res = await client.query(
    `UPDATE paid_orders
     SET ${setClauses.join(', ')}
     WHERE id = $1
     RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

// ── 3. Paid Subscriptions Lifecycle ───────────────────────────────────────────

/**
 * Upserts a recurring subscription agreement record.
 */
export async function upsertPaidSubscription({
  userId,
  productId,
  planId = null,
  provider = 'razorpay',
  providerCustomerId = null,
  providerSubscriptionId,
  status,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  cancelledAt = null,
  metadata = {}
}, client = pool) {
  if (!userId || !productId || !providerSubscriptionId || !status) {
    throw new Error('userId, productId, providerSubscriptionId, and status are required');
  }

  const res = await client.query(
    `INSERT INTO paid_subscriptions (
       user_id, product_id, plan_id, provider, provider_customer_id,
       provider_subscription_id, status, current_period_start, current_period_end,
       cancel_at_period_end, cancelled_at, metadata, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      ON CONFLICT (provider_subscription_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        product_id = EXCLUDED.product_id,
        plan_id = COALESCE(EXCLUDED.plan_id, paid_subscriptions.plan_id),
        provider = EXCLUDED.provider,
        provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, paid_subscriptions.provider_customer_id),
        status = EXCLUDED.status,
        current_period_start = COALESCE(EXCLUDED.current_period_start, paid_subscriptions.current_period_start),
        current_period_end = COALESCE(EXCLUDED.current_period_end, paid_subscriptions.current_period_end),
        cancel_at_period_end = paid_subscriptions.cancel_at_period_end OR EXCLUDED.cancel_at_period_end,
        cancelled_at = COALESCE(EXCLUDED.cancelled_at, paid_subscriptions.cancelled_at),
        metadata = paid_subscriptions.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`,
     [
       userId,
       productId,
      planId,
      provider,
      providerCustomerId,
      providerSubscriptionId,
      status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      cancelledAt,
      JSON.stringify(metadata)
    ]
  );
  return res.rows[0];
}

// ── 4. Append-Only Entitlement Grants (user_product_grants) ────────────────────

/**
 * Creates an append-only grant. Allows multiple concurrent/stacked grants per user.
 */
export async function createUserProductGrant({
  userId,
  productId,
  planId = null,
  grantType,
  status = 'active',
  validFrom = new Date(),
  validUntil = null,
  orderId = null,
  subscriptionId = null,
  grantedByUserId = null,
  grantReason = null,
  metadata = {}
}, client = pool) {
  if (!userId || !productId || !grantType) {
    throw new Error('userId, productId, and grantType are required for grant creation');
  }

  if (status === 'active') {
    await verifyAndEnforceCapacity(userId, productId, client);
  }

  const res = await client.query(
    `INSERT INTO user_product_grants (
       user_id, product_id, plan_id, grant_type, status,
       valid_from, valid_until, order_id, subscription_id,
       granted_by_user_id, grant_reason, metadata, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     RETURNING *`,
    [
      userId,
      productId,
      planId,
      grantType,
      status,
      validFrom,
      validUntil,
      orderId,
      subscriptionId,
      grantedByUserId,
      grantReason,
      JSON.stringify(metadata)
    ]
  );
  return res.rows[0];
}

/**
 * Updates status of existing grant (e.g. mark expired, revoked, superseded).
 */
export async function updateGrantStatus(grantId, status, client = pool) {
  const allowed = ['active', 'expired', 'revoked', 'superseded'];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid grant status: ${status}`);
  }
  const res = await client.query(
    `UPDATE user_product_grants
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [grantId, status]
  );
  return res.rows[0] || null;
}

/**
 * Fetches all active grants for a specific user and product.
 */
export async function getActiveGrants(userId, productId, client = pool) {
  const res = await client.query(
    `SELECT * FROM user_product_grants
     WHERE user_id = $1
       AND product_id = $2
       AND status = 'active'
       AND (valid_until IS NULL OR valid_until > NOW())
     ORDER BY valid_until DESC NULLS FIRST, created_at DESC`,
    [userId, productId]
  );
  return res.rows;
}

// ── 5. Generic Entitlement Validation ─────────────────────────────────────────

/**
 * Checks if a user has an active entitlement for a given product.
 * Returns: {
 *   hasEntitlement: boolean,
 *   furthestExpiry: Date | null (null means indefinite/lifetime),
 *   activeGrants: Array,
 *   primaryGrantType: 'subscription_cycle' | 'one_time_purchase' | 'manual' | 'promotion' | null
 * }
 */
export async function validateUserEntitlement(userId, productCodeOrId, client = pool) {
  let productId = productCodeOrId;
  
  if (typeof productCodeOrId === 'string' && isNaN(Number(productCodeOrId))) {
    const p = await getProductByCode(productCodeOrId, client);
    if (!p) {
      return { hasEntitlement: false, furthestExpiry: null, activeGrants: [], primaryGrantType: null };
    }
    productId = p.id;
  } else if (typeof productCodeOrId === 'string') {
    // It's a string, but it's numeric (e.g. from postgres bigint)
    // Attempt to verify it exists as an ID first, fallback to code if needed
    const p = await getProductById(productCodeOrId, client);
    if (p) {
      productId = p.id;
    } else {
      const pCode = await getProductByCode(productCodeOrId, client);
      if (!pCode) {
        return { hasEntitlement: false, furthestExpiry: null, activeGrants: [], primaryGrantType: null };
      }
      productId = pCode.id;
    }
  }

  const grants = await getActiveGrants(userId, productId, client);
  if (grants.length === 0) {
    // If product is PREMIUM, fallback to check legacy tables for seamless backward compatibility
    try {
      let isPremiumProduct = false;
      if (typeof productCodeOrId === 'string' && productCodeOrId.toUpperCase() === 'PREMIUM') {
        isPremiumProduct = true;
      } else {
        const prod = await getProductById(productId, client);
        if (prod?.code === 'PREMIUM') isPremiumProduct = true;
      }

      if (isPremiumProduct) {
        // Grants are source of truth for all products (including PREMIUM).
        // If any grant exists for this product, do not revive via subscription.
        const anyGrantCheck = await client.query(
          'SELECT 1 FROM user_product_grants WHERE user_id = $1 AND product_id = $2 LIMIT 1',
          [userId, productId]
        );
        if (anyGrantCheck.rowCount > 0) {
          return { hasEntitlement: false, furthestExpiry: null, activeGrants: [], primaryGrantType: null };
        }

        const userRes = await client.query('SELECT status, access_expires_at, premium_source FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user || user.status === 'expired' || (user.access_expires_at && new Date(user.access_expires_at) <= new Date())) {
          return { hasEntitlement: false, furthestExpiry: null, activeGrants: [], primaryGrantType: null };
        }
        const subRes = await client.query(
          "SELECT id, current_period_end FROM premium_subscriptions WHERE user_id = $1 AND status IN ('active', 'authenticated') AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1",
          [userId]
        );
        const paidSubRes = await client.query(
          "SELECT id, current_period_end FROM paid_subscriptions WHERE user_id = $1 AND product_id = $2 AND status IN ('active', 'authenticated') AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1",
          [userId, productId]
        );
        const hasSub = subRes.rowCount > 0 || paidSubRes.rowCount > 0;
        const activeSubRow = subRes.rows[0] || paidSubRes.rows[0];
        const isLegacyValid = user && user.premium_source === 'one_time' && user.access_expires_at && new Date(user.access_expires_at) > new Date();
        if (isLegacyValid) {
          const legacyExpiry = hasSub && activeSubRow?.current_period_end
            ? new Date(activeSubRow.current_period_end)
            : (user?.access_expires_at ? new Date(user.access_expires_at) : null);
          return {
            hasEntitlement: true,
            furthestExpiry: legacyExpiry,
            activeGrants: [],
            primaryGrantType: hasSub ? 'subscription_cycle' : 'one_time_purchase'
          };
        }
      }
    } catch {}

    return { hasEntitlement: false, furthestExpiry: null, activeGrants: [], primaryGrantType: null };
  }

  // Check if any grant is lifetime/indefinite
  const hasLifetime = grants.some(g => g.valid_until === null);
  let furthestExpiry = null;
  if (!hasLifetime) {
    const dates = grants
      .filter(g => g.valid_until != null)
      .map(g => new Date(g.valid_until).getTime());
    furthestExpiry = dates.length > 0 ? new Date(Math.max(...dates)) : null;
  }

  // Primary grant type preference: subscription_cycle > one_time_purchase > manual > promotion
  const typeOrder = ['subscription_cycle', 'one_time_purchase', 'manual', 'promotion'];
  let primaryGrantType = null;
  for (const t of typeOrder) {
    if (grants.some(g => g.grant_type === t)) {
      primaryGrantType = t;
      break;
    }
  }

  return {
    hasEntitlement: true,
    furthestExpiry,
    activeGrants: grants,
    primaryGrantType
  };
}

// ── 6. Product-Scoped Payment-Managed RBAC Synchronization ─────────────────────

/**
 * Synchronizes user_roles for a specific product and user based on verified entitlement.
 * 
 * Strict Guarantees:
 * 1. OWNER and ADMIN:
 *    - Never modified, never revoked.
 *    - If an admin holds the role, assignment_source remains 'manual'.
 * 2. Manual Assignments:
 *    - If user has the role with assignment_source = 'manual', it is NEVER revoked by payment sync,
 *      even if no active payment entitlement exists.
 * 3. Payment-Managed Assignments:
 *    - When entitlement is active and role is missing, assigns role with assignment_source = 'payment_system'.
 *    - When entitlement is active and role exists with 'payment_system', no-op (preserved).
 *    - When entitlement has expired and role has assignment_source = 'payment_system', role is revoked.
 * 
 * @returns {Promise<{
 *   action: 'granted' | 'revoked' | 'preserved_manual' | 'skipped_protected' | 'no_change' | 'error',
 *   productCode: string,
 *   roleId: number,
 *   assignmentSource: 'manual' | 'payment_system' | null
 * }>}
 */

/**
 * Evaluates the latest valid_until among active product grants and updates users.access_expires_at.
 * If expired user gets an active product, activates the user and manages Active/Expired roles.
 */
export async function syncUserAccessExpiry(userId, client = pool) {
  // 0. Reactivate expired grants that have been extended beyond NOW (admin/backend extension)
  await client.query(
    `UPDATE user_product_grants
     SET status = 'active', updated_at = NOW()
     WHERE user_id = $1
       AND status = 'expired'
       AND valid_until IS NOT NULL
       AND valid_until > NOW()`,
    [userId]
  );

  // 1. Auto-expire stale active grants for this user to keep records synchronized
  await client.query(
    `UPDATE user_product_grants
     SET status = 'expired', updated_at = NOW()
     WHERE user_id = $1
       AND status = 'active'
       AND valid_until IS NOT NULL
       AND valid_until <= NOW()`,
    [userId]
  );

  // 2. Find the max valid_until among all active, non-expired grants
  const res = await client.query(
    `SELECT valid_until 
     FROM user_product_grants 
     WHERE user_id = $1 
       AND status = 'active' 
       AND (valid_until IS NULL OR valid_until > NOW())
     ORDER BY valid_until DESC NULLS FIRST 
     LIMIT 1`, 
    [userId]
  );
  
  let newExpiry = null;
  let hasActiveGrants = false;

  if (res.rowCount > 0) {
     const latestGrant = res.rows[0];
     newExpiry = latestGrant.valid_until; // could be null if lifetime
     hasActiveGrants = true;
  }
  
  const userRes = await client.query('SELECT status, access_expires_at FROM users WHERE id = $1', [userId]);
  if (userRes.rowCount === 0) return;
  const user = userRes.rows[0];
  
  if (hasActiveGrants) {
    // Update access_expires_at
    await client.query(
      `UPDATE users SET access_expires_at = $2, updated_at = NOW() WHERE id = $1`,
      [userId, newExpiry]
    );
    
    // If user was expired but now has a valid expiry (or lifetime), activate them
    const isFuture = newExpiry === null || new Date(newExpiry) > new Date();
    if (user.status === 'expired' && isFuture) {
      await client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
      const { assignActiveRoleToUser } = await import('./users.js');
      await assignActiveRoleToUser(client, userId);
    }
  } else {
    // Zero active grants left: transition to expired state.
    const { assignExpiredRoleToUser } = await import('./users.js');
    await client.query(`UPDATE users SET status = 'expired', access_expires_at = NULL, updated_at = NOW() WHERE id = $1`, [userId]);
    await assignExpiredRoleToUser(client, userId);

    // Revoke paid-product RBAC roles/folder access through the existing role-sync flow.
    try {
      const products = await getAllProductsWithRoles(client);
      for (const prod of products) {
        if (prod.code === 'PREMIUM') {
          const { syncUserPremiumRole } = await import('./premium.js');
          await syncUserPremiumRole(userId, client);
        } else {
          await syncProductRbacRole(userId, prod.id, client);
        }
      }
    } catch (syncErr) {
      console.error('Error syncing roles on user access expiry:', syncErr);
    }
  }
}

export async function syncProductRbacRole(userId, productCodeOrId, client = pool) {
  // 1. Resolve product
  let product = null;
  if (typeof productCodeOrId === 'string' && isNaN(Number(productCodeOrId))) {
    product = await getProductByCode(productCodeOrId, client);
  } else {
    product = await getProductById(productCodeOrId, client);
    if (!product && typeof productCodeOrId === 'string') {
      product = await getProductByCode(productCodeOrId, client);
    }
  }
  if (!product) {
    return { action: 'error', error: 'Product not found' };
  }

  // 2. Fetch user to verify protections
  const userRes = await client.query(
    'SELECT id, email, app_role FROM users WHERE id = $1',
    [userId]
  );
  if (userRes.rowCount === 0) {
    return { action: 'error', error: 'User not found' };
  }
  const user = userRes.rows[0];

  // 3. OWNER / ADMIN protection check
  const isProtectedUser = user.app_role === ROLES.OWNER || user.app_role === ROLES.ADMIN;
  if (isProtectedUser) {
    return {
      action: 'skipped_protected',
      productCode: product.code,
      roleId: Number(product.role_id),
      assignmentSource: 'manual'
    };
  }

  // 4. Validate current entitlement status
  const entitlement = await validateUserEntitlement(userId, product.id, client);
  const hasEntitlement = entitlement.hasEntitlement;

  // 5. Inspect existing user_role assignment
  const roleCheck = await client.query(
    'SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = $1 AND role_id = $2',
    [userId, product.role_id]
  );
  const existingRole = roleCheck.rows[0] || null;

  // Case A: User has active entitlement
  if (hasEntitlement) {
    if (!existingRole) {
      // Grant role with payment_system source
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assignment_source) 
         VALUES ($1, $2, 'payment_system')
         ON CONFLICT (user_id, role_id) DO UPDATE SET assignment_source = 'payment_system'`,
        [userId, product.role_id]
      );
      return {
        action: 'granted',
        productCode: product.code,
        roleId: Number(product.role_id),
        assignmentSource: 'payment_system'
      };
    }

    // Role already exists
    if (existingRole.assignment_source === 'manual') {
      // Manual assignment is preserved
      return {
        action: 'preserved_manual',
        productCode: product.code,
        roleId: Number(product.role_id),
        assignmentSource: 'manual'
      };
    }

    return {
      action: 'no_change',
      productCode: product.code,
      roleId: Number(product.role_id),
      assignmentSource: 'payment_system'
    };
  }

  // Case B: User has NO active entitlement
  if (existingRole) {
    if (existingRole.assignment_source === 'manual') {
      // Crucial: Manual assignment is protected from automated payment revocation
      return {
        action: 'preserved_manual',
        productCode: product.code,
        roleId: Number(product.role_id),
        assignmentSource: 'manual'
      };
    }

    // Role was granted by payment_system and is now expired -> revoke
    await client.query(
      'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 AND assignment_source = $3',
      [userId, product.role_id, 'payment_system']
    );
    return {
      action: 'revoked',
      productCode: product.code,
      roleId: Number(product.role_id),
      assignmentSource: 'payment_system'
    };
  }

  // No role, no entitlement -> clean state
  return {
    action: 'no_change',
    productCode: product.code,
    roleId: Number(product.role_id),
    assignmentSource: null
  };
}

// ── 7. Audit Logging ──────────────────────────────────────────────────────────

/**
 * Appends an audit event to paid_product_events.
 */
export async function logPaidProductEvent({
  productId = null,
  userId = null,
  entitlementId = null,
  eventType,
  providerEventId = null,
  previousStatus = null,
  newStatus = null,
  message = null,
  payload = {}
}, client = pool) {
  if (!eventType) throw new Error('eventType is required');
  const res = await client.query(
    `INSERT INTO paid_product_events (
       product_id, user_id, entitlement_id, event_type, provider_event_id,
       previous_status, new_status, message, payload, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING *`,
    [
      productId,
      userId,
      entitlementId,
      eventType,
      providerEventId,
      previousStatus,
      newStatus,
      message,
      JSON.stringify(payload)
    ]
  );
  return res.rows[0];
}

// ── 8. Dedicated Premium Integration Helpers (Phase 2B) ───────────────────────

/**
 * Connects verified one-time payment to generic paid product framework:
 * - Records/updates paid_orders with status 'paid'
 * - Creates append-only grant in user_product_grants with grant_type 'one_time_purchase'
 * - Logs audit event in paid_product_events
 * - Synchronizes RBAC role through generic framework (syncProductRbacRole)
 * - Safe and idempotent: prevents duplicate grants for the same payment/order
 */
export async function recordOneTimePremiumPayment({
  userId,
  orderId,
  paymentId,
  amountPaise,
  currency = 'INR',
  promoCode = null,
  discountPaise = 0,
  validUntil = null,
  metadata = {}
}, client = pool) {
  try {
    const product = await getProductByCode('PREMIUM', client);
    if (!product) return null;

    let plan = await getPlanByCode(product.id, 'one_time_pass', client);
    if (!plan) plan = await getPlanByCode(product.id, 'one_time', client);
    const durationDays = plan?.duration_days || parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
    const finalValidUntil = validUntil || new Date(Date.now() + durationDays * 24 * 3600 * 1000);

    // 1. Check or create paid_orders
    let orderRow = null;
    const orderCheck = await client.query(
      `SELECT * FROM paid_orders WHERE provider = 'razorpay' AND provider_order_id = $1`,
      [orderId]
    );

    if (orderCheck.rowCount > 0) {
      orderRow = orderCheck.rows[0];
      if (orderRow.status !== 'paid') {
        const upd = await client.query(
          `UPDATE paid_orders 
           SET status = 'paid', provider_payment_id = $2, updated_at = NOW(),
               metadata = metadata || $3::jsonb
           WHERE id = $1 RETURNING *`,
          [orderRow.id, paymentId, JSON.stringify({ verified_at: new Date(), ...metadata })]
        );
        orderRow = upd.rows[0];
      }
    } else {
      const ins = await client.query(
        `INSERT INTO paid_orders (
           user_id, product_id, plan_id, amount_paise, currency, status,
           provider, provider_order_id, provider_payment_id, promo_code, discount_paise, metadata,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'paid', 'razorpay', $6, $7, $8, $9, $10, NOW(), NOW())
         RETURNING *`,
        [
          userId,
          product.id,
          plan?.id || null,
          amountPaise,
          currency,
          orderId,
          paymentId,
          promoCode,
          discountPaise,
          JSON.stringify(metadata)
        ]
      );
      orderRow = ins.rows[0];
    }

    // 2. Idempotency: Grant check
    const grantCheck = await client.query(
      `SELECT * FROM user_product_grants 
       WHERE (order_id = $1 OR (metadata->>'provider_payment_id' = $2)) AND product_id = $3`,
      [orderRow.id, paymentId, product.id]
    );

    let grantRow = null;
    if (grantCheck.rowCount > 0) {
      grantRow = grantCheck.rows[0];
    } else {
      await verifyAndEnforceCapacity(userId, product.id, client);
      const insGrant = await client.query(
        `INSERT INTO user_product_grants (
           user_id, product_id, plan_id, grant_type, status,
           valid_from, valid_until, order_id, grant_reason, metadata,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, 'one_time_purchase', 'active', NOW(), $4, $5, 'Verified one-time Premium payment', $6, NOW(), NOW())
         RETURNING *`,
        [
          userId,
          product.id,
          plan?.id || null,
          finalValidUntil,
          orderRow.id,
          JSON.stringify({
            provider_order_id: orderId,
            provider_payment_id: paymentId,
            promo_code: promoCode,
            ...metadata
          })
        ]
      );
      grantRow = insGrant.rows[0];

      // 3. Log audit event
      try {
        await client.query(
          `INSERT INTO paid_product_events (
             product_id, user_id, entitlement_id, event_type, provider_event_id,
             previous_status, new_status, message, payload, created_at
           )
           VALUES ($1, $2, $3, 'one_time_payment_verified', $4, NULL, 'active', $5, $6, NOW())`,
          [
            product.id,
            userId,
            grantRow.id,
            paymentId,
            `Verified one-time Premium payment. Amount: ${amountPaise} paise.`,
            JSON.stringify({ orderId, paymentId, amountPaise, promoCode })
          ]
        );
      } catch {}
    }

    // 4. Sync RBAC role through generic framework
    await syncProductRbacRole(userId, product.id, client);
    await syncUserAccessExpiry(userId, client);

    return { order: orderRow, grant: grantRow };
  } catch (err) {
    console.warn('recordOneTimePremiumPayment notice:', err.message);
    return null;
  }
}

/**
 * Connects recurring subscription event/payment to generic paid product framework:
 * - Upserts paid_subscriptions agreement
 * - If payment cycle event, records paid_orders and creates subscription-cycle grant
 * - Logs audit event in paid_product_events
 * - Synchronizes RBAC role through generic framework (syncProductRbacRole)
 * - Safe and idempotent: deduplicates cycles by billing period end or payment/invoice id
 */
export async function recordRecurringPremiumSubscriptionEvent({
  userId,
  providerSubscriptionId,
  status,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  paymentId = null,
  invoiceId = null,
  amountPaise = null,
  currency = 'INR',
  promoCode = null,
  eventId = null,
  eventType = null,
  metadata = {}
}, client = pool) {
  try {
    const product = await getProductByCode('PREMIUM', client);
    if (!product) return null;

    let plan = await getPlanByCode(product.id, 'monthly', client);
    if (!plan) plan = await getPlanByCode(product.id, 'recurring_monthly', client);

    // 1. Upsert paid_subscriptions
    const subRes = await client.query(
      `INSERT INTO paid_subscriptions (
         user_id, product_id, plan_id, provider, provider_customer_id,
         provider_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end,
         metadata, created_at, updated_at
       )
       VALUES ($1, $2, $3, 'razorpay', $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (provider_subscription_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_start = COALESCE(EXCLUDED.current_period_start, paid_subscriptions.current_period_start),
         current_period_end = COALESCE(EXCLUDED.current_period_end, paid_subscriptions.current_period_end),
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         metadata = paid_subscriptions.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        userId,
        product.id,
        plan?.id || null,
        metadata?.customer_id || null,
        providerSubscriptionId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        JSON.stringify(metadata)
      ]
    );
    const paidSub = subRes.rows[0];

    // 2. If this is a payment event (charged or active with payment), create paid_orders & grant
    let paidOrderId = null;
    const isPayment = paymentId || eventType === 'subscription.charged' || (status === 'active' && (eventType === 'subscription.activated' || !eventType));

    if (isPayment && paymentId) {
      // Check idempotency for order
      const orderCheck = await client.query(
        `SELECT id FROM paid_orders WHERE provider_payment_id = $1`,
        [paymentId]
      );
      if (orderCheck.rowCount > 0) {
        paidOrderId = orderCheck.rows[0].id;
      } else {
        const defAmount = parseInt(process.env.PREMIUM_MONTHLY_AMOUNT_INR || '300', 10) * 100;
        const insOrder = await client.query(
          `INSERT INTO paid_orders (
             user_id, product_id, plan_id, amount_paise, currency, status,
             provider, provider_order_id, provider_payment_id, promo_code, metadata,
             created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, 'paid', 'razorpay', $6, $7, $8, $9, NOW(), NOW())
           RETURNING id`,
          [
            userId,
            product.id,
            plan?.id || null,
            amountPaise || defAmount,
            currency,
            invoiceId || providerSubscriptionId,
            paymentId,
            promoCode,
            JSON.stringify({ provider_subscription_id: providerSubscriptionId, invoice_id: invoiceId, event_type: eventType })
          ]
        );
        paidOrderId = insOrder.rows[0].id;
      }
    }

    // 3. Grant creation for subscription cycle
    if (isPayment && currentPeriodEnd) {
      // Check idempotency for this cycle/payment
      const grantCheck = await client.query(
        `SELECT id FROM user_product_grants 
         WHERE subscription_id = $1 AND product_id = $2 
           AND (
             (valid_until = $3) OR
             (metadata->>'provider_payment_id' = $4) OR
             (metadata->>'invoice_id' = $5)
           )`,
        [paidSub.id, product.id, currentPeriodEnd, paymentId || '__none__', invoiceId || '__none__']
      );

      if (grantCheck.rowCount === 0) {
        await verifyAndEnforceCapacity(userId, product.id, client);
        await client.query(
          `INSERT INTO user_product_grants (
             user_id, product_id, plan_id, grant_type, status,
             valid_from, valid_until, subscription_id, order_id, grant_reason, metadata,
             created_at, updated_at
           )
           VALUES ($1, $2, $3, 'subscription_cycle', 'active', $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
          [
            userId,
            product.id,
            plan?.id || null,
            currentPeriodStart || new Date(),
            currentPeriodEnd,
            paidSub.id,
            paidOrderId,
            `Subscription cycle payment (${eventType || status})`,
            JSON.stringify({
              provider_subscription_id: providerSubscriptionId,
              provider_payment_id: paymentId,
              invoice_id: invoiceId,
              promo_code: promoCode,
              ...metadata
            })
          ]
        );
      }
    }

    // 4. Log audit event
    try {
      await client.query(
        `INSERT INTO paid_product_events (
           product_id, user_id, entitlement_id, event_type, provider_event_id,
           previous_status, new_status, message, payload, created_at
         )
         VALUES ($1, $2, NULL, $3, $4, NULL, $5, $6, $7, NOW())`,
        [
          product.id,
          userId,
          eventType || `subscription_${status}`,
          eventId || paymentId,
          status,
          `Recurring subscription event: ${status}`,
          JSON.stringify({ providerSubscriptionId, paymentId, currentPeriodEnd })
        ]
      );
    } catch {}

    // 5. Sync RBAC role through generic framework
    await syncProductRbacRole(userId, product.id, client);
    await syncUserAccessExpiry(userId, client);

    return { subscription: paidSub };
  } catch (err) {
    console.warn('recordRecurringPremiumSubscriptionEvent notice:', err.message);
    return null;
  }
}

// ── 9. Generic Paid Product Reconciliation (Phase 2C) ─────────────────────────

/**
 * Reconciles entitlements and payment-managed RBAC for a single product.
 * 
 * Guarantees:
 * - Strictly product-scoped: only touches grants, subscriptions, and user_roles for this product.
 * - Expires stale active grants where valid_until <= NOW().
 * - Expires stale subscriptions where cancel_at_period_end = true and current_period_end <= NOW().
 * - Restores missing payment_system roles when valid entitlement exists.
 * - Revokes payment_system roles when no valid entitlement exists.
 * - Strictly preserves manual user_roles assignments (never revoked or downgraded).
 * - Strictly protects OWNER and ADMIN users (never touched).
 * - Dry-run mode: evaluates without mutating DB state.
 * - Live mode: logs audit event in paid_product_events upon completion.
 * 
 * @param {string | number | object} productCodeOrId - Product code, database ID, or product object
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - If true, evaluates without modifying DB
 * @param {boolean} [opts.allUsers=false] - If true, scans all users; otherwise scans relevant candidates
 * @param {number} [opts.limit=5000] - Max users to evaluate
 * @param {object} [opts.client=pool] - Postgres client or pool
 */
export async function reconcilePaidProduct(productCodeOrId, opts = {}) {
  const client = opts.client || pool;
  const dryRun = !!opts.dryRun;
  const limit = opts.limit ? parseInt(opts.limit, 10) : 5000;
  const allUsers = !!opts.allUsers;

  // 1. Resolve product
  let product = null;
  if (typeof productCodeOrId === 'object' && productCodeOrId !== null) {
    product = productCodeOrId;
  } else if (typeof productCodeOrId === 'string' && isNaN(Number(productCodeOrId))) {
    product = await getProductByCode(productCodeOrId, client);
  } else {
    product = await getProductById(Number(productCodeOrId), client);
    if (!product && typeof productCodeOrId === 'string') {
      product = await getProductByCode(productCodeOrId, client);
    }
  }

  if (!product) {
    return {
      success: false,
      error: 'Product not found'
    };
  }

  const roleId = Number(product.role_id);
  if (!roleId) {
    return {
      success: false,
      error: `Product ${product.code} has no associated role_id`
    };
  }

  // 2. Expire stale grants (valid_until <= NOW())
  let grantsExpired = 0;
  if (dryRun) {
    const checkGrants = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM user_product_grants
       WHERE product_id = $1
         AND status = 'active'
         AND valid_until IS NOT NULL
         AND valid_until <= NOW()`,
      [product.id]
    );
    grantsExpired = checkGrants.rows[0]?.cnt || 0;
  } else {
    const expGrantsRes = await client.query(
      `UPDATE user_product_grants
       SET status = 'expired', updated_at = NOW()
       WHERE product_id = $1
         AND status = 'active'
         AND valid_until IS NOT NULL
         AND valid_until <= NOW()
       RETURNING id, user_id`,
      [product.id]
    );
    grantsExpired = expGrantsRes.rowCount || 0;
  }

  // 3. Expire stale subscriptions past period end
  let subscriptionsExpired = 0;
  if (dryRun) {
    const checkSubs = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM paid_subscriptions
       WHERE product_id = $1
         AND status = 'active'
         AND current_period_end IS NOT NULL
         AND current_period_end <= NOW()`,
      [product.id]
    );
    subscriptionsExpired = checkSubs.rows[0]?.cnt || 0;
  } else {
    const expSubsRes = await client.query(
      `UPDATE paid_subscriptions
       SET status = 'expired', updated_at = NOW()
       WHERE product_id = $1
         AND status = 'active'
         AND current_period_end IS NOT NULL
         AND current_period_end <= NOW()
       RETURNING id, user_id`,
      [product.id]
    );
    subscriptionsExpired = expSubsRes.rowCount || 0;

    if (product.code === 'PREMIUM') {
      await client.query(
        `UPDATE premium_subscriptions
         SET status = 'expired', updated_at = NOW()
         WHERE status IN ('active', 'authenticated')
           AND current_period_end IS NOT NULL
           AND current_period_end <= NOW()`
      );
    }
  }

  // 4. Find candidate users for this product
  const usersRes = await client.query(
    `SELECT DISTINCT u.id, u.app_role, u.email
     FROM users u
     WHERE (
       $4::boolean = TRUE
       OR EXISTS (SELECT 1 FROM user_product_grants g WHERE g.user_id = u.id AND g.product_id = $1)
       OR EXISTS (SELECT 1 FROM paid_subscriptions s WHERE s.user_id = u.id AND s.product_id = $1)
       OR EXISTS (SELECT 1 FROM paid_orders o WHERE o.user_id = u.id AND o.product_id = $1)
       OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = $2)
       OR ($3 = 'PREMIUM' AND (u.premium_source IS NOT NULL OR u.app_role = 'PREMIUM' OR (u.premium_source = 'one_time' AND u.access_expires_at IS NOT NULL AND u.access_expires_at > NOW()) OR EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.user_id = u.id)))
     )
     ORDER BY u.id ASC
     LIMIT $5`,
    [product.id, roleId, product.code, allUsers, limit]
  );

  let checkedUsers = 0;
  let rolesGranted = 0;
  let rolesRevoked = 0;
  let rolesPreservedManual = 0;
  let skippedProtected = 0;
  let rolesUnchanged = 0;
  const errors = [];

  for (const user of usersRes.rows) {
    checkedUsers++;
    try {
      // Protect OWNER and ADMIN users
      if (user.app_role === ROLES.OWNER || user.app_role === ROLES.ADMIN) {
        skippedProtected++;
        continue;
      }

      if (dryRun) {
        // Evaluate entitlement without mutating DB
        const entitlement = await validateUserEntitlement(user.id, product.id, client);
        const hasEntitlement = entitlement.hasEntitlement;

        const roleCheck = await client.query(
          'SELECT user_id, role_id, assignment_source FROM user_roles WHERE user_id = $1 AND role_id = $2',
          [user.id, roleId]
        );
        const existingRole = roleCheck.rows[0] || null;

        if (hasEntitlement) {
          if (!existingRole) {
            rolesGranted++;
          } else if (existingRole.assignment_source === 'manual') {
            rolesPreservedManual++;
          } else {
            rolesUnchanged++;
          }
        } else {
          if (existingRole) {
            if (existingRole.assignment_source === 'manual') {
              rolesPreservedManual++;
            } else if (existingRole.assignment_source === 'payment_system') {
              rolesRevoked++;
            } else {
              rolesPreservedManual++;
            }
          } else {
            rolesUnchanged++;
          }
        }
      } else {
        // Live mode
        if (product.code === 'PREMIUM') {
          const { syncUserPremiumRole } = await import('./premium.js');
          const res = await syncUserPremiumRole(user.id, client);
          if (res?.rbac) {
            const rbacAction = res.rbac.rbacAction;
            if (rbacAction === 'granted') rolesGranted++;
            else if (rbacAction === 'revoked') rolesRevoked++;
            else if (rbacAction === 'preserved_manual') rolesPreservedManual++;
            else if (rbacAction === 'skipped_protected') skippedProtected++;
            else rolesUnchanged++;
          } else {
            if (res?.action === 'granted') rolesGranted++;
            else if (res?.action === 'revoked') rolesRevoked++;
            else if (res?.action === 'preserved_manual') rolesPreservedManual++;
            else rolesUnchanged++;
          }
        } else {
          const res = await syncProductRbacRole(user.id, product.id, client);
          if (res.action === 'granted') rolesGranted++;
          else if (res.action === 'revoked') rolesRevoked++;
          else if (res.action === 'preserved_manual') rolesPreservedManual++;
          else if (res.action === 'skipped_protected') skippedProtected++;
          else if (res.action === 'error') errors.push({ userId: user.id, error: res.error });
          else rolesUnchanged++;
        }
        await syncUserAccessExpiry(user.id, client);
      }
    } catch (userErr) {
      errors.push({ userId: user.id, error: userErr.message });
    }
  }

  // 5. Log audit event if not dry run
  if (!dryRun) {
    try {
      await logPaidProductEvent({
        productId: product.id,
        eventType: 'product_reconciliation_run',
        message: `Reconciliation completed for ${product.code}: ${rolesGranted} granted, ${rolesRevoked} revoked, ${rolesPreservedManual} manual preserved, ${grantsExpired} grants expired, ${checkedUsers} users evaluated.`,
        payload: {
          productCode: product.code,
          productId: product.id,
          roleId,
          dryRun: false,
          checkedUsers,
          grantsExpired,
          subscriptionsExpired,
          rolesGranted,
          rolesRevoked,
          rolesPreservedManual,
          skippedProtected,
          rolesUnchanged,
          errorsCount: errors.length
        }
      }, client);
    } catch (auditErr) {
      console.warn('Reconciliation audit log notice:', auditErr.message);
    }
  }

  return {
    success: true,
    dryRun,
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    roleId,
    checkedUsers,
    grantsExpired,
    subscriptionsExpired,
    rolesGranted,
    rolesRevoked,
    rolesPreservedManual,
    skippedProtected,
    rolesUnchanged,
    errors
  };
}

/**
 * Reconciles all enabled paid products.
 * 
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {number} [opts.limit=5000]
 * @param {object} [opts.client=pool]
 */
export async function reconcileAllPaidProducts(opts = {}) {
  const client = opts.client || pool;
  const dryRun = !!opts.dryRun;

  const productsRes = await client.query(
    'SELECT * FROM paid_products WHERE is_enabled = true ORDER BY id ASC'
  );

  const productResults = [];
  let totalCheckedUsers = 0;
  let totalGrantsExpired = 0;
  let totalSubscriptionsExpired = 0;
  let totalRolesGranted = 0;
  let totalRolesRevoked = 0;
  let totalRolesPreservedManual = 0;
  let totalSkippedProtected = 0;
  let totalRolesUnchanged = 0;
  let totalUsersExpired = 0;
  const allErrors = [];

  try {
    const userStatusRes = await reconcileExpiredUserStatuses({ client, dryRun });
    totalUsersExpired = userStatusRes.usersExpired || 0;
  } catch (err) {
    allErrors.push({ productCode: 'SYSTEM_USER_STATUS', error: err.message });
  }

  for (const prod of productsRes.rows) {
    try {
      const pRes = await reconcilePaidProduct(prod, { ...opts, client });
      productResults.push(pRes);
      if (pRes.success) {
        totalCheckedUsers += pRes.checkedUsers || 0;
        totalGrantsExpired += pRes.grantsExpired || 0;
        totalSubscriptionsExpired += pRes.subscriptionsExpired || 0;
        totalRolesGranted += pRes.rolesGranted || 0;
        totalRolesRevoked += pRes.rolesRevoked || 0;
        totalRolesPreservedManual += pRes.rolesPreservedManual || 0;
        totalSkippedProtected += pRes.skippedProtected || 0;
        totalRolesUnchanged += pRes.rolesUnchanged || 0;
        if (pRes.errors && pRes.errors.length > 0) {
          allErrors.push(...pRes.errors.map(e => ({ productCode: prod.code, ...e })));
        }
      } else {
        allErrors.push({ productCode: prod.code, error: pRes.error });
      }
    } catch (err) {
      allErrors.push({ productCode: prod.code, error: err.message });
    }
  }

  return {
    success: allErrors.length === 0,
    dryRun,
    totalProducts: productsRes.rows.length,
    checkedUsers: totalCheckedUsers,
    grantsExpired: totalGrantsExpired,
    subscriptionsExpired: totalSubscriptionsExpired,
    usersExpired: totalUsersExpired,
    rolesGranted: totalRolesGranted,
    rolesRevoked: totalRolesRevoked,
    rolesPreservedManual: totalRolesPreservedManual,
    skippedProtected: totalSkippedProtected,
    rolesUnchanged: totalRolesUnchanged,
    products: productResults,
    errors: allErrors
  };
}

/**
 * Retrieves a promotion by its code (case-insensitive).
 */
export async function getPromotionByCode(code, client = pool) {
  if (!code || typeof code !== 'string') return null;
  const res = await client.query(
    'SELECT * FROM paid_product_promotions WHERE UPPER(code) = $1',
    [code.trim().toUpperCase()]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

/**
 * Retrieves a promotion by its ID.
 */
export async function getPromotionById(id, client = pool) {
  if (!id) return null;
  const res = await client.query(
    'SELECT * FROM paid_product_promotions WHERE id = $1',
    [id]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

/**
 * Inserts a new database promotion.
 */
export async function createPaidProductPromotion({
  code,
  productId,
  discountType,
  discountValue,
  eligibilityDays = null,
  maxRedemptions = null,
  validFrom = null,
  validUntil = null,
  isEnabled = true,
  recurringOfferId = null,
  showOnPaymentScreen = false
}, client = pool) {
  if (!code || !productId || !discountType || discountValue == null) {
    throw new Error('Code, productId, discountType, and discountValue are required to create a promotion');
  }
  const res = await client.query(
    `INSERT INTO paid_product_promotions (
       code, product_id, discount_type, discount_value, eligibility_days, max_redemptions, valid_from, valid_until, is_enabled, recurring_offer_id, show_on_payment_screen, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
     RETURNING *`,
    [
      code.trim().toUpperCase(),
      productId,
      discountType,
      discountValue,
      eligibilityDays,
      maxRedemptions,
      validFrom,
      validUntil,
      isEnabled,
      recurringOfferId,
      !!showOnPaymentScreen
    ]
  );
  return res.rows[0];
}

/**
 * Validates a promotion code for a specific user, product, and billing type.
 */
export async function validateProductPromotion(userId, code, productId, billingType, client = pool) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }
  const cleanCode = code.trim().toUpperCase();

  // Try to find the promotion in DB
  const promotion = await getPromotionByCode(cleanCode, client);

  if (!promotion) {
    // Fallback: Check environment variables if fallback is applicable (e.g. for PREMIUM)
    const premiumProdRes = await client.query('SELECT id FROM paid_products WHERE code = $1', ['PREMIUM']);
    const premiumProdId = premiumProdRes.rows[0]?.id;
    if (premiumProdId && Number(productId) === Number(premiumProdId)) {
      const json = process.env.PREMIUM_PROMO_CODES_JSON;
      if (json) {
        try {
          const promos = JSON.parse(json);
          const envPromo = promos.find(p => p.code.toUpperCase() === cleanCode);
          if (envPromo) {
            // Environment variable fallback found
            if (envPromo.enabled === false) {
              return { valid: false, error: 'Promo code is invalid or expired.' };
            }
            // User age eligibility
            const userRes = await client.query('SELECT created_at FROM users WHERE id = $1', [userId]);
            if (userRes.rowCount === 0) return { valid: false, error: 'User not found.' };
            const user = userRes.rows[0];
            if (envPromo.eligibilityDays && envPromo.eligibilityDays > 0) {
              const elapsedMs = Date.now() - new Date(user.created_at).getTime();
              const elapsedDays = elapsedMs / (24 * 3600 * 1000);
              if (elapsedDays > envPromo.eligibilityDays) {
                return { valid: false, error: 'You are no longer eligible for this promotion.' };
              }
            }
            // User already redeemed from premium_promo_redemptions
            const redemptionsRes = await client.query(
              'SELECT id FROM premium_promo_redemptions WHERE user_id = $1 AND promotion_code = $2',
              [userId, envPromo.code]
            );
            if (redemptionsRes.rowCount > 0) {
              return { valid: false, error: 'You have already redeemed this promotion.' };
            }
            // Max redemptions count
            if (envPromo.maxRedemptions && envPromo.maxRedemptions > 0) {
              const totalRes = await client.query(
                'SELECT COUNT(*) as count FROM premium_promo_redemptions WHERE promotion_code = $1',
                [envPromo.code]
              );
              const count = parseInt(totalRes.rows[0].count, 10);
              if (count >= envPromo.maxRedemptions) {
                return { valid: false, error: 'This promotion has reached its maximum usage limit.' };
              }
            }
            if (billingType === 'recurring' && !envPromo.recurringOfferId) {
              return { valid: false, error: 'This promotion cannot be applied to recurring subscriptions.' };
            }

            return {
              valid: true,
              promo: {
                id: null, // No database row
                code: envPromo.code,
                discount_type: envPromo.type,
                discount_value: envPromo.value,
                recurring_offer_id: envPromo.recurringOfferId || null
              }
            };
          }
        } catch (err) {
          console.error('Error parsing env backup promo codes:', err);
        }
      }
    }
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }

  // Database-backed promotion checks
  if (!promotion.is_enabled) {
    return { valid: false, error: 'Promo code is invalid or expired.' };
  }

  if (Number(promotion.product_id) !== Number(productId)) {
    return { valid: false, error: 'Promo code is not applicable to this product.' };
  }

  const now = new Date();
  if (promotion.valid_from && new Date(promotion.valid_from) > now) {
    return { valid: false, error: 'Promo code is not active yet.' };
  }
  if (promotion.valid_until) {
    const validUntilDate = new Date(promotion.valid_until);
    if (typeof promotion.valid_until === 'string' && promotion.valid_until.length === 10) {
      validUntilDate.setHours(23, 59, 59, 999);
    } else if (validUntilDate.getHours() === 0 && validUntilDate.getMinutes() === 0 && validUntilDate.getSeconds() === 0) {
      validUntilDate.setHours(23, 59, 59, 999);
    }
    if (validUntilDate < now) {
      return { valid: false, error: 'Promo code is invalid or expired.' };
    }
  }

  // User age in days eligibility
  const userRes = await client.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  if (userRes.rowCount === 0) {
    return { valid: false, error: 'User not found.' };
  }
  const user = userRes.rows[0];
  if (promotion.eligibility_days && promotion.eligibility_days > 0) {
    const elapsedMs = Date.now() - new Date(user.created_at).getTime();
    const elapsedDays = elapsedMs / (24 * 3600 * 1000);
    if (elapsedDays > promotion.eligibility_days) {
      return { valid: false, error: 'You are no longer eligible for this promotion.' };
    }
  }

  // Check if this user has already redeemed this database promotion
  const userRedemption = await client.query(
    'SELECT id FROM paid_product_promo_redemptions WHERE user_id = $1 AND promotion_id = $2',
    [userId, promotion.id]
  );
  if (userRedemption.rowCount > 0) {
    return { valid: false, error: 'You have already redeemed this promotion.' };
  }

  // Check max redemptions
  if (promotion.max_redemptions && promotion.max_redemptions > 0) {
    const totalRedemptions = await client.query(
      'SELECT COUNT(*)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_id = $1',
      [promotion.id]
    );
    if (totalRedemptions.rows[0].count >= promotion.max_redemptions) {
      return { valid: false, error: 'This promotion has reached its maximum usage limit.' };
    }
  }

  // Check billing type conditions for recurring subscriptions
  if (billingType === 'recurring' && (!promotion.recurring_offer_id || !promotion.recurring_offer_id.trim())) {
    return { valid: false, error: 'This promotion cannot be applied to recurring subscriptions.' };
  }

  return {
    valid: true,
    promo: {
      id: promotion.id,
      code: promotion.code,
      discount_type: promotion.discount_type,
      discount_value: promotion.discount_value,
      recurring_offer_id: promotion.recurring_offer_id
    }
  };
}

/**
 * Securely records a promotion redemption in the ledger.
 */
export async function recordPromotionRedemption({
  userId,
  promotionIdOrCode,
  providerReference,
  originalAmount,
  discountAmount,
  finalAmount
}, client = pool) {
  if (!userId || !promotionIdOrCode || !providerReference || originalAmount == null || discountAmount == null || finalAmount == null) {
    throw new Error('Required fields missing for recording promotion redemption');
  }

  let promoId = null;
  let promoCodeStr = null;

  if (typeof promotionIdOrCode === 'number' || !isNaN(Number(promotionIdOrCode))) {
    promoId = Number(promotionIdOrCode);
    const promo = await getPromotionById(promoId, client);
    if (promo) {
      promoCodeStr = promo.code;
    }
  } else {
    // It's a code
    promoCodeStr = String(promotionIdOrCode).trim().toUpperCase();
    const promo = await getPromotionByCode(promoCodeStr, client);
    if (promo) {
      promoId = promo.id;
    }
  }

  if (promoId) {
    // Insert into DB promotions redemption history
    await client.query(
      `INSERT INTO paid_product_promo_redemptions (
         user_id, promotion_id, provider_reference, original_amount, discount_amount, final_amount, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, promotion_id) DO NOTHING`,
      [userId, promoId, providerReference, originalAmount, discountAmount, finalAmount]
    );
  }

  if (promoCodeStr) {
    // Dual write to legacy table for perfect backwards compatibility and existing tests
    await client.query(
      `INSERT INTO premium_promo_redemptions (
         user_id, promotion_code, provider_reference, original_amount_paise, discount_amount_paise, final_amount_paise, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, promotion_code) DO NOTHING`,
      [userId, promoCodeStr, providerReference, originalAmount, discountAmount, finalAmount]
    );
  }
}

/**
 * Retrieves all promotions with their product info and current redemption count.
 */
export async function getAllPromotions(client = pool) {
  const res = await client.query(
    `SELECT p.*, prod.name as product_name, prod.code as product_code,
            (SELECT COUNT(*)::integer FROM paid_product_promo_redemptions r WHERE r.promotion_id = p.id) as redemption_count
     FROM paid_product_promotions p
     JOIN paid_products prod ON p.product_id = prod.id
     ORDER BY p.code ASC`
  );
  return res.rows;
}

/**
 * Retrieves a promotion with associated product info and calculated redemption count.
 */
export async function getPromotionDetails(id, client = pool) {
  if (!id) return null;
  const res = await client.query(
    `SELECT p.*, prod.name as product_name, prod.code as product_code,
            (SELECT COUNT(*)::integer FROM paid_product_promo_redemptions r WHERE r.promotion_id = p.id) as redemption_count
     FROM paid_product_promotions p
     JOIN paid_products prod ON p.product_id = prod.id
     WHERE p.id = $1`,
    [id]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

/**
 * Checks if a promotion code already exists within a product's scope.
 */
export async function isPromoCodeDuplicate(code, productId, excludePromoId = null, client = pool) {
  if (!code || !productId) return false;
  let q = 'SELECT id FROM paid_product_promotions WHERE UPPER(code) = $1 AND product_id = $2';
  const params = [code.trim().toUpperCase(), productId];
  if (excludePromoId) {
    q += ' AND id <> $3';
    params.push(excludePromoId);
  }
  const res = await client.query(q, params);
  return res.rowCount > 0;
}

/**
 * Updates an existing promotion's configuration.
 */
export async function updatePaidProductPromotion(id, {
  code,
  productId,
  discountType,
  discountValue,
  eligibilityDays = null,
  maxRedemptions = null,
  validFrom = null,
  validUntil = null,
  isEnabled = true,
  recurringOfferId = null,
  showOnPaymentScreen = false
}, client = pool) {
  if (!code || !productId || !discountType || discountValue == null) {
    throw new Error('Code, productId, discountType, and discountValue are required to update a promotion');
  }

  const res = await client.query(
    `UPDATE paid_product_promotions
     SET code = $1,
         product_id = $2,
         discount_type = $3,
         discount_value = $4,
         eligibility_days = $5,
         max_redemptions = $6,
         valid_from = $7,
         valid_until = $8,
         is_enabled = $9,
         recurring_offer_id = $10,
         show_on_payment_screen = $11,
         updated_at = NOW()
     WHERE id = $12
     RETURNING *`,
    [
      code.trim().toUpperCase(),
      productId,
      discountType,
      discountValue,
      eligibilityDays,
      maxRedemptions,
      validFrom,
      validUntil,
      isEnabled,
      recurringOfferId,
      !!showOnPaymentScreen,
      id
    ]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

/**
 * Toggles a promotion's enabled state.
 */
export async function setPromotionEnabled(id, isEnabled, client = pool) {
  if (!id) throw new Error('Promotion ID is required');
  const res = await client.query(
    `UPDATE paid_product_promotions
     SET is_enabled = $1,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [!!isEnabled, id]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}


/**
 * Connects generic one-time payment event to generic paid product framework:
 * - Creates/Updates paid_orders
 * - Check duplicate grant / Idempotency
 * - Creates a user_product_grants entitlement
 * - Logs audit event in paid_product_events
 * - Synchronizes RBAC role through syncProductRbacRole
 * - Returns { order, grant }
 */
export async function recordGenericOneTimePayment({
  userId,
  productId,
  planId,
  orderId,         // Razorpay Order ID
  paymentId,       // Razorpay Payment ID
  amountPaise,     // Discounted final amount paid
  currency = 'INR',
  promoCode = null,
  discountPaise = 0,
  validUntil = null,
  metadata = {}
}, client = pool) {
  if (!userId || !productId || !planId || !orderId || !paymentId || amountPaise == null) {
    throw new Error('Required fields missing for recording generic one-time payment.');
  }

  // 1. Check or create paid_orders
  let orderRow = null;
  const orderCheck = await client.query(
    `SELECT * FROM paid_orders WHERE provider = 'razorpay' AND provider_order_id = $1`,
    [orderId]
  );

  if (orderCheck.rowCount > 0) {
    orderRow = orderCheck.rows[0];
    if (orderRow.status !== 'paid') {
      const upd = await client.query(
        `UPDATE paid_orders 
         SET status = 'paid', provider_payment_id = $2, updated_at = NOW(),
             metadata = metadata || $3::jsonb
         WHERE id = $1 RETURNING *`,
        [orderRow.id, paymentId, JSON.stringify({ verified_at: new Date(), ...metadata })]
      );
      orderRow = upd.rows[0];
    }
  } else {
    const ins = await client.query(
      `INSERT INTO paid_orders (
         user_id, product_id, plan_id, amount_paise, currency, status,
         provider, provider_order_id, provider_payment_id, promo_code, discount_paise, metadata,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'paid', 'razorpay', $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [
        userId,
        productId,
        planId,
        amountPaise,
        currency,
        orderId,
        paymentId,
        promoCode,
        discountPaise,
        JSON.stringify(metadata)
      ]
    );
    orderRow = ins.rows[0];
  }

  // 2. Idempotency check on user_product_grants to prevent duplicate processing
  const grantCheck = await client.query(
    `SELECT * FROM user_product_grants 
     WHERE (order_id = $1 OR (metadata->>'provider_payment_id' = $2)) AND product_id = $3`,
    [orderRow.id, paymentId, productId]
  );

  let grantRow = null;
  if (grantCheck.rowCount > 0) {
    grantRow = grantCheck.rows[0];
  } else {
    // Determine product details for the reason
    const prodRes = await client.query('SELECT name FROM paid_products WHERE id = $1', [productId]);
    const productName = prodRes.rows[0]?.name || 'Generic Product';

    await verifyAndEnforceCapacity(userId, productId, client);
    const insGrant = await client.query(
      `INSERT INTO user_product_grants (
         user_id, product_id, plan_id, grant_type, status,
         valid_from, valid_until, order_id, grant_reason, metadata,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, 'one_time_purchase', 'active', NOW(), $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [
        userId,
        productId,
        planId,
        validUntil,
        orderRow.id,
        `Verified one-time payment for ${productName}`,
        JSON.stringify({
          provider_order_id: orderId,
          provider_payment_id: paymentId,
          promo_code: promoCode,
          ...metadata
        })
      ]
    );
    grantRow = insGrant.rows[0];

    // 3. Log audit event
    try {
      await client.query(
        `INSERT INTO paid_product_events (
           product_id, user_id, entitlement_id, event_type, provider_event_id,
           previous_status, new_status, message, payload, created_at
         )
         VALUES ($1, $2, $3, 'one_time_payment_verified', $4, NULL, 'active', $5, $6, NOW())`,
        [
          productId,
          userId,
          grantRow.id,
          paymentId,
          `Verified one-time payment for "${productName}". Amount: ${amountPaise} paise.`,
          JSON.stringify({ orderId, paymentId, amountPaise, promoCode })
        ]
      );
    } catch {}
  }

  // 4. Sync RBAC role through the generic framework
  await syncProductRbacRole(userId, productId, client);

  // Sync core user access expiry and roles based on paid products
  await syncUserAccessExpiry(userId, client);

  // Perfect backwards compatibility sync for PREMIUM:
  // If this product was PREMIUM, we should sync users.premium_source, app_role as well!
  try {
    const prodRes = await client.query('SELECT code FROM paid_products WHERE id = $1', [productId]);
    const productCode = prodRes.rows[0]?.code;
    if (productCode === 'PREMIUM') {
      const userCheck = await client.query('SELECT app_role, premium_source FROM users WHERE id = $1', [userId]);
      const user = userCheck.rows[0];

      if (user && user.premium_source !== 'manual') {
        await client.query(
          `UPDATE users 
           SET premium_source = 'one_time',
               app_role = 'PREMIUM',
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );

        // Also record legacy audit log
        await client.query(
          `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) 
           VALUES ($1, NULL, $2, 'PREMIUM', 'grant_premium')`,
          [userId, user.app_role]
        );
      }
    }
  } catch (e) {
    console.warn('Generic payment fallback sync warning:', e.message);
  }

  return { order: orderRow, grant: grantRow };
}


/**
 * Connects generic recurring subscription event/payment to generic paid product framework:
 * - Upserts paid_subscriptions agreement
 * - If payment cycle event, records paid_orders and creates subscription-cycle grant
 * - Logs audit event in paid_product_events
 * - Synchronizes RBAC role through generic framework (syncProductRbacRole)
 * - Safe and idempotent: deduplicates cycles by billing period end or payment/invoice id
 */
export async function recordGenericRecurringSubscriptionEvent({
  userId,
  productId,
  planId,
  providerSubscriptionId,
  status,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  paymentId = null,
  invoiceId = null,
  amountPaise = null,
  currency = 'INR',
  promoCode = null,
  eventId = null,
  eventType = null,
  metadata = {}
}, client = pool) {
  if (!userId || !productId || !planId || !providerSubscriptionId || !status) {
    throw new Error('Required fields missing for recording generic recurring subscription event.');
  }

  const isPayment = paymentId || eventType === 'subscription.charged' || (status === 'active' && (eventType === 'subscription.activated' || !eventType));

  let finalCurrentPeriodEnd = currentPeriodEnd;
  if (isPayment && !finalCurrentPeriodEnd) {
    const planRes = await client.query('SELECT duration_days FROM paid_product_plans WHERE id = $1', [planId]);
    const durationDays = planRes.rows[0]?.duration_days || 30;
    const start = currentPeriodStart ? new Date(currentPeriodStart) : new Date();
    finalCurrentPeriodEnd = new Date(start.getTime() + durationDays * 24 * 3600 * 1000);
  }

  // 1. Upsert paid_subscriptions
  const subRes = await client.query(
    `INSERT INTO paid_subscriptions (
       user_id, product_id, plan_id, provider, provider_customer_id,
       provider_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end,
       metadata, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'razorpay', $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
      ON CONFLICT (provider_subscription_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        product_id = EXCLUDED.product_id,
        plan_id = COALESCE(EXCLUDED.plan_id, paid_subscriptions.plan_id),
        provider = EXCLUDED.provider,
        provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, paid_subscriptions.provider_customer_id),
        status = EXCLUDED.status,
        current_period_start = COALESCE(EXCLUDED.current_period_start, paid_subscriptions.current_period_start),
        current_period_end = COALESCE(EXCLUDED.current_period_end, paid_subscriptions.current_period_end),
        cancel_at_period_end = paid_subscriptions.cancel_at_period_end OR EXCLUDED.cancel_at_period_end,
        metadata = paid_subscriptions.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`,
     [
       userId,
       productId,
       planId,
       metadata?.customer_id || null,
       providerSubscriptionId,
       status,
       currentPeriodStart,
       finalCurrentPeriodEnd,
       cancelAtPeriodEnd,
       JSON.stringify(metadata)
     ]
   );
   const paidSub = subRes.rows[0];

   // 2. If this is a payment event (charged or active with payment), create paid_orders & grant
   let paidOrderId = null;

   if (isPayment && paymentId) {
    // Check idempotency for order
    const orderCheck = await client.query(
      `SELECT id FROM paid_orders WHERE provider_payment_id = $1`,
      [paymentId]
    );
    if (orderCheck.rowCount > 0) {
      paidOrderId = orderCheck.rows[0].id;
    } else {
      let finalAmountPaise = amountPaise;
      if (finalAmountPaise == null) {
        const planRes = await client.query('SELECT price_amount_paise FROM paid_product_plans WHERE id = $1', [planId]);
        finalAmountPaise = planRes.rows[0]?.price_amount_paise || 0;
      }
      const insOrder = await client.query(
        `INSERT INTO paid_orders (
           user_id, product_id, plan_id, amount_paise, currency, status,
           provider, provider_order_id, provider_payment_id, promo_code, metadata,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'paid', 'razorpay', $6, $7, $8, $9, NOW(), NOW())
         RETURNING id`,
        [
          userId,
          productId,
          planId,
          finalAmountPaise,
          currency,
          invoiceId || providerSubscriptionId,
          paymentId,
          promoCode,
          JSON.stringify({ provider_subscription_id: providerSubscriptionId, invoice_id: invoiceId, event_type: eventType })
        ]
      );
      paidOrderId = insOrder.rows[0].id;
    }
  }

  // 3. Grant creation for subscription cycle
  if (isPayment && finalCurrentPeriodEnd) {
    // Check idempotency for this cycle/payment
    const grantCheck = await client.query(
      `SELECT id FROM user_product_grants 
       WHERE subscription_id = $1 AND product_id = $2 
         AND (
           (valid_until = $3) OR
           (metadata->>'provider_payment_id' = $4) OR
           (metadata->>'invoice_id' = $5)
         )`,
      [paidSub.id, productId, finalCurrentPeriodEnd, paymentId || '__none__', invoiceId || '__none__']
    );

    if (grantCheck.rowCount === 0) {
      await verifyAndEnforceCapacity(userId, productId, client);
      await client.query(
        `INSERT INTO user_product_grants (
           user_id, product_id, plan_id, grant_type, status,
           valid_from, valid_until, subscription_id, order_id, grant_reason, metadata,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, 'subscription_cycle', 'active', $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
        [
          userId,
          productId,
          planId,
          currentPeriodStart || new Date(),
          finalCurrentPeriodEnd,
          paidSub.id,
          paidOrderId,
          `Subscription cycle payment (${eventType || status})`,
          JSON.stringify({
            provider_subscription_id: providerSubscriptionId,
            provider_payment_id: paymentId,
            invoice_id: invoiceId,
            promo_code: promoCode,
            ...metadata
          })
        ]
      );
    }
  }

  // 4. Log audit event
  try {
    await client.query(
      `INSERT INTO paid_product_events (
         product_id, user_id, entitlement_id, event_type, provider_event_id,
         previous_status, new_status, message, payload, created_at
       )
       VALUES ($1, $2, NULL, $3, $4, NULL, $5, $6, $7, NOW())`,
      [
        productId,
        userId,
        eventType || `subscription_${status}`,
        eventId || paymentId,
        status,
        `Recurring subscription event: ${status}`,
        JSON.stringify({ providerSubscriptionId, paymentId, currentPeriodEnd: finalCurrentPeriodEnd })
      ]
    );
  } catch {}

  // 5. Sync RBAC role through generic framework
  await syncProductRbacRole(userId, productId, client);

  // Sync core user access expiry and roles based on paid products
  await syncUserAccessExpiry(userId, client);

  // Perfect backwards compatibility sync for PREMIUM:
  try {
    const prodRes = await client.query('SELECT code FROM paid_products WHERE id = $1', [productId]);
    const productCode = prodRes.rows[0]?.code;
    if (productCode === 'PREMIUM') {
      const userCheck = await client.query('SELECT app_role, premium_source FROM users WHERE id = $1', [userId]);
      const user = userCheck.rows[0];

      if (user && user.premium_source !== 'manual') {
        await client.query(
          `UPDATE users 
           SET premium_source = 'subscription',
               app_role = 'PREMIUM',
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );

        await client.query(
          `INSERT INTO premium_subscriptions 
           (user_id, provider, provider_subscription_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end)
           VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, $7)
           ON CONFLICT (provider_subscription_id) DO UPDATE 
           SET status = EXCLUDED.status, 
               current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end,
               cancel_at_period_end = EXCLUDED.cancel_at_period_end,
               updated_at = NOW()`,
          [
            userId,
            providerSubscriptionId,
            'plan_dummy_legacy',
            status,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd
          ]
        );

        await client.query(
          `INSERT INTO role_audit_log (target_user_id, actor_user_id, previous_role, new_role, action) 
           VALUES ($1, NULL, $2, 'PREMIUM', 'grant_premium')`,
          [userId, user.app_role]
        );
      }
    }
  } catch (e) {
    console.warn('Generic recurring payment fallback sync warning:', e.message);
  }

  return { subscription: paidSub };
}

// ── 10. Reconciliation Run Status (persistent, manual & scheduled share same source) ──

const RECONCILIATION_ADVISORY_LOCK_KEY = 7374372; // arbitrary constant for full reconciliation

export async function getLatestReconciliationRun(client = pool) {
  try {
    const res = await client.query(
      `SELECT * FROM reconciliation_runs ORDER BY started_at DESC, id DESC LIMIT 1`
    );
    return res.rows[0] || null;
  } catch (e) {
    // Table may not exist yet before migration — treat as no run
    if (e && (e.code === '42P01' || /does not exist/i.test(e.message))) return null;
    throw e;
  }
}

export async function getLatestCompletedReconciliationRun(client = pool) {
  try {
    const res = await client.query(
      `SELECT * FROM reconciliation_runs WHERE status IN ('completed','failed') ORDER BY started_at DESC, id DESC LIMIT 1`
    );
    return res.rows[0] || null;
  } catch (e) {
    if (e && (e.code === '42P01' || /does not exist/i.test(e.message))) return null;
    throw e;
  }
}

export async function isReconciliationRunning(client = pool) {
  try {
    const res = await client.query(
      `SELECT id FROM reconciliation_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`
    );
    return res.rowCount > 0;
  } catch (e) {
    if (e && (e.code === '42P01' || /does not exist/i.test(e.message))) return false;
    throw e;
  }
}

export async function createReconciliationRun(triggerSource, client = pool) {
  const src = triggerSource === 'scheduled' ? 'scheduled' : 'manual';
  // Concurrency guard: if a run is already marked running, refuse second run
  const running = await isReconciliationRunning(client);
  if (running) {
    const err = new Error('A reconciliation is already running. Please wait for it to finish.');
    err.code = 'RECONCILIATION_RUNNING';
    err.status = 409;
    throw err;
  }
  // Try advisory lock for extra safety across concurrent processes (best-effort, ignore failure)
  try {
    await client.query('SELECT pg_try_advisory_lock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY]);
  } catch {}
  try {
    const res = await client.query(
      `INSERT INTO reconciliation_runs (trigger_source, status, started_at, payload)
       VALUES ($1, 'running', NOW(), '{}'::jsonb) RETURNING *`,
      [src]
    );
    return res.rows[0];
  } catch (e) {
    // release lock if insert failed
    try { await client.query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY]); } catch {}
    throw e;
  }
}

export async function completeReconciliationRun(runId, result, client = pool) {
  const checkedUsers = Number(result?.checkedUsers ?? result?.checked_users ?? 0);
  const grantsExpired = Number(result?.grantsExpired ?? result?.grants_expired ?? 0);
  const subscriptionsExpired = Number(result?.subscriptionsExpired ?? result?.subscriptions_expired ?? 0);
  const usersExpired = Number(result?.usersExpired ?? result?.users_expired ?? 0);
  const rolesGranted = Number(result?.rolesGranted ?? result?.roles_granted ?? 0);
  const rolesRevoked = Number(result?.rolesRevoked ?? result?.roles_revoked ?? 0);
  // grants_created not tracked today — map rolesGranted as grants_created for display compat
  const grantsCreated = rolesGranted;
  const grantsRevoked = rolesRevoked;
  try {
    const res = await client.query(
      `UPDATE reconciliation_runs
       SET status = 'completed',
           completed_at = NOW(),
           checked_users = $2,
           grants_created = $3,
           grants_revoked = $4,
           grants_expired = $5,
           subscriptions_expired = $6,
           users_expired = $7,
           roles_granted = $8,
           roles_revoked = $9,
           payload = $10::jsonb,
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [runId, checkedUsers, grantsCreated, grantsRevoked, grantsExpired, subscriptionsExpired, usersExpired, rolesGranted, rolesRevoked, JSON.stringify(result || {})]
    );
    return res.rows[0] || null;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY]); } catch {}
  }
}

export async function failReconciliationRun(runId, error, client = pool) {
  const msg = error ? String(error.message || error) : 'Unknown error';
  const safeMsg = msg.slice(0, 2000);
  try {
    const res = await client.query(
      `UPDATE reconciliation_runs
       SET status = 'failed',
           completed_at = NOW(),
           error_message = $2,
           payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('error', $2::text),
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [runId, safeMsg]
    );
    return res.rows[0] || null;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_ADVISORY_LOCK_KEY]); } catch {}
  }
}

export async function runReconciliationWithStatus(triggerSource, workFn, client = pool) {
  // High-level helper used by both manual and scheduled paths.
  // Ensures Running -> Completed/Failed transition is always persisted.
  const run = await createReconciliationRun(triggerSource, client);
  try {
    const result = await workFn();
    await completeReconciliationRun(run.id, result, client);
    return { runId: run.id, result, statusRow: await getLatestReconciliationRun(client) };
  } catch (err) {
    await failReconciliationRun(run.id, err, client);
    throw err;
  }
}


