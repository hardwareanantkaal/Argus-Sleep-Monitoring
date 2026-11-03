-- =====================================================================
--  Argus Sleep Monitoring Platform - PostgreSQL schema  (v1.0)
--  Status: APPROVED 3 Nov 2026 (docs/DESIGN.md §10). Applied via database/migrations/.
--  Target: PostgreSQL 16 (postgres:16-alpine), same as the Water Tank project.
--  Read docs/DESIGN.md first: it explains every table in plain words.
--
--  Rules used everywhere (same as Water Tank):
--    * All times are TIMESTAMPTZ, stored in UTC. The app shows them in
--      the device's time zone (default Asia/Kolkata).
--    * Secrets (passwords, device secrets, claim codes, tokens, OTPs)
--      are stored only as hashes. Never the plain value.
--    * Live radar values (heart rate, breathing, movement, presence,
--      stage) are NOT stored. They stay in backend memory and go to the
--      browser over Socket.IO. The saved health record is the nightly
--      sleep summary (sleep_summaries).
--    * One permission system for the Argus team and for customer
--      families (permissions table).
--
--  Run:  psql -U postgres -d argus -f schema.sql
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fast "contains" search in admin tables

-- ---------------------------------------------------------------------
-- 0. Enum types
-- ---------------------------------------------------------------------
CREATE TYPE permission_scope AS ENUM ('staff', 'device');  -- staff = admin panel, device = one sensor
CREATE TYPE otp_purpose      AS ENUM ('verify_phone', 'reset_password');
CREATE TYPE sensor_mount     AS ENUM ('bedside', 'ceiling');
CREATE TYPE event_type       AS ENUM ('online', 'offline', 'reboot', 'config_mode',
                                      'settings_applied', 'radar_fault', 'radar_ok',
                                      'summary_received', 'logs_uploaded',
                                      'ota_started', 'ota_success', 'ota_failed',
                                      'claimed', 'unclaimed', 'disabled', 'enabled');
CREATE TYPE event_severity   AS ENUM ('info', 'warning', 'critical');
CREATE TYPE command_type     AS ENUM ('reboot', 'config_mode', 'ota_check', 'logs');
CREATE TYPE command_status   AS ENUM ('pending', 'sent', 'acked', 'failed', 'expired', 'cancelled');
CREATE TYPE fw_channel       AS ENUM ('beta', 'stable');
CREATE TYPE rollout_target   AS ENUM ('all', 'percent', 'serials', 'from_version');
CREATE TYPE rollout_status   AS ENUM ('running', 'paused', 'finished', 'cancelled');
CREATE TYPE ota_status       AS ENUM ('pending', 'sent', 'downloading', 'success', 'failed', 'skipped');
CREATE TYPE alert_type       AS ENUM ('breath_low', 'hr_out_of_range', 'out_of_bed',
                                      'no_movement', 'device_offline');
CREATE TYPE delivery_channel AS ENUM ('push', 'sms');
CREATE TYPE delivery_status  AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- Helper: keep updated_at current
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 1. Permissions and staff roles
--    One list of permission codes. 'staff' codes are switched on per
--    ROLE (Owner, Developer, Manufacturing, Support, custom...).
--    'device' codes are switched on per PERSON per sensor (family).
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,                     -- 'devices.view', 'history.view'
  scope       permission_scope NOT NULL,
  label       TEXT NOT NULL,                        -- shown next to the switch
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z]+\.[a-z_]+$')
);

CREATE TABLE staff_roles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,                 -- 'Owner', 'Support'
  is_owner    BOOLEAN NOT NULL DEFAULT false,       -- Owner always has every staff permission
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_roles_one_owner_uq ON staff_roles (is_owner) WHERE is_owner;
CREATE TRIGGER staff_roles_updated BEFORE UPDATE ON staff_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_role_permissions (
  role_id     INTEGER NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  permission  TEXT    NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission)
);

-- Only 'staff' permissions can be given to a role
CREATE FUNCTION check_permission_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE want permission_scope := TG_ARGV[0]::permission_scope;
BEGIN
  IF (SELECT scope FROM permissions WHERE code = NEW.permission) IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'permission % is not a % permission', NEW.permission, want;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_role_permissions_scope BEFORE INSERT OR UPDATE ON staff_role_permissions
  FOR EACH ROW EXECUTE FUNCTION check_permission_scope('staff');

