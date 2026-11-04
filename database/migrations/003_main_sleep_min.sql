-- Migration 003: admin-editable "main sleep" threshold (owner decision, 4 Nov 2026).
-- A group of sessions counts as a date's main sleep only if it is at least
-- this many minutes in bed; a date with only shorter groups has naps only.
BEGIN;

ALTER TABLE app_settings
  ADD COLUMN main_sleep_min SMALLINT NOT NULL DEFAULT 180 CHECK (main_sleep_min BETWEEN 60 AND 600);

COMMIT;
