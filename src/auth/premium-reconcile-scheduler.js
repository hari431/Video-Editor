import { reconcileAllPremiumRoles } from './premium.js';

// IST offset is UTC+5:30, no DST
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let timeoutHandle = null;
let intervalHandle = null;

export function getMsUntilNext3AmIST(now = new Date()) {
  const nowUtcMs = now.getTime();
  // Current time as IST wall time expressed as UTC timestamp
  const nowIstMs = nowUtcMs + IST_OFFSET_MS;
  const nowIst = new Date(nowIstMs);

  // Next 3 AM IST as UTC timestamp: create a date at 03:00 IST
  // We use UTC methods on the IST-adjusted date
  let next3AmIst = new Date(nowIst);
  next3AmIst.setUTCHours(3, 0, 0, 0);

  // If it's already past 3 AM IST today, move to tomorrow
  if (next3AmIst.getTime() <= nowIst.getTime()) {
    next3AmIst.setUTCDate(next3AmIst.getUTCDate() + 1);
  }

  // Convert IST wall time back to UTC for scheduling
  const next3AmUtcMs = next3AmIst.getTime() - IST_OFFSET_MS;
  return next3AmUtcMs - nowUtcMs;
}

export function schedulePremiumReconcile() {
  if (process.env.NODE_ENV === 'test') return null;
  if (timeoutHandle || intervalHandle) return timeoutHandle || intervalHandle;

  const delayMs = getMsUntilNext3AmIST(new Date());
  // Safety: if delay is negative or too large, fallback to 24h
  const safeDelay = delayMs > 0 && delayMs <= DAY_MS ? delayMs : DAY_MS;

  timeoutHandle = setTimeout(async () => {
    try {
      await reconcileAllPremiumRoles();
    } catch (e) {
      console.error('[premium-reconcile] scheduled run failed:', e.message);
    }
    // Then run every 24h at same time
    intervalHandle = setInterval(async () => {
      try {
        await reconcileAllPremiumRoles();
      } catch (e) {
        console.error('[premium-reconcile] interval run failed:', e.message);
      }
    }, DAY_MS);
    if (intervalHandle && intervalHandle.unref) intervalHandle.unref();
  }, safeDelay);

  if (timeoutHandle && timeoutHandle.unref) timeoutHandle.unref();
  return timeoutHandle;
}

export function stopPremiumReconcile() {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function isPremiumReconcileScheduled() {
  return timeoutHandle !== null || intervalHandle !== null;
}

// For testing: allow injection of now
export const _internal = {
  IST_OFFSET_MS,
  DAY_MS,
};
