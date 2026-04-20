-- ============================================================
--  Migration 008: MOM item comments
-- ============================================================

CREATE TABLE IF NOT EXISTS mom_item_comments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mom_item_id  UUID        NOT NULL REFERENCES mom_items (id) ON DELETE CASCADE,
  author_email TEXT        NOT NULL,
  author_name  TEXT        NOT NULL DEFAULT '',
  comment      TEXT        NOT NULL CHECK (char_length(trim(comment)) > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mom_item_comments_item_idx
  ON mom_item_comments (mom_item_id);

CREATE INDEX IF NOT EXISTS mom_item_comments_author_idx
  ON mom_item_comments (author_email);
