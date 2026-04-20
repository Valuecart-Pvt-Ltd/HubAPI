-- Migration 004: MOM activity log
-- Records key lifecycle events on MOM sessions for the activity timeline.

CREATE TABLE IF NOT EXISTS mom_activity_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES mom_sessions(id) ON DELETE CASCADE,
  actor_email TEXT        NOT NULL,
  event_type  TEXT        NOT NULL
    CHECK (event_type IN ('mom_created', 'mom_finalized', 'status_changed', 'trello_synced')),
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mom_activity_log_session_idx ON mom_activity_log (session_id);
CREATE INDEX IF NOT EXISTS mom_activity_log_created_idx ON mom_activity_log (created_at DESC);
