import test from 'node:test';
import assert from 'node:assert/strict';

// Helper function replicating the exact validation logic in src/server.js:
// const userId = parseInt(order.notes?.userId || order.notes?.user_id, 10);
// if (isNaN(userId) || String(userId) !== String(req.user.id)) { ... }
function validatePaymentUserId(orderNotesUserId, reqUserId) {
  const userId = parseInt(orderNotesUserId, 10);
  if (isNaN(userId) || String(userId) !== String(reqUserId)) {
    return false; // rejected
  }
  return true; // succeeds
}

test('One-Time payment user ID type matching and verification regression tests', async (t) => {
  await t.test('1. order userId = "4" and req.user.id = "4" succeeds', () => {
    const success = validatePaymentUserId("4", "4");
    assert.equal(success, true);
  });

  await t.test('2. order userId = 4 and req.user.id = "4" succeeds', () => {
    const success = validatePaymentUserId(4, "4");
    assert.equal(success, true);
  });

  await t.test('3. order userId = "5" and req.user.id = "4" is rejected', () => {
    const success = validatePaymentUserId("5", "4");
    assert.equal(success, false);
  });

  await t.test('4. invalid/non-numeric order userId is rejected', () => {
    const successNull = validatePaymentUserId(null, "4");
    const successUndefined = validatePaymentUserId(undefined, "4");
    const successAlpha = validatePaymentUserId("abc", "4");
    const successEmpty = validatePaymentUserId("", "4");

    assert.equal(successNull, false);
    assert.equal(successUndefined, false);
    assert.equal(successAlpha, false);
    assert.equal(successEmpty, false);
  });
});
