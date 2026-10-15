-- 005_item_likes_generalize.sql
-- Generalize the likes table so ALL library file types (video, pdf, doc,
-- xls, txt, images, ...) can be liked, not just videos.
--
-- The video_likes schema was already fully generic (path + user_id + unique);
-- this migration renames it to item_likes with an item_path column instead of
-- creating a duplicate table. video_views stays video-specific and untouched.

-- Rename the table and column only when the new shape does not exist yet.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'video_likes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'item_likes'
  ) THEN
    ALTER TABLE video_likes RENAME TO item_likes;
    ALTER TABLE item_likes RENAME COLUMN "video_path" TO "item_path";
  END IF;
END $$;

-- Rename the supporting indexes if they still carry their old names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'idx_video_likes_video_path'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'idx_item_likes_item_path'
  ) THEN
    ALTER INDEX idx_video_likes_video_path RENAME TO idx_item_likes_item_path;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'idx_video_likes_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'idx_item_likes_user_id'
  ) THEN
    ALTER INDEX idx_video_likes_user_id RENAME TO idx_item_likes_user_id;
  END IF;
END $$;

-- The auto-named UNIQUE(video_path, user_id) constraint follows the table
-- rename in newer Postgres; rename it explicitly if it kept its old name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'item_likes' AND c.conname = 'video_likes_video_path_user_id_key'
  ) THEN
    ALTER TABLE item_likes RENAME CONSTRAINT video_likes_video_path_user_id_key
      TO item_likes_item_path_user_id_key;
  END IF;
END $$;

-- Guarantee the final state is idempotent regardless of the path taken.
CREATE INDEX IF NOT EXISTS idx_item_likes_item_path ON item_likes(item_path);
CREATE INDEX IF NOT EXISTS idx_item_likes_user_id ON item_likes(user_id);