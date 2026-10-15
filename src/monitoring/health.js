// src/monitoring/health.js — Phase 3 lightweight health & scaling indicators
// Advisory only, based on measurable in-memory metrics. No per-request DB writes.
// Thresholds are configurable in one place (HEALTH_THRESHOLDS) and informational only —
// they do NOT represent hosting-provider capacity limits. Avoid false precision.

export const HEALTH_THRESHOLDS = {
  // Heap usage in MB (from metrics.heapUsedMb). Informational; actual hosting limit depends on provider.
  memory: { warningMb: 200, criticalMb: 350 },
  // Error rate = 5xx / total requests. Requires minimum samples to avoid false positives.
  errorRate: { warning: 0.05, critical: 0.10, minSamples: 20 },
  // Average response time in ms (from metrics.responseTime.avgMs).
  responseTime: { warningMs: 500, criticalMs: 1000, minSamples: 10 },
  // Request rate in requests/sec (total / uptimeSeconds). Informational activity level.
  requestRate: { warningRps: 5, criticalRps: 20, minUptimeSec: 30 }
};

function statusRank(s) {
  if (s === 'critical') return 2;
  if (s === 'warning') return 1;
  return 0;
}

export function getMemoryIndicator(metrics) {
  const heapMb = Number(metrics?.heapUsedMb);
  const t = HEALTH_THRESHOLDS.memory;
  if (!Number.isFinite(heapMb)) {
    return { name: 'Memory / Heap', status: 'healthy', value: '—', threshold: `warn ${t.warningMb}MB / crit ${t.criticalMb}MB`, detail: 'No memory data', advisory: 'No data yet.' };
  }
  let status = 'healthy';
  if (heapMb >= t.criticalMb) status = 'critical';
  else if (heapMb >= t.warningMb) status = 'warning';
  const detail = `Heap used ${heapMb} MB (warning ≥${t.warningMb} MB, critical ≥${t.criticalMb} MB). Thresholds are informational, not hosting capacity.`;
  return { name: 'Memory / Heap', status, value: `${heapMb} MB`, threshold: `warn ${t.warningMb}MB / crit ${t.criticalMb}MB`, detail, advisory: status === 'critical' ? 'Heap usage high — monitor for growth.' : status === 'warning' ? 'Heap usage elevated — continue monitoring.' : 'Heap usage normal.' };
}

export function getErrorRateIndicator(metrics) {
  const t = HEALTH_THRESHOLDS.errorRate;
  const total = Number(metrics?.requests?.total) || 0;
  const errors = Number(metrics?.errors?.total) || 0;
  if (total < t.minSamples) {
    return { name: 'Error rate', status: 'healthy', value: `${errors}/${total}`, threshold: `warn ${(t.warning*100).toFixed(0)}% / crit ${(t.critical*100).toFixed(0)}%`, detail: `Insufficient data (${total} samples, need ≥${t.minSamples}) — error rate not evaluated.`, advisory: 'Collecting more samples.' };
  }
  const rate = total > 0 ? errors / total : 0;
  let status = 'healthy';
  if (rate >= t.critical) status = 'critical';
  else if (rate >= t.warning) status = 'warning';
  const pct = (rate*100).toFixed(2) + '%';
  const detail = `Error rate ${pct} (${errors} errors / ${total} requests). Thresholds warn ≥${(t.warning*100).toFixed(0)}% / crit ≥${(t.critical*100).toFixed(0)}% — informational only.`;
  return { name: 'Error rate', status, value: pct, threshold: `warn ${(t.warning*100).toFixed(0)}% / crit ${(t.critical*100).toFixed(0)}%`, detail, advisory: status === 'critical' ? 'Error rate critical — investigate logs.' : status === 'warning' ? 'Error rate elevated — check error logs.' : 'Error rate normal.' };
}

