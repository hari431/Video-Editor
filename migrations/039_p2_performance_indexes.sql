-- 039_p2_performance_indexes.sql
-- P2: Safest database indexes for hot admin/dashboard queries.
-- Only adds indexes that match existing WHERE / ORDER BY predicates.
-- No application SQL changed. All indexes are IF NOT EXISTS and safe to re-run.

-- 1. users(created_at DESC)
-- Query: getUsersForAdmin() => SELECT ... FROM users ORDER BY u.created_at DESC
-- Existing indexes: access_expires_at, last_login_at, app_role — none on created_at.
-- Helps admin dashboard full scans to return sorted without explicit sort.
CREATE INDEX IF NOT EXISTS idx_users_created_at_desc ON users(created_at DESC);

-- 2. users(status, access_expires_at)
-- Query: getExpiringUsers() => WHERE status='active' AND access_expires_at IS NOT NULL
--        AND access_expires_at > NOW() AND access_expires_at <= NOW()+7d ORDER BY access_expires_at ASC
-- Existing idx_users_access_expires_at is single-column, cannot filter by status efficiently.
-- Composite allows index scan on status='active' then range on access_expires_at.
CREATE INDEX IF NOT EXISTS idx_users_status_access_expires_at ON users(status, access_expires_at);

-- 3. discussion_replies(discussion_id, status, created_at)
-- Query: getDiscussionReplies() => WHERE discussion_id=$1 AND status IN (...) ORDER BY created_at ASC
--        adminListDiscussionRepliesBatch() => WHERE discussion_id = ANY(...) ORDER BY discussion_id, created_at
-- Existing: single-column idx_discussion_replies_discussion / status — no composite.
-- Composite (discussion_id, status, created_at) covers both: prefix discussion_id for batch,
-- and discussion_id+status for filtered thread view.
CREATE INDEX IF NOT EXISTS idx_discussion_replies_discussion_status_created ON discussion_replies(discussion_id, status, created_at);

-- 4. interview_question_notes(user_id, updated_at DESC)
-- Query: getUserNotes() => WHERE user_id=$1 ORDER BY updated_at DESC
-- Existing: single-column user_id and updated_at — no composite.
-- Composite avoids sort and supports per-user pagination.
CREATE INDEX IF NOT EXISTS idx_interview_notes_user_updated_desc ON interview_question_notes(user_id, updated_at DESC);
