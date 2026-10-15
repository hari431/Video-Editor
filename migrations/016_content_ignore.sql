-- 016_content_ignore.sql — Ignored/dismissed state for New / Missed Content
-- Extends the existing per-user content_seen design instead of adding a table.
-- A row is either 'seen' (user actually opened the content) or 'ignored'
-- (user dismissed it without opening). Both states exclude the item from
-- New / Missed Content, but the distinction is preserved so ignored content
-- is never silently treated as viewed (e.g. if eligibility rules later
-- re-surface modified content).
-- Existing rows backfill to 'seen' via the column DEFAULT, preserving the
-- established seen_at behavior. recently_viewed is untouched.

ALTER TABLE content_seen ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'seen';

ALTER TABLE content_seen DROP CONSTRAINT IF EXISTS content_seen_status_check;
ALTER TABLE content_seen ADD CONSTRAINT content_seen_status_check CHECK (status IN ('seen', 'ignored'));

-- Efficient lookup: a user's ignored vs seen items
CREATE INDEX IF NOT EXISTS idx_content_seen_user_status ON content_seen(user_id, status);
