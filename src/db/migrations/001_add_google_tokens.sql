-- Migration 001 — add Google OAuth token columns to users table
-- Run this against existing databases that were created before this migration.
-- schema.sql already includes these columns for fresh installs.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_access_token  TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS google_token_expiry  TIMESTAMPTZ;
