-- 023_premium_one_time_promotions.sql
-- 1. Modify premium_source check constraint on users to allow 'one_time'
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_premium_source;
ALTER TABLE users ADD CONSTRAINT chk_users_premium_source CHECK (premium_source IN ('manual', 'subscription', 'one_time'));

-- 2. Create premium_promo_redemptions table for tracking promo codes
CREATE TABLE IF NOT EXISTS premium_promo_redemptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promotion_code TEXT NOT NULL,
  provider_reference TEXT NOT NULL, -- Razorpay Subscription ID or Order ID
  original_amount_paise INTEGER NOT NULL,
  discount_amount_paise INTEGER NOT NULL,
  final_amount_paise INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_promo UNIQUE (user_id, promotion_code)
);

CREATE INDEX IF NOT EXISTS idx_premium_promo_redemptions_user_id ON premium_promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_premium_promo_redemptions_promo ON premium_promo_redemptions(promotion_code);
