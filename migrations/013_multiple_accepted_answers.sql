-- 013_multiple_accepted_answers.sql — Multiple accepted answers per question
-- Replaces single discussions.accepted_reply_id with discussion_replies.accepted_at
-- Supports 0..N accepted replies per discussion.

-- 1. Add accepted_at to replies (nullable timestamp, null = not accepted)
ALTER TABLE discussion_replies ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ NULL;

-- Index for accepted lookups
CREATE INDEX IF NOT EXISTS idx_discussion_replies_accepted_at ON discussion_replies(accepted_at) WHERE accepted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discussion_replies_discussion_accepted ON discussion_replies(discussion_id, accepted_at) WHERE accepted_at IS NOT NULL;

-- 2. Migrate existing single accepted data (if any) into new column
-- Only migrate visible replies; hidden/deleted should not remain accepted
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='discussions' AND column_name='accepted_reply_id') THEN
    UPDATE discussion_replies r
    SET accepted_at = COALESCE(
      (SELECT d.updated_at FROM discussions d WHERE d.accepted_reply_id = r.id),
      NOW()
    )
    WHERE EXISTS (SELECT 1 FROM discussions d WHERE d.accepted_reply_id = r.id)
      AND r.accepted_at IS NULL
      AND r.status = 'visible';
  END IF;
END $$;

-- 3. Clear any accepted that is hidden/deleted (safety, idempotent)
UPDATE discussion_replies SET accepted_at = NULL WHERE accepted_at IS NOT NULL AND status != 'visible';

-- 4. Drop old single-answer artifacts (idempotent)
DROP INDEX IF EXISTS idx_discussions_accepted_reply_unique;
DROP INDEX IF EXISTS idx_discussions_accepted_reply;
-- Drop FK constraint if it exists (name is auto-generated, so drop column will handle it, but we try explicit)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='discussions' AND column_name='accepted_reply_id') THEN
    -- Drop foreign key constraint if present (look up name)
    PERFORM 1;
    -- The column itself carries the FK; dropping column will drop constraint
    ALTER TABLE discussions DROP COLUMN IF EXISTS accepted_reply_id;
  END IF;
END $$;

COMMENT ON COLUMN discussion_replies.accepted_at IS 'Accepted answer timestamp; NULL = not accepted, NOT NULL = accepted. Multiple replies per discussion can be accepted. Cleared when reply hidden/deleted.';
