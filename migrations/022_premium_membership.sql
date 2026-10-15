-- 022_premium_membership.sql
-- Premium Subscription and Audit Infrastructure

-- 1. Add premium_source column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_source TEXT DEFAULT NULL;

-- 2. Add constraint for premium_source
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_premium_source') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_premium_source CHECK (premium_source IN ('manual', 'subscription'));
  END IF;
END $$;

-- 3. Create premium_subscriptions table
CREATE TABLE IF NOT EXISTS premium_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'razorpay',
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Create premium_subscription_events for detailed audit tracking
CREATE TABLE IF NOT EXISTS premium_subscription_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT REFERENCES premium_subscriptions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  previous_status TEXT,
  new_status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Indexes for fast retrieval and joins
CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_user_id ON premium_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_status ON premium_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_provider_sub ON premium_subscriptions(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_premium_subscription_events_user_id ON premium_subscription_events(user_id);