export function getResponseTimeIndicator(metrics) {
  const t = HEALTH_THRESHOLDS.responseTime;
  const count = Number(metrics?.responseTime?.count) || 0;
  const avg = Number(metrics?.responseTime?.avgMs);
  if (count < t.minSamples || !Number.isFinite(avg)) {
    return { name: 'Response time', status: 'healthy', value: count ? `${avg.toFixed(2)} ms` : '—', threshold: `warn ${t.warningMs}ms / crit ${t.criticalMs}ms`, detail: `Insufficient data (${count} samples, need ≥${t.minSamples}) — response time not evaluated.`, advisory: 'Collecting more samples.' };
  }
  let status = 'healthy';
  if (avg >= t.criticalMs) status = 'critical';
  else if (avg >= t.warningMs) status = 'warning';
  const detail = `Avg response ${avg.toFixed(2)} ms (min ${metrics.responseTime.minMs?.toFixed?.(2) ?? '—'} ms / max ${metrics.responseTime.maxMs?.toFixed?.(2) ?? '—'} ms). Thresholds warn ≥${t.warningMs} ms / crit ≥${t.criticalMs} ms — advisory.`;
  return { name: 'Response time', status, value: `${avg.toFixed(2)} ms`, threshold: `warn ${t.warningMs}ms / crit ${t.criticalMs}ms`, detail, advisory: status === 'critical' ? 'Response time critical — check load.' : status === 'warning' ? 'Response time elevated — monitor.' : 'Response time normal.' };
}

export function getRequestLevelIndicator(metrics) {
  const t = HEALTH_THRESHOLDS.requestRate;
  const total = Number(metrics?.requests?.total) || 0;
  const uptime = Math.max(1, Number(metrics?.uptimeSeconds) || 1);
  if (uptime < t.minUptimeSec) {
    const rps = (total / uptime).toFixed(2);
    return { name: 'Request / Activity level', status: 'healthy', value: `${rps} req/s (${total} total)`, threshold: `warn ${t.warningRps} rps / crit ${t.criticalRps} rps`, detail: `Low uptime (${uptime}s, need ≥${t.minUptimeSec}s for evaluation) — activity level not evaluated. Current ${rps} rps informational.`, advisory: 'Collecting more samples.' };
  }
  const rps = total / uptime;
  let status = 'healthy';
  if (rps >= t.criticalRps) status = 'critical';
  else if (rps >= t.warningRps) status = 'warning';
  const detail = `Request rate ${rps.toFixed(2)} req/s (${total} requests / ${uptime}s uptime). Thresholds warn ≥${t.warningRps} rps / crit ≥${t.criticalRps} rps — informational, not capacity proof.`;
  return { name: 'Request / Activity level', status, value: `${rps.toFixed(2)} req/s`, threshold: `warn ${t.warningRps} rps / crit ${t.criticalRps} rps`, detail, advisory: status === 'critical' ? 'Activity very high — monitor resources.' : status === 'warning' ? 'Activity elevated — continue monitoring.' : 'Activity level normal.' };
}

export function getApplicationHealthIndicator(metrics, indicators) {
  // Application health is overall liveness: if any critical -> critical, else warning, else healthy.
  // Also consider basic uptime presence.
  const worst = indicators ? indicators.reduce((acc, cur) => Math.max(acc, statusRank(cur.status)), 0) : 0;
  let status = 'healthy';
  if (worst === 2) status = 'critical';
  else if (worst === 1) status = 'warning';
  const detail = status === 'critical' ? 'One or more indicators critical.' : status === 'warning' ? 'One or more indicators warning.' : 'All indicators healthy.';
  return { name: 'Application health', status, value: status, threshold: 'derived from other indicators', detail, advisory: status === 'critical' ? 'Immediate attention recommended.' : status === 'warning' ? 'Review indicators below.' : 'System operating normally.' };
}

export function getOverallStatus(indicators) {
  const worst = indicators.reduce((acc, cur) => Math.max(acc, statusRank(cur.status)), 0);
  if (worst === 2) return 'critical';
  if (worst === 1) return 'warning';
  return 'healthy';
}

export function getRecommendation(overallStatus) {
  if (overallStatus === 'critical') return 'Capacity concern detected; consider reviewing server resources.';
  if (overallStatus === 'warning') return 'Usage is increasing; continue monitoring.';
  return 'Current infrastructure looks sufficient.';
}

export function getHealthIndicators(metrics) {
  const mem = getMemoryIndicator(metrics);
  const err = getErrorRateIndicator(metrics);
  const rt = getResponseTimeIndicator(metrics);
  const req = getRequestLevelIndicator(metrics);
  const core = [mem, err, rt, req];
  const app = getApplicationHealthIndicator(metrics, core);
  const all = [app, mem, err, rt, req];
  const overall = getOverallStatus(all);
  const recommendation = getRecommendation(overall);
  return {
    overall,
    recommendation,
    // Human-readable advisory note
    note: 'Thresholds are informational and advisory only — not hosting-provider capacity limits. Avoid false precision.',
    thresholds: HEALTH_THRESHOLDS,
    indicators: all,
    // convenience map
    byName: Object.fromEntries(all.map(i => [i.name, i]))
  };
}
