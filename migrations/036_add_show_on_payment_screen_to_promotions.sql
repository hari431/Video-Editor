-- 036_add_show_on_payment_screen_to_promotions.sql
-- Add show_on_payment_screen column to paid_product_promotions table

ALTER TABLE paid_product_promotions
ADD COLUMN show_on_payment_screen BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE paid_product_promotions SET show_on_payment_screen = TRUE WHERE show_on_payment_screen IS FALSE;
