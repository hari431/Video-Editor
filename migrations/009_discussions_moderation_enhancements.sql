-- Discussion moderation enhancements
-- Add support for 'deleted' status and track deletion metadata
-- Increase content length validation support

-- Update discussions table to support 'deleted' status and track deletion metadata
ALTER TABLE discussions
  DROP CONSTRAINT discussions_status_check,
  ADD CONSTRAINT discussions_status_check CHECK (status IN ('visible', 'hidden', 'deleted')),
  ADD COLUMN deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN deleted_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- Update discussion_replies table to support 'deleted' status and track deletion metadata
ALTER TABLE discussion_replies
  DROP CONSTRAINT discussion_replies_status_check,
  ADD CONSTRAINT discussion_replies_status_check CHECK (status IN ('visible', 'hidden', 'deleted')),
  ADD COLUMN deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN deleted_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- Create indexes for efficiency when filtering deleted content
CREATE INDEX idx_discussions_deleted_at ON discussions (deleted_at DESC) WHERE status = 'deleted';
CREATE INDEX idx_discussion_replies_deleted_at ON discussion_replies (deleted_at DESC) WHERE status = 'deleted';
CREATE INDEX idx_discussions_deleted_by ON discussions (deleted_by);
CREATE INDEX idx_discussion_replies_deleted_by ON discussion_replies (deleted_by);
