-- ============================================================
--  Migration 010: Conference rooms
-- ============================================================
-- Stores bookable meeting rooms so the Create Event modal can
-- offer a room picker without depending solely on the Google
-- Calendar resource calendarList (which requires rooms to be
-- manually subscribed to by each user).

CREATE TABLE IF NOT EXISTS conference_rooms (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL UNIQUE,  -- Google Calendar resource email / booking address
  description TEXT        NOT NULL DEFAULT '',
  capacity    INT,
  building    TEXT,
  floor_label TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conference_rooms_name_idx ON conference_rooms (name);
