// src/cleanup/scheduler.js — Periodic retention cleanup reusing app's setInterval pattern
// Mirrors src/monitoring/history.js scheduleDailyFlush style.

import { runRetentionCleanup } from './retention.js';
import { getRetentionConfig } from '../config/retention.js';
import { runInactiveUserCleanup } from './inactiveUsers.js';
import { getInactiveDeleteDays, getInactiveDeleteTime, isInactiveDeleteAutoEnabled } from '../config/inactiveDeletion.js';

let intervalHandle = null;
let inactiveIntervalHandle = null;
let inactiveTimeoutHandle = null;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getMsUntilNextDeleteTime(now = new Date(), timeConfig = null) {
  const cfg = timeConfig || getInactiveDeleteTime();
  const hour = cfg.hour;
  const minute = cfg.minute;
  const nowUtcMs = now.getTime();
  const nowIstMs = nowUtcMs + IST_OFFSET_MS;
  const nowIst = new Date(nowIstMs);
  const nextIst = new Date(nowIst);
  nextIst.setUTCHours(hour, minute, 0, 0);
  if (nextIst.getTime() <= nowIst.getTime()) {
    nextIst.setUTCDate(nextIst.getUTCDate() + 1);
  }
  const nextUtcMs = nextIst.getTime() - IST_OFFSET_MS;
  return nextUtcMs - nowUtcMs;
}

export function scheduleRetentionCleanup(intervalMs = 24 * 60 * 60 * 1000) {
  if (intervalHandle) return intervalHandle;
  if (process.env.NODE_ENV === 'test') return null;
  const cfg = getRetentionConfig();
  if (!cfg.enabled) {
    console.log('[retention] Scheduler not started: RETENTION_ENABLED != true');
    return null;
  }
  intervalHandle = setInterval(() => {
    runRetentionCleanup().catch(err => {
      console.error('[retention] scheduled cleanup failed:', err.message);
    });
  }, intervalMs);
  if (intervalHandle.unref) intervalHandle.unref();
  console.log(`[retention] Scheduler started (interval ${intervalMs} ms, dryRun=${cfg.dryRun}, batch=${cfg.batchSize})`);
  return intervalHandle;
}

export function stopRetentionCleanup() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function isRetentionSchedulerActive() {
  return intervalHandle !== null;
}

export function scheduleInactiveUserCleanup(opts = {}) {
  // Backwards compat: allow scheduleInactiveUserCleanup(86400000) as number
  if (typeof opts === 'number') opts = { intervalMs: opts };
  const intervalMs = opts.intervalMs || DAY_MS;
  const now = opts.now || new Date();
  const force = !!opts.force;
  if (inactiveIntervalHandle || inactiveTimeoutHandle) return inactiveIntervalHandle || inactiveTimeoutHandle;
  if (process.env.NODE_ENV === 'test' && !force) return null;
  if (!isInactiveDeleteAutoEnabled() && !force) {
    console.log('[inactive-deletion] Scheduler not started: auto-run disabled (set INACTIVE_DELETE_ENABLED=true or NODE_ENV=production to enable)');
    return null;
  }
  const days = getInactiveDeleteDays();
  if (!days) {
    console.log('[inactive-deletion] Scheduler not started: USER_INACTIVE_DELETE_DAYS missing/invalid');
    return null;
  }
  const timeCfg = getInactiveDeleteTime();
  const delayMs = getMsUntilNextDeleteTime(now, timeCfg);
  const safeDelay = delayMs > 0 && delayMs <= DAY_MS ? delayMs : DAY_MS;
  console.log(`[inactive-deletion] Scheduler active. Next run in ${Math.round(safeDelay / 60000)} minutes at ${timeCfg.raw} IST (days=${days}).`);

  inactiveTimeoutHandle = setTimeout(async () => {
    try {
      await runInactiveUserCleanup();
    } catch (e) {
      console.error('[inactive-deletion] scheduled initial run failed:', e.message);
    }
    inactiveIntervalHandle = setInterval(async () => {
      try {
        await runInactiveUserCleanup();
      } catch (e) {
        console.error('[inactive-deletion] scheduled interval run failed:', e.message);
      }
    }, intervalMs);
    if (inactiveIntervalHandle && inactiveIntervalHandle.unref) inactiveIntervalHandle.unref();
  }, safeDelay);

  if (inactiveTimeoutHandle && inactiveTimeoutHandle.unref) inactiveTimeoutHandle.unref();
  return inactiveTimeoutHandle;
}

export function stopInactiveUserCleanup() {
  if (inactiveTimeoutHandle) {
    clearTimeout(inactiveTimeoutHandle);
    inactiveTimeoutHandle = null;
  }
  if (inactiveIntervalHandle) {
    clearInterval(inactiveIntervalHandle);
    inactiveIntervalHandle = null;
  }
}

export function isInactiveCleanupActive() {
  return inactiveIntervalHandle !== null || inactiveTimeoutHandle !== null;
}

export const _inactiveInternal = {
  getMsUntilNextDeleteTime,
  IST_OFFSET_MS,
  DAY_MS,
};
