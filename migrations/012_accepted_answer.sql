-- 012_accepted_answer.sql — Accepted Answer for discussions
-- Adds accepted_reply_id to discussions, with FK and uniqueness, and clears on hidden/deleted.

-- 1. Add column if not exists (nullable, references discussion_replies)
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS accepted_reply_id BIGINT REFERENCES discussion_replies(id) ON DELETE SET NULL;

-- 2. Unique partial index: a reply can be accepted for at most one question
CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_accepted_reply_unique ON discussions(accepted_reply_id) WHERE accepted_reply_id IS NOT NULL;

-- 3. Index for lookup
CREATE INDEX IF NOT EXISTS idx_discussions_accepted_reply ON discussions(accepted_reply_id);

-- 4. Ensure any already-accepted-but-now-hidden/deleted is cleared (idempotent, safe)
-- This handles the case where migration runs after some replies were hidden/deleted
UPDATE discussions d SET accepted_reply_id = NULL
WHERE accepted_reply_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM discussion_replies r
    WHERE r.id = d.accepted_reply_id
      AND r.status != 'visible'
  );

COMMENT ON COLUMN discussions.accepted_reply_id IS 'Accepted answer reply id; at most one per question, must be a visible reply of this discussion. Cleared when reply hidden/deleted.';
