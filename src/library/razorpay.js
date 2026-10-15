import Razorpay from 'razorpay';
import crypto from 'node:crypto';

export function isPremiumMembershipEnabled() {
  return process.env.PREMIUM_MEMBERSHIP_ENABLED === 'true';
}

/**
 * Helper to check if simulation controls are allowed in the current environment.
 * Enables simulation only when NODE_ENV is explicitly 'development' or 'test'.
 * Any unset, unknown, or production environment will reject simulation.
 */
export function isSimulationAllowed() {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

const simulatedCancelledSubscriptions = new Set();

/**
 * Local/dev-only helper to simulate provider cancellation of a subscription ID
 */
export function simulateProviderCancellation(subscriptionId) {
  if (!isSimulationAllowed()) {
    throw new Error('Simulation controls are strictly disabled in this environment.');
  }
  if (subscriptionId) {
    simulatedCancelledSubscriptions.add(String(subscriptionId));
  }
}

/**
 * Checks if a subscription ID is locally marked as simulated cancelled
 */
export function isSubscriptionSimulatedCancelled(subscriptionId) {
  if (!isSimulationAllowed()) {
    return false;
  }
  return simulatedCancelledSubscriptions.has(String(subscriptionId));
}

/**
 * Clears all simulated provider cancellations
 */
export function clearSimulatedProviderCancellations() {
  simulatedCancelledSubscriptions.clear();
}

function attachSimulationWrapper(client) {
  if (!client || !client.subscriptions || client.subscriptions._simWrapperAttached) {
    return client;
  }
  const realSDKFetch = client.subscriptions.fetch.bind(client.subscriptions);
  client.subscriptions.fetch = async function(subscriptionId, ...args) {
    if (isSimulationAllowed() && isSubscriptionSimulatedCancelled(subscriptionId)) {
      return {
        id: subscriptionId,
        status: 'cancelled',
        simulated: true,
        ended_at: Math.floor(Date.now() / 1000)
      };
    }
    const targetFetch = client.subscriptions._mockFetch || realSDKFetch;
    return targetFetch(subscriptionId, ...args);
  };
  client.subscriptions._simWrapperAttached = true;
  return client;
}

let razorpayInstance = null;

export function getRazorpayClient() {
  if (!razorpayInstance) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    
    // Fallback to dummy values for testing or offline environment to avoid crashing on start
    if (!keyId || !keySecret) {
      if (isPremiumMembershipEnabled()) {
        throw new Error('Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are required when PREMIUM_MEMBERSHIP_ENABLED is true.');
      }
      const dummyClient = new Razorpay({
        key_id: 'dummy_key_id',
        key_secret: 'dummy_key_secret'
      });
      return attachSimulationWrapper(dummyClient);
    }
    
    razorpayInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });
  }
  return attachSimulationWrapper(razorpayInstance);
}

/**
 * Creates a Razorpay subscription (server-side check of plan/amount)
 */
export async function createRazorpaySubscription(userId, planId, offerId = null, promoCode = null) {
  if (!isPremiumMembershipEnabled()) {
    throw new Error('Premium membership subscriptions are currently disabled.');
  }
  
  const actualPlanId = planId || process.env.RAZORPAY_PREMIUM_PLAN_ID;
  if (!actualPlanId) {
    throw new Error('Razorpay Premium Plan ID is not configured.');
  }

  const razorpay = getRazorpayClient();
  const options = {
    plan_id: actualPlanId,
    total_count: 12, // 12 periods (e.g. 12 months)
    quantity: 1,
    customer_notify: 1,
    notes: {
      userId: String(userId),
      promoCode: promoCode || ''
    }
  };

  if (offerId) {
    options.offer_id = offerId;
  }

  return razorpay.subscriptions.create(options);
}

/**
 * Fetches subscription details from Razorpay
 */
export async function fetchRazorpaySubscription(subscriptionId) {
  const razorpay = getRazorpayClient();
  return razorpay.subscriptions.fetch(subscriptionId);
}

/**
 * Cancels subscription on Razorpay
 */
export async function cancelRazorpaySubscription(subscriptionId, cancelAtEnd = true) {
  const razorpay = getRazorpayClient();
  return razorpay.subscriptions.cancel(subscriptionId, cancelAtEnd);
}

/**
 * Reverts a scheduled cancellation (cancel_at_cycle_end) on Razorpay.
 * Uses the official Razorpay API: POST /v1/subscriptions/:id/cancel_scheduled_changes
 * which is the documented way to undo a cancel_at_cycle_end=1.
 * See: https://razorpay.com/docs/api/subscriptions/#cancel-scheduled-changes
 * Verified in SDK: razorpay@2.9.8 dist/resources/subscriptions.js -> cancelScheduledChanges
 */
export async function revertRazorpayCancellation(subscriptionId) {
  const razorpay = getRazorpayClient();
  return razorpay.subscriptions.cancelScheduledChanges(subscriptionId);
}

/**
 * Verifies Razorpay webhook signature using raw body as string
 */
export function verifyRazorpayWebhookSignature(rawBody, signature, secret) {
  const webhookSecret = secret || process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('Razorpay Webhook Secret is not configured.');
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
    
  return expectedSignature === signature;
}

/**
 * Creates a Razorpay Order for one-time payments
 */
export async function createRazorpayOrder(amountPaise, currency = 'INR', receipt = '', notes = {}) {
  const razorpay = getRazorpayClient();
  return razorpay.orders.create({
    amount: amountPaise,
    currency,
    receipt,
    notes
  });
}
