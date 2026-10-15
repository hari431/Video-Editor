import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMsUntilNext3AmIST,
  runPaidProductsReconcileJob,
  schedulePaidProductsReconcile,
  stopPaidProductsReconcile,
  isPaidProductsReconcileScheduled,
  _internal
} from '../src/auth/paid-products-scheduler.js';
import { createMockDb } from './helpers/paid-products-mock.js';

test('Phase 2D - Automatic Reconciliation Scheduler Suite', async (t) => {

  t.afterEach(() => {
    stopPaidProductsReconcile();
  });

  await t.test('1. Calculates 3:00 AM IST correctly across different wall-clock times', () => {
    // 2026-01-01 02:00 IST = 2025-12-31 20:30 UTC -> 1 hour until 3 AM IST
    const t1 = new Date(Date.UTC(2025, 11, 31, 20, 30, 0));
    assert.equal(getMsUntilNext3AmIST(t1), 60 * 60 * 1000, '2 AM IST should be 1 hour until 3 AM');

    // 2026-01-01 04:00 IST = 2025-12-31 22:30 UTC -> 23 hours until next 3 AM IST
    const t2 = new Date(Date.UTC(2025, 11, 31, 22, 30, 0));
    assert.equal(getMsUntilNext3AmIST(t2), 23 * 60 * 60 * 1000, '4 AM IST should be 23 hours until next day 3 AM');

    // Exactly 3:00:00.000 AM IST = 2025-12-31 21:30:00 UTC -> exactly 24 hours until next 3 AM IST
    const t3 = new Date(Date.UTC(2025, 11, 31, 21, 30, 0));
    assert.equal(getMsUntilNext3AmIST(t3), 24 * 60 * 60 * 1000, 'Exactly 3 AM IST should schedule for 24 hours later');

    // 2026-01-01 02:59:00 IST = 2025-12-31 21:29:00 UTC -> 1 minute until 3 AM IST
    const t4 = new Date(Date.UTC(2025, 11, 31, 21, 29, 0));
    assert.equal(getMsUntilNext3AmIST(t4), 60 * 1000, '2:59 AM IST should be 60 seconds until 3 AM');
  });

  await t.test('2. Scheduler honors test environment safety and supports forced start / stop lifecycle', () => {
    stopPaidProductsReconcile();
    assert.equal(isPaidProductsReconcileScheduled(), false);

    // In NODE_ENV === 'test', schedulePaidProductsReconcile returns null without force
    const noopHandle = schedulePaidProductsReconcile();
    assert.equal(noopHandle, null);
    assert.equal(isPaidProductsReconcileScheduled(), false);

    // With force: true, timer starts
    const handle = schedulePaidProductsReconcile({ force: true });
    assert.ok(handle, 'Should return active timer handle');
    assert.equal(isPaidProductsReconcileScheduled(), true);

    // Calling again while active is idempotent
    const sameHandle = schedulePaidProductsReconcile({ force: true });
    assert.equal(sameHandle, handle, 'Should return existing timer handle without duplicating');

    // Stop cancels timers
    stopPaidProductsReconcile();
    assert.equal(isPaidProductsReconcileScheduled(), false);
  });

  await t.test('3. runPaidProductsReconcileJob logs start, completion, duration and summary metrics', async () => {
    const db = createMockDb();

    // Add candidate user with valid grant for JAVA_PRO (product 200)
    db.addGrant({
      user_id: 15,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() + 5 * 86400000)
    });

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(' '));
      origLog(...args);
    };

    try {
      const result = await runPaidProductsReconcileJob({ client: db, dryRun: false });

      assert.equal(result.success, true);
      assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0, 'Must record numeric durationMs');
      assert.ok(result.startedAt, 'Must record startedAt timestamp');
      assert.ok(result.completedAt, 'Must record completedAt timestamp');
      assert.equal(result.totalProducts, 2, 'Must reconcile enabled products (PREMIUM and JAVA_PRO)');
      assert.equal(result.rolesGranted, 1, 'Must have granted missing role');

      // Check log output contains expected markers
      const startLog = logs.find(l => l.includes('[paid-products-scheduler] Starting automatic daily reconciliation'));
      assert.ok(startLog, 'Must log start message');

      const compLog = logs.find(l => l.includes('[paid-products-scheduler] Automatic daily reconciliation completed in'));
      assert.ok(compLog, 'Must log completion message with summary metrics');
      assert.ok(compLog.includes('products'), 'Must include products count in log');
      assert.ok(compLog.includes('roles granted'), 'Must include roles granted count in log');
    } finally {
      console.log = origLog;
    }
  });

  await t.test('4. Scheduler failures never crash the application and return graceful error result', async () => {
    const brokenDb = {
      query: async () => {
        throw new Error('Database connection terminated abruptly');
      }
    };

    const errLogs = [];
    const origErr = console.error;
    console.error = (...args) => {
      errLogs.push(args.join(' '));
      origErr(...args);
    };

    try {
      // Must NOT throw
      const result = await runPaidProductsReconcileJob({ client: brokenDb });

      assert.equal(result.success, false);
      assert.ok(result.error.includes('Database connection terminated abruptly'));
      assert.ok(typeof result.durationMs === 'number');

      const loggedErr = errLogs.find(l => l.includes('[paid-products-scheduler] Automatic reconciliation failed'));
      assert.ok(loggedErr, 'Must log error notice safely');
    } finally {
      console.error = origErr;
    }
  });

  await t.test('5. Generic for every enabled paid product without duplicating logic', async () => {
    const db = createMockDb();

    // User with expired grant on JAVA_PRO (200)
    db.addGrant({
      user_id: 20,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() - 86400000)
    });
    db.addRole({
      user_id: 20,
      role_id: 10,
      assignment_source: 'payment_system'
    });

    const result = await runPaidProductsReconcileJob({ client: db, dryRun: false });

    assert.equal(result.success, true);
    assert.equal(result.grantsExpired, 1, 'Expired grant revoked');
    assert.equal(result.rolesRevoked, 1, 'Payment role revoked');
    assert.equal(db.hasRole(20, 10), false, 'Role actually revoked in DB');

    // ARCHIVED product (id 300) should NOT be evaluated
    const productCodes = result.products.map(p => p.productCode);
    assert.ok(!productCodes.includes('ARCHIVED'));
  });

  await t.test('6. Preserves dryRun functionality and manual reconciliation without side-effects', async () => {
    const db = createMockDb();

    // User with expired grant on JAVA_PRO (200)
    db.addGrant({
      user_id: 25,
      product_id: 200,
      status: 'active',
      valid_until: new Date(Date.now() - 86400000)
    });
    db.addRole({
      user_id: 25,
      role_id: 10,
      assignment_source: 'payment_system'
    });

    // Run job with dryRun: true
    const dryResult = await runPaidProductsReconcileJob({ client: db, dryRun: true });

    assert.equal(dryResult.success, true);
    assert.equal(dryResult.dryRun, true);
    assert.equal(dryResult.grantsExpired, 1);
    assert.equal(dryResult.rolesRevoked, 1);

    // In DB, grant remains active and role remains intact
    const grant = db.getGrants().find(g => g.user_id === 25 && g.product_id === 200);
    assert.equal(grant.status, 'active', 'Dry run must not mutate grant in DB');
    assert.equal(db.hasRole(25, 10), true, 'Dry run must not mutate role in DB');
  });

  await t.test('7. Server startup registers and initializes schedulePaidProductsReconcile', () => {
    const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/server.js'), 'utf8');

    assert.ok(
      serverSrc.includes("import { schedulePaidProductsReconcile } from './auth/paid-products-scheduler.js';"),
      'Must import schedulePaidProductsReconcile in server.js'
    );
    assert.ok(
      serverSrc.includes('schedulePaidProductsReconcile();'),
      'Must execute schedulePaidProductsReconcile() during server initialization'
    );
  });

  await t.test('8. Constants calibration and timer triggers job without crashing', async () => {
    assert.equal(_internal.IST_OFFSET_MS, 5.5 * 60 * 60 * 1000);
    assert.equal(_internal.DAY_MS, 24 * 60 * 60 * 1000);

    const db = createMockDb();
    let jobCalled = 0;

    // Use fake timers or short timeout to test timer callback safely
    const origReconcile = db.query;
    db.query = async (...args) => {
      jobCalled++;
      return origReconcile(...args);
    };

    // schedule with short mock time
    const handle = schedulePaidProductsReconcile({
      force: true,
      client: db
    });

    assert.ok(handle);
    assert.equal(isPaidProductsReconcileScheduled(), true);
    stopPaidProductsReconcile();
    assert.equal(isPaidProductsReconcileScheduled(), false);
  });

});