-- ---------------------------------------------------------------------
-- 2. Users, login, sessions
--    Customers and staff are the same table. A user is staff when
--    staff_role_id is set (then they also see the admin panel).
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT        NOT NULL,
  phone             TEXT        NOT NULL,           -- E.164, e.g. +919825012345. This is the login.
  phone_verified_at TIMESTAMPTZ,
  password_hash     TEXT        NOT NULL,           -- bcrypt
  staff_role_id     INTEGER     REFERENCES staff_roles(id) ON DELETE RESTRICT,  -- NULL = customer only
  is_disabled       BOOLEAN     NOT NULL DEFAULT false,
  disabled_reason   TEXT,
  disabled_at       TIMESTAMPTZ,
  token_version     INTEGER     NOT NULL DEFAULT 0, -- bump to log the user out everywhere
  last_login_at     TIMESTAMPTZ,
  last_active_at    TIMESTAMPTZ,                    -- "Last active" column in admin tables
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,                    -- soft delete ("Delete account")
  CONSTRAINT users_phone_format CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT users_disabled_consistent CHECK (is_disabled = (disabled_at IS NOT NULL))
);
-- a phone number belongs to one live account; a deleted account frees it
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE deleted_at IS NULL;
CREATE INDEX users_staff_idx ON users (staff_role_id) WHERE staff_role_id IS NOT NULL;
CREATE INDEX users_name_trgm_idx  ON users USING gin (full_name gin_trgm_ops);
CREATE INDEX users_phone_trgm_idx ON users USING gin (phone gin_trgm_ops);
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Long-lived refresh tokens (short JWT access token + rotating refresh token)
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,         -- sha256 of the token
  user_agent   TEXT,
  ip           INET,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- One-time SMS codes (phone verification at sign-up, password reset)
CREATE TABLE otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT        NOT NULL,
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  purpose     otp_purpose NOT NULL,
  code_hash   TEXT        NOT NULL,
  attempts    SMALLINT    NOT NULL DEFAULT 0,       -- block after ~5 wrong tries
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_lookup_idx ON otp_codes (phone, purpose, created_at DESC);

-- Push notification targets (FCM token or Web Push subscription)
CREATE TABLE push_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT        NOT NULL UNIQUE,
  platform     TEXT        NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);

-- "How to reach me" on the Alerts screen. One row per user.
CREATE TABLE user_notification_prefs (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled   BOOLEAN NOT NULL DEFAULT true,
  sms_enabled    BOOLEAN NOT NULL DEFAULT false,
  quiet_enabled  BOOLEAN NOT NULL DEFAULT false,    -- in quiet hours only critical alerts are sent
  quiet_from     TIME,                              -- user's local time
  quiet_to       TIME,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prefs_quiet_times CHECK (NOT quiet_enabled OR (quiet_from IS NOT NULL AND quiet_to IS NOT NULL))
);
CREATE TRIGGER user_notification_prefs_updated BEFORE UPDATE ON user_notification_prefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Invite someone to the Argus team (SMS link). They join with this role.
CREATE TABLE staff_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT        NOT NULL,
  phone        TEXT        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role_id      INTEGER     NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_invites_phone_idx ON staff_invites (phone) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. Firmware (before devices)
