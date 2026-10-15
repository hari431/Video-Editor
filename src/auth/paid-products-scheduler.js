import { pool } from '../db/pool.js';
import { reconcileAllPaidProducts } from './paidProducts.js';

// IST offset is UTC+5:30, no DST
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let timeoutHandle = null;
let intervalHandle = null;

/**
 * Calculates milliseconds from now until the next 3:00 AM IST.
 * 
 * @param {Date} [now=new Date()]
 * @returns {number} Delay in milliseconds
 */
export function getMsUntilNext3AmIST(now = new Date()) {
  const nowUtcMs = now.getTime();
  // Current time adjusted to IST wall-clock representation
  const nowIstMs = nowUtcMs + IST_OFFSET_MS;
  const nowIst = new Date(nowIstMs);

  // Target 3:00 AM IST
  const next3AmIst = new Date(nowIst);
  next3AmIst.setUTCHours(3, 0, 0, 0);

  // If already past 3:00 AM IST today, schedule for tomorrow
  if (next3AmIst.getTime() <= nowIst.getTime()) {
    next3AmIst.setUTCDate(next3AmIst.getUTCDate() + 1);
  }

  // Convert back to UTC timestamp
  const next3AmUtcMs = next3AmIst.getTime() - IST_OFFSET_MS;
  return next3AmUtcMs - nowUtcMs;
}

/**
 * Executes one reconciliation job run for all enabled paid products.
 * Guarantees:
 * - Logs start, completion, duration, and summary metrics.
 * - Any internal or DB error is caught gracefully and logged; never crashes application.
 * - Supports dryRun and custom client injection.
 * 
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {object} [opts.client=pool]
 * @returns {Promise<object>}
 */
export async function runPaidProductsReconcileJob(opts = {}) {
  const dryRun = !!opts.dryRun;
  const client = opts.client || pool;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  console.log(`[paid-products-scheduler] Starting automatic daily reconciliation at ${startedAt} (dryRun=${dryRun})`);

  // Dry runs must NOT create persistent status — observability is for real runs only
  if (dryRun) {
    try {
      const result = await reconcileAllPaidProducts({ client, dryRun, ...opts });
      const durationMs = Date.now() - startTime;
      const completedAt = new Date().toISOString();
      console.log(
        `[paid-products-scheduler] Automatic daily reconciliation (dryRun) completed in ${durationMs}ms: ` +
        `${result.totalProducts} products, ${result.checkedUsers} users, ` +
        `${result.grantsExpired} grants expired, ${result.subscriptionsExpired} subs expired`
      );
      return { ...result, durationMs, startedAt, completedAt };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      console.error(`[paid-products-scheduler] Automatic reconciliation (dryRun) failed after ${durationMs}ms:`, err.message);
      return { success: false, error: err.message || 'Reconciliation execution error', durationMs, startedAt, completedAt: new Date().toISOString() };
    }
  }

  // Persistent status: scheduled runs share same source of truth as manual runs
  const { createReconciliationRun, completeReconciliationRun, failReconciliationRun } = await import('./paidProducts.js');
  let runRow = null;
  try {
    runRow = await createReconciliationRun('scheduled', client);
  } catch (lockErr) {
    if (lockErr && lockErr.code === 'RECONCILIATION_RUNNING') {
      console.warn('[paid-products-scheduler] Skipping scheduled run — reconciliation already running.');
      return { success: false, error: lockErr.message, skipped: true, startedAt, completedAt: new Date().toISOString() };
    }
    console.error('[paid-products-scheduler] Failed to create reconciliation run record:', lockErr.message);
    // Fallback: still try reconcile without status record
    try {
      const result = await reconcileAllPaidProducts({ client, dryRun, ...opts });
      const durationMs = Date.now() - startTime;
      console.log(`[paid-products-scheduler] Automatic daily reconciliation completed in ${durationMs}ms (fallback): ${result.totalProducts} products`);
      return { ...result, durationMs, startedAt, completedAt: new Date().toISOString() };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      console.error(`[paid-products-scheduler] Automatic reconciliation failed after ${durationMs}ms:`, err.message);
      return { success: false, error: err.message, durationMs, startedAt, completedAt: new Date().toISOString() };
    }
  }

  try {
    const result = await reconcileAllPaidProducts({ client, dryRun, ...opts });
    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();
    try { await completeReconciliationRun(runRow.id, result, client); } catch (e) { console.error('[paid-products-scheduler] Failed to mark run completed:', e.message); }
    console.log(
      `[paid-products-scheduler] Automatic daily reconciliation completed in ${durationMs}ms: ` +
      `${result.totalProducts} products, ${result.checkedUsers} users, ` +
      `${result.grantsExpired} grants expired, ${result.subscriptionsExpired} subs expired, ` +
      `${result.usersExpired || 0} user statuses expired, ` +
      `${result.rolesGranted} roles granted, ${result.rolesRevoked} roles revoked, ` +
      `${result.rolesPreservedManual} manual roles preserved, ${result.skippedProtected} protected skipped.`
    );
    return { ...result, durationMs, startedAt, completedAt };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    try { await failReconciliationRun(runRow.id, err, client); } catch (e) { console.error('[paid-products-scheduler] Failed to mark run failed:', e.message); }
    console.error(`[paid-products-scheduler] Automatic reconciliation failed after ${durationMs}ms:`, err.message);
    return { success: false, error: err.message || 'Reconciliation execution error', durationMs, startedAt, completedAt: new Date().toISOString() };
  }
}

/**
 * Schedules daily paid products reconciliation at 3:00 AM IST.
 * Reuses the application's standard timer/interval scheduling pattern.
 * 
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - Force schedule even in test environment
 * @param {number} [opts.intervalMs=DAY_MS] - Recurrence interval
 * @param {Date} [opts.now] - Custom current time
 * @param {object} [opts.client] - Custom DB client
 * @returns {object|null} Timer handle or null if skipped
 */
export function schedulePaidProductsReconcile(opts = {}) {
  if (process.env.NODE_ENV === 'test' && !opts.force) return null;
  if (timeoutHandle || intervalHandle) return timeoutHandle || intervalHandle;

  const delayMs = getMsUntilNext3AmIST(opts.now || new Date());
  const safeDelay = delayMs > 0 && delayMs <= DAY_MS ? delayMs : DAY_MS;
  const intervalMs = opts.intervalMs || DAY_MS;

  console.log(`[paid-products-scheduler] Scheduler active. Next run in ${Math.round(safeDelay / 60000)} minutes (3:00 AM IST).`);

  timeoutHandle = setTimeout(async () => {
    try {
      await runPaidProductsReconcileJob(opts);
    } catch (e) {
      console.error('[paid-products-scheduler] scheduled initial run failed:', e.message);
    }

    intervalHandle = setInterval(async () => {
      try {
        await runPaidProductsReconcileJob(opts);
      } catch (e) {
        console.error('[paid-products-scheduler] scheduled interval run failed:', e.message);
      }
    }, intervalMs);

    if (intervalHandle && intervalHandle.unref) intervalHandle.unref();
  }, safeDelay);

  if (timeoutHandle && timeoutHandle.unref) timeoutHandle.unref();
  return timeoutHandle;
}

/**
 * Stops any active scheduled reconciliation timers.
 */
export function stopPaidProductsReconcile() {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Checks whether the paid products reconciliation scheduler is currently active.
 * 
 * @returns {boolean}
 */
export function isPaidProductsReconcileScheduled() {
  return timeoutHandle !== null || intervalHandle !== null;
}

export const _internal = {
  IST_OFFSET_MS,
  DAY_MS
};
