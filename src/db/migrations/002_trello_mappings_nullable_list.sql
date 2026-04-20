-- ─── Migration 002: make trello_list_id nullable, simplify unique constraint ───
--
-- Motivation: getBoardsByEmail caches boards from the Trello API before we
-- know which list a user wants to use.  The previous NOT NULL + three-column
-- unique key prevented that.  We collapse the constraint to (user_email,
-- trello_board_id) — one primary mapping row per user-board pair — and let
-- trello_list_id be populated lazily by getOrCreateList.

-- Step 1: drop the old three-column unique constraint (name is auto-generated).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trello_mappings'::regclass
      AND conname   = 'trello_mappings_user_email_trello_board_id_trello_list_id_key'
  ) THEN
    ALTER TABLE trello_mappings
      DROP CONSTRAINT trello_mappings_user_email_trello_board_id_trello_list_id_key;
  END IF;
END;
$$;

-- Step 2: allow NULL in trello_list_id.
ALTER TABLE trello_mappings
  ALTER COLUMN trello_list_id DROP NOT NULL;

-- Step 3: add the new two-column unique constraint (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trello_mappings'::regclass
      AND conname   = 'trello_mappings_user_email_board_unique'
  ) THEN
    ALTER TABLE trello_mappings
      ADD CONSTRAINT trello_mappings_user_email_board_unique
      UNIQUE (user_email, trello_board_id);
  END IF;
END;
$$;
