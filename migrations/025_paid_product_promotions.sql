-- 025_paid_product_promotions.sql
-- Database-Backed Generic Promotions System

-- 1. Create paid_product_promotions table
CREATE TABLE IF NOT EXISTS paid_product_promotions (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  product_id          BIGINT NOT NULL REFERENCES paid_products(id) ON DELETE CASCADE,
  discount_type       TEXT NOT NULL CHECK (discount_type IN ('percentage', 'flat')),
  discount_value      INTEGER NOT NULL CHECK (discount_value >= 0),
  eligibility_days    INTEGER, -- eligibility rule: user age in days limit
  max_redemptions     INTEGER, -- max total redemptions allowed across all users
  valid_from          TIMESTAMPTZ, -- validity dates
  valid_until         TIMESTAMPTZ, -- validity dates
  is_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  recurring_offer_id  TEXT, -- razorpay offer ID for recurring subscriptions
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_code ON paid_product_promotions(code);
CREATE INDEX IF NOT EXISTS idx_promotions_product_id ON paid_product_promotions(product_id);

-- 2. Create paid_product_promo_redemptions table for tracking complete redemption history
CREATE TABLE IF NOT EXISTS paid_product_promo_redemptions (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promotion_id        BIGINT NOT NULL REFERENCES paid_product_promotions(id) ON DELETE CASCADE,
  provider_reference  TEXT NOT NULL, -- Razorpay Subscription ID or Order ID
  original_amount     INTEGER NOT NULL, -- original price in paise
  discount_amount     INTEGER NOT NULL, -- discount applied in paise
  final_amount        INTEGER NOT NULL, -- final charged price in paise
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_promotion_redemption UNIQUE (user_id, promotion_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON paid_product_promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promotion ON paid_product_promo_redemptions(promotion_id);

-- 3. Seed FIRST50 Promotion mapping to the PREMIUM product
DO $$
DECLARE
  v_prod_id BIGINT;
BEGIN
  SELECT id INTO v_prod_id FROM paid_products WHERE code = 'PREMIUM';
  IF v_prod_id IS NOT NULL THEN
    INSERT INTO paid_product_promotions (
      code, product_id, discount_type, discount_value, eligibility_days, max_redemptions, is_enabled, recurring_offer_id
    )
    VALUES (
      'FIRST50', v_prod_id, 'percentage', 50, 7, 50, TRUE, 'offer_xxxxx'
    )
    ON CONFLICT (code) DO NOTHING;
  END IF;
END $$;
