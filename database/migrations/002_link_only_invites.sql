-- Migration 002: link-only invites, in-app-only alert prefs (owner decisions, 3 Nov 2026).
-- * Invites no longer carry a phone number: whoever opens the link and is
--   logged in can accept it once. full_name becomes `label`, the inviter's
--   own note ("Rohan (son)").
-- * Alerts are in-app only in v1, so the push/SMS switches go.
BEGIN;

ALTER TABLE device_invites DROP COLUMN phone;           -- also drops device_invites_phone_idx
ALTER TABLE device_invites RENAME COLUMN full_name TO label;
ALTER TABLE device_invites ADD CONSTRAINT device_invites_label_length
  CHECK (char_length(btrim(label)) BETWEEN 1 AND 60);

ALTER TABLE staff_invites DROP COLUMN phone;            -- also drops staff_invites_phone_idx
ALTER TABLE staff_invites RENAME COLUMN full_name TO label;
ALTER TABLE staff_invites ADD CONSTRAINT staff_invites_label_length
  CHECK (char_length(btrim(label)) BETWEEN 1 AND 60);
CREATE INDEX staff_invites_open_idx ON staff_invites (created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE user_notification_prefs DROP COLUMN push_enabled, DROP COLUMN sms_enabled;
COMMENT ON COLUMN user_notification_prefs.quiet_enabled IS 'in quiet hours only critical alerts pop up in the app';

-- "Show me alerts from": one person mutes one sensor for themselves only.
-- A separate table (not a flag on device_shares) because the owner has no
-- share row. Alerts for a muted device are not shown to that user.
CREATE TABLE user_device_alert_mutes (
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

COMMIT;
