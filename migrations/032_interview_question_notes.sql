-- 032_interview_question_notes.sql
-- Dedicated table for private learner notes on interview questions with a unique (user_id, question_key) constraint

CREATE TABLE IF NOT EXISTS interview_question_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  category_slug TEXT,
  article_slug TEXT,
  question_index INTEGER DEFAULT 0,
  question_text TEXT NOT NULL,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_interview_notes_user_question UNIQUE (user_id, question_key)
);

CREATE INDEX IF NOT EXISTS idx_interview_notes_user_id ON interview_question_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_interview_notes_question_key ON interview_question_notes(question_key);
CREATE INDEX IF NOT EXISTS idx_interview_notes_article_slug ON interview_question_notes(article_slug);
CREATE INDEX IF NOT EXISTS idx_interview_notes_updated_at ON interview_question_notes(updated_at DESC);
