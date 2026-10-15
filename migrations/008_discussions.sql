-- Q&A / Discussion feature
-- Soft-delete via status: 'visible' | 'hidden'

CREATE TABLE discussions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_path   TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_discussions_item_path ON discussions (item_path);
CREATE INDEX idx_discussions_user_id   ON discussions (user_id);
CREATE INDEX idx_discussions_status    ON discussions (status);
CREATE INDEX idx_discussions_created   ON discussions (created_at DESC);

CREATE TABLE discussion_replies (
  id            BIGSERIAL PRIMARY KEY,
  discussion_id BIGINT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_discussion_replies_discussion ON discussion_replies (discussion_id);
CREATE INDEX idx_discussion_replies_user_id    ON discussion_replies (user_id);
CREATE INDEX idx_discussion_replies_status     ON discussion_replies (status);
