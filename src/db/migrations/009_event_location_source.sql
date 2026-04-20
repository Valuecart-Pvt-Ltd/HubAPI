-- ============================================================
--  Migration 009: Add location + source to events
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'calendar';

COMMENT ON COLUMN events.location IS 'Meeting room, video link, or address';
COMMENT ON COLUMN events.source   IS 'calendar (synced) | manual (created in app)';
