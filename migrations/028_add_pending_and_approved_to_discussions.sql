-- Add 'pending' and 'approved' to discussions and discussion_replies status constraints
ALTER TABLE discussions
  DROP CONSTRAINT IF EXISTS discussions_status_check;
ALTER TABLE discussions
  ADD CONSTRAINT discussions_status_check CHECK (status IN ('pending', 'approved', 'visible', 'hidden', 'deleted'));

ALTER TABLE discussion_replies
  DROP CONSTRAINT IF EXISTS discussion_replies_status_check;
ALTER TABLE discussion_replies
  ADD CONSTRAINT discussion_replies_status_check CHECK (status IN ('pending', 'approved', 'visible', 'hidden', 'deleted'));
