// src/monitoring/metrics.js — Phase 1 lightweight system/usage metrics
// In-memory aggregate counters only. No per-request DB writes, no PII.

let startedAt = Date.now();

const data = {
  requests: {
    total: 0,
    byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  },
  errors: { total5xx: 0, total4xx: 0 },
  responseTime: {
    count: 0,
    totalMs: 0,
    avgMs: 0,
    minMs: null,
    maxMs: 0
  },
  content: {
    views: 0,
    pdfPreviews: 0,
    pdfDownloads: 0
  }
};

export function resetMetrics() {
  data.requests.total = 0;
  data.requests.byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  data.errors.total5xx = 0;
  data.errors.total4xx = 0;
  // keep legacy alias too
  data.errors.total = 0;
  data.responseTime = { count: 0, totalMs: 0, avgMs: 0, minMs: null, maxMs: 0 };
  data.content = { views: 0, pdfPreviews: 0, pdfDownloads: 0 };
  startedAt = Date.now();
}

// internal helper — used by middleware and tests
export function recordRequest(statusCode, durationMs) {
  const status = Number(statusCode) || 0;
  const duration = Number(durationMs) || 0;
  data.requests.total += 1;
  const cat = Math.floor(status / 100);
  if (cat === 2) data.requests.byStatus['2xx'] += 1;
  else if (cat === 3) data.requests.byStatus['3xx'] += 1;
  else if (cat === 4) {
    data.requests.byStatus['4xx'] += 1;
    data.errors.total4xx += 1;
  } else if (cat === 5) {
    data.requests.byStatus['5xx'] += 1;
    data.errors.total5xx += 1;
  }
  // keep alias for backward compatibility / simple consumers
  data.errors.total = data.errors.total5xx;

  data.responseTime.count += 1;
  data.responseTime.totalMs += duration;
  data.responseTime.avgMs = data.responseTime.totalMs / data.responseTime.count;
  if (data.responseTime.minMs === null || duration < data.responseTime.minMs) {
    data.responseTime.minMs = duration;
  }
  if (duration > data.responseTime.maxMs) {
    data.responseTime.maxMs = duration;
  }
}

export function recordContentAccess() {
  data.content.views += 1;
}

export function recordPdfPreview() {
  data.content.pdfPreviews += 1;
}

export function recordPdfDownload() {
  data.content.pdfDownloads += 1;
}

export function getMetrics() {
  const now = Date.now();
  const uptimeMs = now - startedAt;
  const mem = process.memoryUsage();
  // clone to avoid mutation
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs,
    uptimeSeconds: Math.floor(uptimeMs / 1000),
    requests: {
      total: data.requests.total,
      byStatus: { ...data.requests.byStatus }
    },
    errors: {
      total: data.errors.total5xx,
      total5xx: data.errors.total5xx,
      total4xx: data.errors.total4xx
    },
    responseTime: {
      count: data.responseTime.count,
      totalMs: data.responseTime.totalMs,
      avgMs: data.responseTime.count ? data.responseTime.totalMs / data.responseTime.count : 0,
      minMs: data.responseTime.minMs,
      maxMs: data.responseTime.maxMs
    },
    content: { ...data.content },
    memory: mem,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10
  };
}

export function getHealth() {
  const m = getMetrics();
  return {
    status: 'ok',
    uptimeSeconds: m.uptimeSeconds,
    startedAt: m.startedAt,
    requests: m.requests.total,
    errors: m.errors.total
  };
}

// Express middleware — lightweight, no DB, no PII
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  const onFinish = () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode || 200;
      recordRequest(status, durationMs);
    } catch {}
    res.removeListener('finish', onFinish);
    res.removeListener('close', onFinish);
  };
  res.on('finish', onFinish);
  res.on('close', onFinish);
  next();
}
