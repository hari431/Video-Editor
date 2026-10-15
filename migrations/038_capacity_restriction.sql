-- 038_capacity_restriction.sql
-- Add max_active_members to paid_products table

ALTER TABLE paid_products
ADD COLUMN IF NOT EXISTS max_active_members INTEGER DEFAULT NULL;
