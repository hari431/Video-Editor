-- 033_role_notes_permission.sql — Role-controlled Private Notes Capability & Generic Content Notes
-- Allows roles to grant "Notes" capability (notes_available).
-- Generalizes notes storage to support all content types (TXT, Word, PDF, Excel, Video, Interview Questions).
-- Safe and idempotent to re-run.

-- 1. Add notes_available column to roles table
ALTER TABLE roles ADD COLUMN IF NOT EXISTS notes_available BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Update content_action_permissions check constraint to include 'NOTES'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_action_permissions_permission_check'
  ) THEN
    ALTER TABLE content_action_permissions DROP CONSTRAINT content_action_permissions_permission_check;
  END IF;
  
  ALTER TABLE content_action_permissions 
    ADD CONSTRAINT content_action_permissions_permission_check 
    CHECK (permission IN ('COPY_QUERY', 'DOWNLOAD_PDF', 'NOTES'));
EXCEPTION
  WHEN undefined_table THEN
    -- table may not exist in mock environments
    NULL;
END $$;

-- 3. Update content_permission_audit_log check constraint to include 'NOTES'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_permission_audit_log_permission_check'
  ) THEN
    ALTER TABLE content_permission_audit_log DROP CONSTRAINT content_permission_audit_log_permission_check;
  END IF;

  ALTER TABLE content_permission_audit_log 
    ADD CONSTRAINT content_permission_audit_log_permission_check 
    CHECK (permission IN ('COPY_QUERY', 'DOWNLOAD_PDF', 'NOTES'));
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

-- 4. Enhance interview_question_notes to support generic content notes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'interview_question_notes') THEN
    ALTER TABLE interview_question_notes ADD COLUMN IF NOT EXISTS content_key TEXT;
    ALTER TABLE interview_question_notes ADD COLUMN IF NOT EXISTS content_type TEXT;
    ALTER TABLE interview_question_notes ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE interview_question_notes ALTER COLUMN question_text DROP NOT NULL;
    ALTER TABLE interview_question_notes ALTER COLUMN question_text SET DEFAULT '';
    
    UPDATE interview_question_notes SET content_key = question_key WHERE content_key IS NULL;
    
    CREATE INDEX IF NOT EXISTS idx_interview_notes_content_key ON interview_question_notes(user_id, content_key);
  END IF;
END $$;