-- ---------------------------------------------------------------------
CREATE TABLE firmware_releases (
  id           SERIAL PRIMARY KEY,
  version      TEXT        NOT NULL UNIQUE,         -- '1.4.3-beta'
  channel      fw_channel  NOT NULL DEFAULT 'beta',
  chip_model   TEXT        NOT NULL DEFAULT 'ESP32-S3',
  file_path    TEXT        NOT NULL,                -- on the server, e.g. /srv/ota/argus_1.4.3-beta.bin
  file_size    INTEGER     NOT NULL CHECK (file_size > 0),
  sha256       TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  notes        TEXT,                                -- "What changed"
  uploaded_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. Devices  (one device = one ESP32-S3 + one DFRobot C1001 radar)
-- ---------------------------------------------------------------------
CREATE TABLE devices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_no        TEXT        NOT NULL UNIQUE,     -- on the sticker, e.g. ARG-24A0012
  mac              MACADDR     NOT NULL UNIQUE,     -- read over USB at registration
  mqtt_username    TEXT        NOT NULL UNIQUE,     -- MAC as 12 lowercase hex chars
  secret_hash      TEXT        NOT NULL,            -- per-device MQTT secret (hash), written to the board over USB at registration (D1)
  claim_code_hash  TEXT,                            -- HMAC of the 12-char sticker claim code (D2). NULL once claimed
  chip_model       TEXT        NOT NULL,            -- 'ESP32-S3' (read over USB)
  hw_model         TEXT        NOT NULL,            -- 'ARG-S1 rev B'
  batch            TEXT,                            -- 'B-2026-11-A'
  manufactured_at  DATE,
  fw_at_register   TEXT,                            -- firmware flashed at the factory
  registered_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  owner_id         UUID        REFERENCES users(id) ON DELETE SET NULL,  -- one owner; family via device_shares
  claimed_at       TIMESTAMPTZ,
  name             TEXT,                            -- "Mom's bedroom"
  room             TEXT,                            -- "Master bedroom"
  is_disabled      BOOLEAN     NOT NULL DEFAULT false,  -- admin block: MQTT login refused
  disabled_reason  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT devices_serial_format CHECK (serial_no ~ '^ARG-[0-9A-Z]{7}$'),
  CONSTRAINT devices_mqtt_username_format CHECK (mqtt_username ~ '^[0-9a-f]{12}$'),
  CONSTRAINT devices_claim_consistent CHECK (
    (owner_id IS NULL AND claimed_at IS NULL) OR (owner_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);
CREATE INDEX devices_owner_idx ON devices (owner_id);
CREATE INDEX devices_claim_code_idx ON devices (claim_code_hash) WHERE claim_code_hash IS NOT NULL;
CREATE INDEX devices_serial_trgm_idx ON devices USING gin (serial_no gin_trgm_ops);
CREATE INDEX devices_name_trgm_idx   ON devices USING gin (name gin_trgm_ops);
CREATE TRIGGER devices_updated BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Settings that are sent to the sensor over MQTT (retained, versioned).
-- Same sync idea as Water Tank: any real change bumps `version`; the
-- device acks the version it saved -> applied_version.
-- The C1001 options are placeholders until its parameter list is confirmed.
CREATE TABLE device_settings (
  device_id          UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  timezone           TEXT         NOT NULL DEFAULT 'Asia/Kolkata',  -- decides when a "night" starts/ends
  mount              sensor_mount NOT NULL DEFAULT 'bedside',
  range_m            NUMERIC(2,1) NOT NULL DEFAULT 1.5 CHECK (range_m BETWEEN 0.5 AND 3.0),
  led_night_off      BOOLEAN      NOT NULL DEFAULT true,
  led_off_from       TIME         NOT NULL DEFAULT '22:00',
  led_off_to         TIME         NOT NULL DEFAULT '07:00',
  auto_update        BOOLEAN      NOT NULL DEFAULT true,           -- OTA only in the daytime window
  version            INTEGER      NOT NULL DEFAULT 1,
  applied_version    INTEGER      NOT NULL DEFAULT 0,
  sent_at            TIMESTAMPTZ,
  applied_at         TIMESTAMPTZ,
  updated_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT settings_applied_le_version CHECK (applied_version <= version)
);
CREATE TRIGGER device_settings_updated BEFORE UPDATE ON device_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- History of every settings change, filled by the trigger below
CREATE TABLE settings_changes (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version      INTEGER     NOT NULL,
  changed_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  old_values   JSONB       NOT NULL,                -- {"range_m": 1.5}
  new_values   JSONB       NOT NULL,                -- {"range_m": 2.5}
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at   TIMESTAMPTZ,                         -- when the device acked this version
  UNIQUE (device_id, version)
);

-- Copied from Water Tank (proven): bump version + log the diff on a real change
CREATE FUNCTION log_settings_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o JSONB := to_jsonb(OLD) - '{version,applied_version,sent_at,applied_at,updated_by,updated_at}'::text[];
  n JSONB := to_jsonb(NEW) - '{version,applied_version,sent_at,applied_at,updated_by,updated_at}'::text[];
  k TEXT;
  old_diff JSONB := '{}';
  new_diff JSONB := '{}';
BEGIN
  IF o = n THEN
    -- only sync columns changed (e.g. device ack): mark that version applied
    IF NEW.applied_version > OLD.applied_version THEN
      UPDATE settings_changes SET applied_at = COALESCE(NEW.applied_at, now())
       WHERE device_id = NEW.device_id AND version <= NEW.applied_version AND applied_at IS NULL;
    END IF;
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    IF o->k IS DISTINCT FROM n->k THEN
      old_diff := old_diff || jsonb_build_object(k, o->k);
      new_diff := new_diff || jsonb_build_object(k, n->k);
    END IF;
  END LOOP;
  INSERT INTO settings_changes (device_id, version, changed_by, old_values, new_values)
  VALUES (NEW.device_id, NEW.version, NEW.updated_by, old_diff, new_diff);
  RETURN NEW;
END $$;
CREATE TRIGGER device_settings_log BEFORE UPDATE ON device_settings
  FOR EACH ROW EXECUTE FUNCTION log_settings_change();

-- Connection health: one row per device. NO health values here
-- (heart rate etc. live only in backend memory).
CREATE TABLE device_state (
  device_id      UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  is_online      BOOLEAN     NOT NULL DEFAULT false,
  radar_ok       BOOLEAN,                           -- C1001 answering over UART
  fw_version     TEXT,
  ip             INET,
  wifi_ssid      TEXT,                              -- shown on the settings screen
  wifi_rssi      SMALLINT,
  uptime_s       INTEGER,
  last_seen_at   TIMESTAMPTZ,
  online_since   TIMESTAMPTZ,
  offline_since  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_state_online_idx ON device_state (is_online);
CREATE INDEX device_state_fw_idx ON device_state (fw_version);   -- "Firmware in the field" counts

-- ---------------------------------------------------------------------
-- 5. Family sharing (per-person permission switches)
-- ---------------------------------------------------------------------
CREATE TABLE device_shares (
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);
CREATE INDEX device_shares_user_idx ON device_shares (user_id);

CREATE TABLE device_share_permissions (
  device_id   UUID NOT NULL,
  user_id     UUID NOT NULL,
  permission  TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (device_id, user_id, permission),
  FOREIGN KEY (device_id, user_id) REFERENCES device_shares(device_id, user_id) ON DELETE CASCADE
);
CREATE TRIGGER device_share_permissions_scope BEFORE INSERT OR UPDATE ON device_share_permissions
  FOR EACH ROW EXECUTE FUNCTION check_permission_scope('device');

-- Invite by phone; works before the person has an account
CREATE TABLE device_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  full_name    TEXT        NOT NULL,
  phone        TEXT        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  permissions  TEXT[]      NOT NULL,                -- copied into device_share_permissions on accept
  token_hash   TEXT        NOT NULL UNIQUE,
  invited_by   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_invites_has_perms CHECK (cardinality(permissions) > 0)
);
CREATE INDEX device_invites_phone_idx ON device_invites (phone) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX device_invites_device_idx ON device_invites (device_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 6. Sleep summaries  (THE saved health record)
--    The sensor uploads one summary per night over MQTT. The backend
--    upserts on (device_id, night_date) so a retried upload is harmless.
--    Fields are placeholders until the C1001 output list is confirmed;
--    the full original payload is kept in `raw` so nothing is lost.
-- ---------------------------------------------------------------------
CREATE TABLE sleep_summaries (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  night_date         DATE        NOT NULL,          -- local date the night STARTED (2 Nov = night of 2->3 Nov)
  in_bed_at          TIMESTAMPTZ NOT NULL,
  out_of_bed_at      TIMESTAMPTZ NOT NULL,
  time_in_bed_min    SMALLINT    NOT NULL CHECK (time_in_bed_min BETWEEN 0 AND 1440),
  total_sleep_min    SMALLINT    NOT NULL CHECK (total_sleep_min BETWEEN 0 AND 1440),
  sleep_latency_min  SMALLINT    CHECK (sleep_latency_min BETWEEN 0 AND 1440),  -- "Fell asleep in"
  efficiency_pct     SMALLINT    CHECK (efficiency_pct BETWEEN 0 AND 100),
  deep_min           SMALLINT    NOT NULL DEFAULT 0 CHECK (deep_min  >= 0),
  light_min          SMALLINT    NOT NULL DEFAULT 0 CHECK (light_min >= 0),
  rem_min            SMALLINT    NOT NULL DEFAULT 0 CHECK (rem_min   >= 0),
  awake_min          SMALLINT    NOT NULL DEFAULT 0 CHECK (awake_min >= 0),
  wake_count         SMALLINT    CHECK (wake_count >= 0),
  out_of_bed_count   SMALLINT    CHECK (out_of_bed_count >= 0),
  turnover_count     SMALLINT    CHECK (turnover_count >= 0),
  hr_avg             SMALLINT    CHECK (hr_avg BETWEEN 20 AND 250),   -- bpm
  hr_min             SMALLINT    CHECK (hr_min BETWEEN 20 AND 250),
  hr_max             SMALLINT    CHECK (hr_max BETWEEN 20 AND 250),
  br_avg             NUMERIC(3,1) CHECK (br_avg BETWEEN 0 AND 60),    -- breaths / min
  br_min             NUMERIC(3,1) CHECK (br_min BETWEEN 0 AND 60),
  br_max             NUMERIC(3,1) CHECK (br_max BETWEEN 0 AND 60),
  score              SMALLINT    CHECK (score BETWEEN 0 AND 100),     -- who computes it: decision D6
  epoch_s            SMALLINT    NOT NULL DEFAULT 300,                -- one hypnogram block = 5 min
  stages             SMALLINT[]  NOT NULL DEFAULT '{}',               -- per epoch: 0 awake, 1 REM, 2 light, 3 deep
  fw_version         TEXT,
  raw                JSONB       NOT NULL,                            -- the exact payload the device sent
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, night_date),
  CONSTRAINT summary_out_after_in CHECK (out_of_bed_at > in_bed_at),
  CONSTRAINT summary_sleep_le_bed CHECK (total_sleep_min <= time_in_bed_min),
  CONSTRAINT summary_stage_values CHECK (stages <@ ARRAY[0,1,2,3]::SMALLINT[]),
  CONSTRAINT summary_stage_count CHECK (cardinality(stages) <= 288)  -- at most 24 h of 5-min blocks
);
-- the UNIQUE above also serves "last 14 nights for this device" (newest first via backward scan)
CREATE TRIGGER sleep_summaries_updated BEFORE UPDATE ON sleep_summaries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 7. Alerts
--    Rules are per DEVICE (everyone on the sensor shares them; editing
--    needs settings.edit). The backend checks them against live values.
--    How each person is reached is per USER (user_notification_prefs).
-- ---------------------------------------------------------------------
CREATE TABLE alert_rules (
  device_id     UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type          alert_type  NOT NULL,
  is_enabled    BOOLEAN     NOT NULL DEFAULT true,
  low_value     NUMERIC(5,1),         -- breath_low: 8 /min; hr_out_of_range: 45 bpm
  high_value    NUMERIC(5,1),         -- hr_out_of_range: 110 bpm
  duration_s    INTEGER CHECK (duration_s IS NULL OR duration_s > 0),
                                      -- breath 30 s, hr 60 s, out_of_bed 600 s, no_movement 10800 s, offline 900 s
  window_from   TIME,                 -- out_of_bed: only between 23:00 ...
  window_to     TIME,                 --             ... and 06:00 (device local time)
  updated_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, type),
  CONSTRAINT alert_rules_low_lt_high CHECK (low_value IS NULL OR high_value IS NULL OR low_value < high_value),
  CONSTRAINT alert_rules_window_pair CHECK ((window_from IS NULL) = (window_to IS NULL))
);
CREATE TRIGGER alert_rules_updated BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row each time a rule fires (the "Recent" alerts list)
CREATE TABLE alerts (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type         alert_type     NOT NULL,
  severity     event_severity NOT NULL,
  title        TEXT           NOT NULL,             -- "Breathing rate low: 7 /min"
  detail       TEXT,                                -- "Rule: breath rate below 8 /min for 30 s"
  value        NUMERIC(6,1),                        -- the reading that triggered it
  started_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,                         -- when the condition cleared
  CONSTRAINT alerts_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX alerts_device_time_idx ON alerts (device_id, started_at DESC);
-- at most one OPEN alert per device and type (stops repeat spam)
CREATE UNIQUE INDEX alerts_one_open_uq ON alerts (device_id, type) WHERE ended_at IS NULL;

-- Who was told about each alert, how, and whether it worked
CREATE TABLE alert_deliveries (
  alert_id    BIGINT           NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id     UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     delivery_channel NOT NULL,
  status      delivery_status  NOT NULL DEFAULT 'pending',
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, user_id, channel)
);
CREATE INDEX alert_deliveries_user_idx ON alert_deliveries (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. Device events, commands, uploaded logs
-- ---------------------------------------------------------------------
CREATE TABLE device_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type         event_type     NOT NULL,
  severity     event_severity NOT NULL DEFAULT 'info',
  occurred_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  message      TEXT,
  data         JSONB,
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX device_events_device_time_idx ON device_events (device_id, occurred_at DESC);
CREATE INDEX device_events_open_faults_idx ON device_events (device_id)
  WHERE severity <> 'info' AND resolved_at IS NULL;

CREATE TABLE device_commands (
  id            BIGSERIAL PRIMARY KEY,
  device_id     UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type          command_type   NOT NULL,
  payload       JSONB,
  requested_by  UUID           REFERENCES users(id) ON DELETE SET NULL,
  status        command_status NOT NULL DEFAULT 'pending',
  error         TEXT,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  acked_at      TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ    NOT NULL           -- backend sets it; long if offline queueing is kept (D4)
);
CREATE INDEX device_commands_device_time_idx ON device_commands (device_id, created_at DESC);
CREATE INDEX device_commands_open_idx ON device_commands (device_id, created_at)
  WHERE status IN ('pending', 'sent');

-- Result of the 'logs' command ("Upload the last 200 log lines")
CREATE TABLE device_log_uploads (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_id   BIGINT      REFERENCES device_commands(id) ON DELETE SET NULL,
  content      TEXT        NOT NULL CHECK (length(content) <= 65536),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_log_uploads_device_idx ON device_log_uploads (device_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 9. OTA rollouts
-- ---------------------------------------------------------------------
CREATE TABLE ota_rollouts (
  id                   SERIAL PRIMARY KEY,
  release_id           INTEGER        NOT NULL REFERENCES firmware_releases(id) ON DELETE RESTRICT,
  target               rollout_target NOT NULL,
  target_percent       SMALLINT       CHECK (target_percent BETWEEN 1 AND 100),
  target_from_version  TEXT,                         -- target = from_version
  window_from          TIME,                         -- install window, device local time
  window_to            TIME,                         -- NULL pair = any time
  status               rollout_status NOT NULL DEFAULT 'running',
  notes                TEXT,
  created_by           UUID           REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  CONSTRAINT rollout_percent_needed CHECK ((target = 'percent') = (target_percent IS NOT NULL)),
  CONSTRAINT rollout_version_needed CHECK ((target = 'from_version') = (target_from_version IS NOT NULL)),
  CONSTRAINT rollout_window_pair    CHECK ((window_from IS NULL) = (window_to IS NULL))
);
-- the chosen devices are frozen into this table when the rollout starts
-- (for 'serials' the admin's list, for 'percent' a random pick)
CREATE TABLE ota_rollout_devices (
  rollout_id    INTEGER     NOT NULL REFERENCES ota_rollouts(id) ON DELETE CASCADE,
  device_id     UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status        ota_status  NOT NULL DEFAULT 'pending',
  from_version  TEXT,
  error         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, device_id)
);
CREATE INDEX ota_rollout_devices_device_idx ON ota_rollout_devices (device_id, updated_at DESC);
CREATE INDEX ota_rollout_devices_open_idx ON ota_rollout_devices (rollout_id)
  WHERE status IN ('pending', 'sent', 'downloading');

-- ---------------------------------------------------------------------
-- 10. Audit log (staff AND customers; rows can never be changed)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  actor_name   TEXT,                                -- kept even if the user is later deleted
  action       TEXT        NOT NULL,                -- 'device.register', 'share.invite', 'team.role.update'
  target_type  TEXT,                                -- 'device', 'user', 'firmware', 'role', 'rollout'
  target_id    TEXT,
  target_label TEXT,                                -- 'ARG-24A0032', 'Manufacturing'
  detail       TEXT,                                -- 'Turned on firmware.view'
  data         JSONB,
  ip           INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

CREATE FUNCTION audit_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- allow only the FK cleanup when a user row is hard-deleted
  IF TG_OP = 'UPDATE' AND NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
     AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log rows cannot be changed or deleted';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

-- ---------------------------------------------------------------------
-- 11. Dashboard numbers
-- ---------------------------------------------------------------------
-- Written once an hour by the scheduler (the "Devices online, last 24 h" chart)
CREATE TABLE fleet_stats_hourly (
  hour             TIMESTAMPTZ PRIMARY KEY,         -- start of the hour, UTC
  devices_total    INTEGER NOT NULL,
  devices_online   INTEGER NOT NULL,
  devices_claimed  INTEGER NOT NULL,
  customers_total  INTEGER NOT NULL
);

CREATE VIEW admin_stats AS
  SELECT
    (SELECT count(*) FROM devices)                                     AS total_devices,
    (SELECT count(*) FROM devices WHERE owner_id IS NOT NULL)          AS claimed_devices,
    (SELECT count(*) FROM device_state WHERE is_online)                AS online_devices,
    (SELECT count(*) FROM devices WHERE created_at > now() - interval '7 days') AS devices_new_7d,
    (SELECT count(*) FROM users WHERE staff_role_id IS NULL AND deleted_at IS NULL) AS customers,
    (SELECT count(*) FROM users WHERE staff_role_id IS NULL AND deleted_at IS NULL
                                AND created_at > now() - interval '7 days')        AS customers_new_7d,
    (SELECT count(*) FROM ota_rollouts WHERE status = 'running')       AS rollouts_running;

-- ---------------------------------------------------------------------
-- 12. Permission views: the ONE place the backend asks "may X do Y?"
-- ---------------------------------------------------------------------
-- Device permissions: owner gets every 'device' permission; family gets
-- what is switched on for them.
--   SELECT 1 FROM device_user_permissions
--    WHERE device_id = $1 AND user_id = $2 AND permission = 'history.view'
CREATE VIEW device_user_permissions AS
  SELECT d.id AS device_id, d.owner_id AS user_id, p.code AS permission, 'owner'::TEXT AS via
    FROM devices d CROSS JOIN permissions p
   WHERE d.owner_id IS NOT NULL AND p.scope = 'device'
  UNION ALL
  SELECT sp.device_id, sp.user_id, sp.permission, 'share'::TEXT
    FROM device_share_permissions sp;

-- Staff permissions: the Owner role has every 'staff' permission
CREATE VIEW staff_user_permissions AS
  SELECT u.id AS user_id, p.code AS permission
    FROM users u
    JOIN staff_roles r ON r.id = u.staff_role_id
    JOIN permissions p ON p.scope = 'staff'
   WHERE u.deleted_at IS NULL AND NOT u.is_disabled
     AND (r.is_owner OR EXISTS (SELECT 1 FROM staff_role_permissions rp
                                 WHERE rp.role_id = r.id AND rp.permission = p.code));

-- ---------------------------------------------------------------------
-- 13. Starting data (from the mockup)
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, scope, label, sort_order) VALUES
  ('live.view',        'device', 'See live values',            1),
  ('history.view',     'device', 'See sleep history',          2),
  ('alerts.receive',   'device', 'Get alerts',                 3),
  ('settings.edit',    'device', 'Change device settings',     4),
  ('sharing.manage',   'device', 'Invite and manage people',   5),
  ('devices.view',     'staff',  'View devices',               1),
  ('devices.command',  'staff',  'Send device commands',       2),
  ('devices.register', 'staff',  'Register devices by USB',    3),
  ('customers.view',   'staff',  'View customers',             4),
  ('customers.edit',   'staff',  'Edit or disable customers',  5),
  ('firmware.view',    'staff',  'View firmware',              6),
  ('firmware.upload',  'staff',  'Upload firmware',            7),
  ('firmware.rollout', 'staff',  'Start OTA rollouts',         8),
  ('team.manage',      'staff',  'Manage team and roles',      9),
  ('audit.view',       'staff',  'View audit log',            10);

INSERT INTO staff_roles (name, is_owner) VALUES
  ('Owner', true), ('Developer', false), ('Manufacturing', false), ('Support', false);

INSERT INTO staff_role_permissions (role_id, permission)
  SELECT r.id, p.code FROM staff_roles r JOIN permissions p ON p.scope = 'staff'
   WHERE r.name = 'Developer' AND p.code <> 'team.manage'
  UNION ALL
  SELECT r.id, p FROM staff_roles r,
         unnest(ARRAY['devices.view','devices.register','firmware.view']) p
   WHERE r.name = 'Manufacturing'
  UNION ALL
  SELECT r.id, p FROM staff_roles r,
         unnest(ARRAY['devices.view','devices.command','customers.view','audit.view']) p
   WHERE r.name = 'Support';

COMMIT;
