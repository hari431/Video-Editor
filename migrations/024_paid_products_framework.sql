-- 024_paid_products_framework.sql
-- Unified Paid Products, Plans, Orders, Grants, and Entitlements Framework

-- ── 1. Enhance user_roles to distinguish manual vs payment_system assignments ──

ALTER TABLE user_roles 
ADD COLUMN IF NOT EXISTS assignment_source TEXT NOT NULL DEFAULT 'manual';

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_roles_assignment_source'
  ) THEN
    ALTER TABLE user_roles 
    ADD CONSTRAINT chk_user_roles_assignment_source 
    CHECK (assignment_source IN ('manual', 'payment_system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_roles_source ON user_roles(user_id, role_id, assignment_source);

-- ── 2. Products Catalog ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paid_products (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paid_products_role_id ON paid_products(role_id);
CREATE INDEX IF NOT EXISTS idx_paid_products_code ON paid_products(code);

-- ── 3. Product Plans (Recurring vs One-Time Variants) ──────────────────────────

CREATE TABLE IF NOT EXISTS paid_product_plans (
  id                 BIGSERIAL PRIMARY KEY,
  product_id         BIGINT NOT NULL REFERENCES paid_products(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  billing_type       TEXT NOT NULL CHECK (billing_type IN ('recurring', 'one_time')),
  price_amount_paise INTEGER NOT NULL CHECK (price_amount_paise >= 0),
  currency           TEXT NOT NULL DEFAULT 'INR',
  duration_days      INTEGER,
  razorpay_plan_id   TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, code)
);

CREATE INDEX IF NOT EXISTS idx_paid_product_plans_product_id ON paid_product_plans(product_id);

-- ── 4. Orders Ledger (Immutable records of checkouts & payments) ───────────────

CREATE TABLE IF NOT EXISTS paid_orders (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id          BIGINT NOT NULL REFERENCES paid_products(id) ON DELETE RESTRICT,
  plan_id             BIGINT REFERENCES paid_product_plans(id) ON DELETE RESTRICT,
  amount_paise        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
  provider            TEXT NOT NULL DEFAULT 'razorpay',
  provider_order_id   TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  promo_code          TEXT,
  discount_paise      INTEGER NOT NULL DEFAULT 0,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paid_orders_user_product ON paid_orders(user_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_paid_orders_provider_order ON paid_orders(provider_order_id);

-- ── 5. Subscriptions Master Table (Recurring billing agreements) ───────────────

CREATE TABLE IF NOT EXISTS paid_subscriptions (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id               BIGINT NOT NULL REFERENCES paid_products(id) ON DELETE RESTRICT,
  plan_id                  BIGINT REFERENCES paid_product_plans(id) ON DELETE RESTRICT,
  provider                 TEXT NOT NULL DEFAULT 'razorpay',
  provider_customer_id     TEXT,
  provider_subscription_id TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL CHECK (status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at             TIMESTAMPTZ,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paid_subscriptions_user_product ON paid_subscriptions(user_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_paid_subscriptions_provider_sub ON paid_subscriptions(provider_subscription_id);

-- ── 6. Append-Only Entitlement Grants (Multiple rows allowed per user/product) ──

CREATE TABLE IF NOT EXISTS user_product_grants (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id         BIGINT NOT NULL REFERENCES paid_products(id) ON DELETE CASCADE,
  plan_id            BIGINT REFERENCES paid_product_plans(id) ON DELETE SET NULL,
  grant_type         TEXT NOT NULL CHECK (grant_type IN ('subscription_cycle', 'one_time_purchase', 'manual', 'promotion')),
  status             TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'superseded')),
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until        TIMESTAMPTZ,
  order_id           BIGINT REFERENCES paid_orders(id) ON DELETE SET NULL,
  subscription_id    BIGINT REFERENCES paid_subscriptions(id) ON DELETE SET NULL,
  granted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  grant_reason       TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grants_user_product_active ON user_product_grants(user_id, product_id, status, valid_until);
CREATE INDEX IF NOT EXISTS idx_grants_user_valid_until ON user_product_grants(user_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_grants_subscription_id ON user_product_grants(subscription_id);

-- ── 7. Events and Audit Log ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paid_product_events (
  id                BIGSERIAL PRIMARY KEY,
  product_id        BIGINT REFERENCES paid_products(id) ON DELETE SET NULL,
  user_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  entitlement_id    BIGINT REFERENCES user_product_grants(id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL,
  provider_event_id TEXT,
  previous_status   TEXT,
  new_status        TEXT,
  message           TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paid_events_provider_event ON paid_product_events(provider_event_id);
CREATE INDEX IF NOT EXISTS idx_paid_events_user_product ON paid_product_events(user_id, product_id);

-- ── 8. Seed PREMIUM Product & Plans ───────────────────────────────────────────

-- Ensure built-in PREMIUM role exists
INSERT INTO roles (name, description)
VALUES ('PREMIUM', 'Built-in Premium role')
ON CONFLICT (name) DO NOTHING;

-- Seed PREMIUM product
INSERT INTO paid_products (code, name, description, role_id, is_enabled)
SELECT 'PREMIUM', 'Premium Membership', 'Access to premium query files and video content', r.id, TRUE
FROM roles r
WHERE r.name = 'PREMIUM'
ON CONFLICT (code) DO NOTHING;

-- Seed plans for PREMIUM
DO $$
DECLARE
  v_prod_id BIGINT;
BEGIN
  SELECT id INTO v_prod_id FROM paid_products WHERE code = 'PREMIUM';
  IF v_prod_id IS NOT NULL THEN
    -- Monthly recurring subscription
    INSERT INTO paid_product_plans (product_id, code, name, billing_type, price_amount_paise, currency, duration_days, is_active)
    VALUES (v_prod_id, 'monthly', 'Premium Monthly Subscription', 'recurring', 30000, 'INR', NULL, TRUE)
    ON CONFLICT (product_id, code) DO NOTHING;

    -- One-time pass
    INSERT INTO paid_product_plans (product_id, code, name, billing_type, price_amount_paise, currency, duration_days, is_active)
    VALUES (v_prod_id, 'one_time_pass', 'Premium 30-Day Pass', 'one_time', 30000, 'INR', 30, TRUE)
    ON CONFLICT (product_id, code) DO NOTHING;
  END IF;
END $$;

-- ── 9. Backfill Existing Premium Subscriptions & Grants ────────────────────────

DO $$
DECLARE
  v_product_id BIGINT;
  v_plan_id BIGINT;
BEGIN
  SELECT id INTO v_product_id FROM paid_products WHERE code = 'PREMIUM';
  SELECT id INTO v_plan_id FROM paid_product_plans WHERE product_id = v_product_id AND code = 'monthly';

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'premium_subscriptions') THEN
    -- Backfill subscriptions into paid_subscriptions
    INSERT INTO paid_subscriptions (
      user_id, product_id, plan_id, provider, provider_customer_id,
      provider_subscription_id, status, current_period_start, current_period_end,
      cancel_at_period_end, created_at, updated_at
    )
    SELECT
      ps.user_id,
      v_product_id,
      v_plan_id,
      ps.provider,
      ps.provider_customer_id,
      ps.provider_subscription_id,
      CASE
        WHEN ps.status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired') THEN ps.status
        ELSE 'active'
      END,
      ps.current_period_start,
      ps.current_period_end,
      COALESCE(ps.cancel_at_period_end, FALSE),
      ps.created_at,
      ps.updated_at
    FROM premium_subscriptions ps
    ON CONFLICT (provider_subscription_id) DO NOTHING;

    -- Backfill subscription grants into user_product_grants
    INSERT INTO user_product_grants (
      user_id, product_id, plan_id, grant_type, status,
      valid_from, valid_until, subscription_id, grant_reason, created_at, updated_at
    )
    SELECT
      new_ps.user_id,
      new_ps.product_id,
      new_ps.plan_id,
      'subscription_cycle',
      CASE
        WHEN new_ps.status = 'active' AND (new_ps.current_period_end IS NULL OR new_ps.current_period_end > NOW()) THEN 'active'
        ELSE 'expired'
      END,
      COALESCE(new_ps.current_period_start, new_ps.created_at),
      new_ps.current_period_end,
      new_ps.id,
      'Backfilled from premium_subscriptions: ' || new_ps.provider_subscription_id,
      new_ps.created_at,
      new_ps.updated_at
    FROM paid_subscriptions new_ps
    WHERE new_ps.product_id = v_product_id
      AND NOT EXISTS (
        SELECT 1 FROM user_product_grants upg
        WHERE upg.subscription_id = new_ps.id
      );
  END IF;
END $$;

-- ── 10. Backfill Existing One-Time Passes ──────────────────────────────────────

DO $$
DECLARE
  v_product_id BIGINT;
  v_plan_id BIGINT;
BEGIN
  SELECT id INTO v_product_id FROM paid_products WHERE code = 'PREMIUM';
  SELECT id INTO v_plan_id FROM paid_product_plans WHERE product_id = v_product_id AND code = 'one_time_pass';

  INSERT INTO user_product_grants (
    user_id, product_id, plan_id, grant_type, status,
    valid_from, valid_until, grant_reason, created_at
  )
  SELECT
    u.id,
    v_product_id,
    v_plan_id,
    'one_time_purchase',
    CASE
      WHEN u.access_expires_at IS NOT NULL AND u.access_expires_at > NOW() THEN 'active'
      ELSE 'expired'
    END,
    COALESCE(u.created_at, NOW()),
    u.access_expires_at,
    'Backfilled from users.premium_source = one_time',
    COALESCE(u.created_at, NOW())
  FROM users u
  WHERE u.premium_source = 'one_time'
    AND NOT EXISTS (
      SELECT 1 FROM user_product_grants upg
      WHERE upg.user_id = u.id
        AND upg.product_id = v_product_id
        AND upg.grant_type = 'one_time_purchase'
    );
END $$;

-- ── 11. Backfill Existing Manual Premium Grants ────────────────────────────────

DO $$
DECLARE
  v_product_id BIGINT;
BEGIN
  SELECT id INTO v_product_id FROM paid_products WHERE code = 'PREMIUM';

  INSERT INTO user_product_grants (
    user_id, product_id, plan_id, grant_type, status,
    valid_from, valid_until, grant_reason, created_at
  )
  SELECT
    u.id,
    v_product_id,
    NULL,
    'manual',
    'active',
    COALESCE(u.created_at, NOW()),
    NULL, -- Lifetime / indefinite manual grant
    'Backfilled from users.premium_source = manual',
    COALESCE(u.created_at, NOW())
  FROM users u
  WHERE u.premium_source = 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM user_product_grants upg
      WHERE upg.user_id = u.id
        AND upg.product_id = v_product_id
        AND upg.grant_type = 'manual'
    );
END $$;

-- ── 12. Backfill RBAC Assignment Sources ───────────────────────────────────────

DO $$
DECLARE
  v_premium_role_id BIGINT;
BEGIN
  SELECT id INTO v_premium_role_id FROM roles WHERE name = 'PREMIUM';

  IF v_premium_role_id IS NOT NULL THEN
    -- By default, all rows in user_roles have assignment_source = 'manual'.
    -- We transition only those with automated payment source (subscription or one_time)
    -- and who are NOT OWNER or ADMIN to 'payment_system'.
    -- OWNER and ADMIN accounts, and manually granted users remain strictly 'manual'.
    UPDATE user_roles ur
    SET assignment_source = 'payment_system'
    FROM users u
    WHERE ur.user_id = u.id
      AND ur.role_id = v_premium_role_id
      AND u.app_role NOT IN ('OWNER', 'ADMIN')
      AND u.premium_source IN ('subscription', 'one_time');
  END IF;
END $$;

-- ── 13. Backfill Webhook Events from legacy table if available ────────────────

DO $$
DECLARE
  v_product_id BIGINT;
BEGIN
  SELECT id INTO v_product_id FROM paid_products WHERE code = 'PREMIUM';
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'premium_subscription_events') THEN
    INSERT INTO paid_product_events (
      product_id, user_id, event_type, provider_event_id,
      previous_status, new_status, message, created_at
    )
    SELECT
      v_product_id,
      pse.user_id,
      pse.event_type,
      pse.provider_event_id,
      pse.previous_status,
      pse.new_status,
      pse.message,
      pse.created_at
    FROM premium_subscription_events pse
    WHERE pse.provider_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM paid_product_events ppe
        WHERE ppe.provider_event_id = pse.provider_event_id
      );
  END IF;
END $$;
