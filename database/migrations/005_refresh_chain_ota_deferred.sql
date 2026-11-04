-- Migration 005 (5 Nov 2026):
-- * refresh_tokens.replaced_by: which token replaced this one on rotation.
--   Lets a re-sent old token be told apart from theft: if its replacement
--   was never used, the client simply never got the reply (lost response,
--   or two tabs refreshing at once), so it gets a fresh pair, not a logout.
-- * ota_status 'deferred': the firmware postpones an OTA while a sleep
--   session is active; the server keeps re-offering it.
BEGIN;
ALTER TABLE refresh_tokens ADD COLUMN replaced_by UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL;
ALTER TYPE ota_status ADD VALUE IF NOT EXISTS 'deferred';
COMMIT;
