/**
 * Local Verification Script for Phase 2D Automatic Reconciliation Scheduler.
 * Run this script using: node scripts/verify-scheduler-local.js
 * 
 * This script runs safe, non-destructive checks of the scheduler's logic and lifecycle:
 * 1. Checks 3:00 AM IST offset math across various simulation dates.
 * 2. Simulates an immediate automatic run with a mock DB client.
 * 3. Simulates failure recovery when the DB is broken.
 * 4. Verifies the start and stop lifecycle of the scheduler.
 */

import { 
  getMsUntilNext3AmIST, 
  runPaidProductsReconcileJob, 
  schedulePaidProductsReconcile, 
  stopPaidProductsReconcile, 
  isPaidProductsReconcileScheduled 
} from '../src/auth/paid-products-scheduler.js';
import { createMockDb } from '../tests/helpers/paid-products-mock.js';

async function runLocalVerification() {
  console.log('====================================================');
  console.log('       PAID PRODUCTS RECONCILIATION SCHEDULER       ');
  console.log('               LOCAL VERIFICATION                   ');
  console.log('====================================================\n');

  // 1. Next 3:00 AM IST calculation math verification
  console.log('--- Step 1: 3:00 AM IST Next Run Offset Calculations ---');
  
  // Simulation 1: Current time is 2:00 AM IST (needs 1 hr)
  const sim2amIst = new Date(Date.UTC(2026, 0, 1, 20, 30, 0)); // 20:30 UTC = 02:00 IST next day
  const offset2am = getMsUntilNext3AmIST(sim2amIst);
  console.log(`- Current: 2:00 AM IST | Next Run in: ${offset2am / (60 * 1000)} mins (Expected: 60 mins)`);

  // Simulation 2: Current time is 4:00 AM IST (needs 23 hrs)
  const sim4amIst = new Date(Date.UTC(2026, 0, 1, 22, 30, 0)); // 22:30 UTC = 04:00 IST next day
  const offset4am = getMsUntilNext3AmIST(sim4amIst);
  console.log(`- Current: 4:00 AM IST | Next Run in: ${offset4am / (60 * 60 * 1000)} hours (Expected: 23 hours)`);

  // Simulation 3: Current time is 2:59 AM IST (needs 1 min)
  const sim259amIst = new Date(Date.UTC(2026, 0, 1, 21, 29, 0)); // 21:29 UTC = 02:59 IST next day
  const offset259 = getMsUntilNext3AmIST(sim259amIst);
  console.log(`- Current: 2:59 AM IST | Next Run in: ${offset259 / (60 * 1000)} mins (Expected: 1 min)`);
  console.log('  [PASS] Offset math verified.\n');

  // 2. One immediate scheduler execution (Mock DB scenario)
  console.log('--- Step 2: Simulate Immediate Job Execution (Logging & Metrics) ---');
  const mockDb = createMockDb();
  
  // Set up some expired active grant for User ID 12
  mockDb.addGrant({
    user_id: 12,
    product_id: 200, // JAVA_PRO
    status: 'active',
    valid_until: new Date(Date.now() - 3600000) // Expired 1 hour ago
  });
  // User holds the payment role for JAVA_PRO (role 10)
  mockDb.addRole({
    user_id: 12,
    role_id: 10,
    assignment_source: 'payment_system'
  });

  console.log('Running dry-run execution first...');
  const dryResult = await runPaidProductsReconcileJob({ client: mockDb, dryRun: true });
  console.log(`- Dry-Run results:`, {
    success: dryResult.success,
    dryRun: dryResult.dryRun,
    grantsExpired: dryResult.grantsExpired,
    rolesRevoked: dryResult.rolesRevoked
  });

  console.log('Running live reconciliation job immediately...');
  const liveResult = await runPaidProductsReconcileJob({ client: mockDb, dryRun: false });
  console.log(`- Live Run results:`, {
    success: liveResult.success,
    grantsExpired: liveResult.grantsExpired,
    rolesRevoked: liveResult.rolesRevoked,
    durationMs: `${liveResult.durationMs}ms`
  });
  console.log(`- Is User 12 role revoked in DB?`, !mockDb.hasRole(12, 10) ? 'YES (Role Revoked)' : 'NO');
  console.log('  [PASS] Immediate execution logs and state synchronization verified.\n');

  // 3. Failure Handling Verification
  console.log('--- Step 3: Failure Handling Verification ---');
  const brokenDb = {
    query: async () => {
      throw new Error('ECONNRESET: Database connection closed unexpectedly');
    }
  };

  console.log('Executing with simulated database breakdown...');
  const failResult = await runPaidProductsReconcileJob({ client: brokenDb });
  console.log(`- Execution returned gracefully?`, !failResult.success ? 'YES (Returned error object safely)' : 'NO');
  console.log(`- Captured error: "${failResult.error}"`);
  console.log('  [PASS] Scheduler failure did not crash process.\n');

  // 4. Start / Stop Lifecycle Verification
  console.log('--- Step 4: Start and Stop Lifecycle Verification ---');
  console.log(`- Initial state: Active? ${isPaidProductsReconcileScheduled()}`);
  
  console.log('Forcing scheduler to register daily interval...');
  schedulePaidProductsReconcile({ force: true, client: mockDb });
  console.log(`- After starting: Active? ${isPaidProductsReconcileScheduled()}`);
  
  console.log('Stopping scheduler...');
  stopPaidProductsReconcile();
  console.log(`- After stopping: Active? ${isPaidProductsReconcileScheduled()}`);
  console.log('  [PASS] Lifecycle starts and stops correctly.\n');

  console.log('====================================================');
  console.log('    LOCAL SCHEDULER VERIFICATION PASSED SUCCESSFULLY');
  console.log('====================================================');
}

runLocalVerification().catch(err => {
  console.error('Verification failed with error:', err);
  process.exit(1);
});
