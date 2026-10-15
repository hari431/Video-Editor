import pg from 'pg';
import { getReqId } from '../utils/perf.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  statement_timeout: 8000,
  query_timeout: 8000,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  idle_in_transaction_session_timeout: 10000
});

const perfDiagnosticsEnabledPool = String(process.env.PERF_DIAGNOSTICS || 'false').toLowerCase() === 'true';
if (perfDiagnosticsEnabledPool) {
  // Pool config diagnostics — once at startup, no PII
  try {
    const max = pool.options && pool.options.max != null ? pool.options.max : 10;
    const idleTimeout = pool.options && pool.options.idleTimeoutMillis != null ? pool.options.idleTimeoutMillis : 30000;
    const connTimeout = pool.options && pool.options.connectionTimeoutMillis != null ? pool.options.connectionTimeoutMillis : 0;
    console.log(`PERF poolConfig max=${max} idleTimeoutMillis=${idleTimeout} connectionTimeoutMillis=${connTimeout} totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
  } catch {}
  // Pool event diagnostics — low overhead, only when flag true
  try {
    pool.on('connect', (client) => {
      // client connected to PgBouncer/Postgres (physical connection created)
      try {
        client.on('error', (err) => {
          const code = err && err.code ? String(err.code).slice(0,20) : '-';
          const msg = err && err.message ? String(err.message).slice(0,80).replace(/\s+/g, ' ') : '-';
          console.log(`PERF clientError code=${code} msg=${msg} totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
        });
      } catch {}
      console.log(`PERF poolEvent event=connect totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
    });
    pool.on('acquire', () => {
      console.log(`PERF poolEvent event=acquire totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
    });
    pool.on('remove', () => {
      console.log(`PERF poolEvent event=remove totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
    });
    pool.on('error', (err) => {
      const code = err && err.code ? String(err.code).slice(0,20) : '-';
      const msg = err && err.message ? String(err.message).slice(0,80).replace(/\s+/g, ' ') : '-';
      console.log(`PERF poolError event=poolError code=${code} msg=${msg} totalCount=${pool.totalCount} idleCount=${pool.idleCount} waitingCount=${pool.waitingCount}`);
    });
  } catch {}

  const origQuery = pool.query.bind(pool);
  pool.query = async function(...args) {
    let reqId = '-';
    try { reqId = getReqId(); } catch {}
    const tStart = Date.now();
    const before = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    };
    const tWaitStart = Date.now();
    let client;
    try {
      client = await pool.connect();
    } catch (e) {
      const waitMs = Date.now() - tWaitStart;
      const totalMs = Date.now() - tStart;
      const after = { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount };
      console.log(`PERF poolQuery reqId=${reqId} total=${totalMs}ms wait=${waitMs}ms query=0ms totalCount=${before.totalCount} idleCount=${before.idleCount} waitingCount=${before.waitingCount} afterTotal=${after.totalCount} afterIdle=${after.idleCount} afterWaiting=${after.waitingCount} error=1`);
      throw e;
    }
    const waitMs = Date.now() - tWaitStart;
    const afterWait = { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount };
    const tQuery = Date.now();
    try {
      const res = await client.query(...args);
      const queryMs = Date.now() - tQuery;
      const totalMs = Date.now() - tStart;
      console.log(`PERF poolQuery reqId=${reqId} total=${totalMs}ms wait=${waitMs}ms query=${queryMs}ms totalCount=${before.totalCount} idleCount=${before.idleCount} waitingCount=${before.waitingCount} afterTotal=${afterWait.totalCount} afterIdle=${afterWait.idleCount} afterWaiting=${afterWait.waitingCount}`);
      return res;
    } catch (e) {
      const queryMs = Date.now() - tQuery;
      const totalMs = Date.now() - tStart;
      console.log(`PERF poolQuery reqId=${reqId} total=${totalMs}ms wait=${waitMs}ms query=${queryMs}ms totalCount=${before.totalCount} idleCount=${before.idleCount} waitingCount=${before.waitingCount} afterTotal=${afterWait.totalCount} afterIdle=${afterWait.idleCount} afterWaiting=${afterWait.waitingCount} error=1`);
      throw e;
    } finally {
      try { client.release(); } catch {}
    }
  };
}
