-- Migration 043: short share links for library items (/s/<code>).
-- One stable opaque code per exact library file path. The code carries no
-- path, filename, user or access information; opening a short URL always
-- redirects to the canonical content route, which re-applies the existing
-- authentication + authorization checks. The link itself grants nothing.
-- Companion/hidden _1.txt metadata files are rejected at the API layer and
-- never receive share links.

CREATE TABLE IF NOT EXISTS share_links (
  file_path TEXT PRIMARY KEY,
  share_code TEXT NOT NULL UNIQUE,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_links_code ON share_links(share_code);
