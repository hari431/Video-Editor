-- 019_ad_eligibility.sql — Content-level ad eligibility
-- Reusable mechanism for marking content/folders as ADS_ENABLED / ADS_DISABLED
-- Folder inheritance: child inherits nearest ancestor setting unless explicitly overridden.
-- Restricted/private content must not become ad-eligible (enforced server-side, not via table).
-- Defaults: Gosu learning content (txt/md/video) is logically eligible; PDFs and reference/download material are disabled by default (handled in code defaults).
-- Safe to re-run: all statements idempotent.

CREATE TABLE IF NOT EXISTS ad_settings (
  path TEXT PRIMARY KEY CHECK (path <> '' AND path NOT LIKE '%\0%'),
  ad_state TEXT NOT NULL CHECK (ad_state IN ('ADS_ENABLED','ADS_DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_settings_state ON ad_settings(ad_state);

COMMENT ON TABLE ad_settings IS 'Content-level ad eligibility with folder inheritance (ADS_ENABLED/DISABLED). Restricted content is disabled server-side regardless of this table.';
COMMENT ON COLUMN ad_settings.path IS 'Library path (folder or file) for ad eligibility; children inherit nearest ancestor.';
COMMENT ON COLUMN ad_settings.ad_state IS 'ADS_ENABLED or ADS_DISABLED';
