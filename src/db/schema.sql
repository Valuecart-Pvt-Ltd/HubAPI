-- ============================================================
--  ValueCart Mom — PostgreSQL Schema
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── departments ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS departments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        NOT NULL UNIQUE,
  name              TEXT        NOT NULL,
  password_hash     TEXT,                        -- NULL for OAuth-only accounts
  google_id         TEXT        UNIQUE,
  department        TEXT,                        -- free-text fallback / display
  avatar_url        TEXT,
  trello_member_id      TEXT,
  google_access_token   TEXT,
  google_refresh_token  TEXT,
  google_token_expiry   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx     ON users (email);
CREATE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id);

-- ─── user_departments (M2M) ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_departments (
  user_id       UUID NOT NULL REFERENCES users (id)       ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);

-- ─── events ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_event_id    TEXT        UNIQUE,
  title              TEXT        NOT NULL,
  description        TEXT,
  start_time         TIMESTAMPTZ NOT NULL,
  end_time           TIMESTAMPTZ NOT NULL,
  organizer_email    TEXT        NOT NULL,
  is_external        BOOLEAN     NOT NULL DEFAULT FALSE,
  trello_board_id    TEXT,
  trello_board_name  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_organizer_idx      ON events (organizer_email);
CREATE INDEX IF NOT EXISTS events_start_time_idx     ON events (start_time);
CREATE INDEX IF NOT EXISTS events_google_event_id_idx ON events (google_event_id);

-- ─── event_attendees ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id        UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id         UUID          REFERENCES users (id)  ON DELETE SET NULL,
  email           TEXT NOT NULL,
  response_status TEXT NOT NULL DEFAULT 'needsAction'
    CHECK (response_status IN ('accepted', 'declined', 'tentative', 'needsAction')),
  PRIMARY KEY (event_id, email)
);

CREATE INDEX IF NOT EXISTS event_attendees_user_idx  ON event_attendees (user_id);
CREATE INDEX IF NOT EXISTS event_attendees_email_idx ON event_attendees (email);

-- ─── mom_sessions ────────────────────────────────────────────────────────────

CREATE TYPE mom_status AS ENUM ('draft', 'final');

CREATE TABLE IF NOT EXISTS mom_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  created_by  UUID        NOT NULL REFERENCES users (id),
  status      mom_status  NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mom_sessions_event_idx      ON mom_sessions (event_id);
CREATE INDEX IF NOT EXISTS mom_sessions_created_by_idx ON mom_sessions (created_by);

-- ─── mom_items ───────────────────────────────────────────────────────────────

CREATE TYPE mom_item_status AS ENUM ('pending', 'in-progress', 'completed');

CREATE TABLE IF NOT EXISTS mom_items (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  mom_session_id  UUID            NOT NULL REFERENCES mom_sessions (id) ON DELETE CASCADE,
  serial_number   INT             NOT NULL,
  category        TEXT            NOT NULL,
  action_item     TEXT            NOT NULL,
  owner_email     TEXT,
  eta             DATE,
  status          mom_item_status NOT NULL DEFAULT 'pending',
  trello_card_id  TEXT,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (mom_session_id, serial_number)
);

CREATE INDEX IF NOT EXISTS mom_items_session_idx       ON mom_items (mom_session_id);
CREATE INDEX IF NOT EXISTS mom_items_owner_email_idx   ON mom_items (owner_email);
CREATE INDEX IF NOT EXISTS mom_items_trello_card_idx   ON mom_items (trello_card_id);

-- ─── trello_mappings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trello_mappings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email        TEXT NOT NULL,
  trello_board_id   TEXT NOT NULL,
  trello_board_name TEXT NOT NULL,
  trello_list_id    TEXT NOT NULL,
  department_id     UUID REFERENCES departments (id) ON DELETE SET NULL,
  UNIQUE (user_email, trello_board_id, trello_list_id)
);

CREATE INDEX IF NOT EXISTS trello_mappings_user_email_idx    ON trello_mappings (user_email);
CREATE INDEX IF NOT EXISTS trello_mappings_board_id_idx      ON trello_mappings (trello_board_id);
CREATE INDEX IF NOT EXISTS trello_mappings_department_id_idx ON trello_mappings (department_id);

-- ─── updated_at auto-update trigger ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['events', 'mom_sessions', 'mom_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END;
$$;
