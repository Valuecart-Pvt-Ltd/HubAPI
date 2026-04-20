-- Add is_primary flag to trello_mappings
-- Only one row per user should have is_primary = TRUE at any time.

ALTER TABLE trello_mappings
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
