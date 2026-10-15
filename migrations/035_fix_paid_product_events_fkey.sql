-- Fix foreign key constraint for paid_product_events to allow product deletion

ALTER TABLE paid_product_events
  DROP CONSTRAINT IF EXISTS paid_product_events_product_id_fkey;

ALTER TABLE paid_product_events
  ADD CONSTRAINT paid_product_events_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES paid_products(id) ON DELETE SET NULL;

-- Also fix paid_orders so historical revenue records survive product/plan deletion
ALTER TABLE paid_orders
  ALTER COLUMN product_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS paid_orders_product_id_fkey;

ALTER TABLE paid_orders
  ADD CONSTRAINT paid_orders_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES paid_products(id) ON DELETE SET NULL;

ALTER TABLE paid_orders
  DROP CONSTRAINT IF EXISTS paid_orders_plan_id_fkey;

ALTER TABLE paid_orders
  ADD CONSTRAINT paid_orders_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES paid_product_plans(id) ON DELETE SET NULL;

-- Fix paid_subscriptions to survive product/plan deletion
ALTER TABLE paid_subscriptions
  ALTER COLUMN product_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS paid_subscriptions_product_id_fkey;

ALTER TABLE paid_subscriptions
  ADD CONSTRAINT paid_subscriptions_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES paid_products(id) ON DELETE SET NULL;

ALTER TABLE paid_subscriptions
  DROP CONSTRAINT IF EXISTS paid_subscriptions_plan_id_fkey;

ALTER TABLE paid_subscriptions
  ADD CONSTRAINT paid_subscriptions_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES paid_product_plans(id) ON DELETE SET NULL;


