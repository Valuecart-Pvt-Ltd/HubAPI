-- Migration 003: webhook_settings table
-- Stores per-user webhook configuration for Read.ai and Fireflies.ai

CREATE TABLE IF NOT EXISTS webhook_settings (
  id           SERIAL PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     VARCHAR(50) NOT NULL,           -- 'readai' | 'fireflies'
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  webhook_key  UUID        NOT NULL DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_settings_user_provider_unique UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS webhook_settings_key_idx ON webhook_settings (webhook_key);

-- Ensure gen_random_uuid() is available (requires pgcrypto on older Postgres)
-- On Postgres 13+ it is built-in.  If on an older version, run:
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- before this migration.
