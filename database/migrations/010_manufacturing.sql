-- Migration 010: manufacturing station (flash + bench test + factory log), approved 13 Nov 2026.
-- Never edit this file once it has been applied anywhere; add 011_... instead.
-- database/schema.sql is the readable full picture and must match all migrations combined.
-- Plain-words explanation: docs/DESIGN.md §12.

BEGIN;

-- 1. Two new staff permissions for the factory bench
INSERT INTO permissions (code, scope, label, sort_order) VALUES
  ('factory.flash',   'staff', 'Flash firmware at the factory',  13),
  ('factory.monitor', 'staff', 'Serial monitor and bench tests', 14);

-- Manufacturing and Developer get both (the Owner role gets every staff permission anyway)
INSERT INTO staff_role_permissions (role_id, permission)
  SELECT r.id, p FROM staff_roles r, unnest(ARRAY['factory.flash','factory.monitor']) p
   WHERE r.name IN ('Manufacturing', 'Developer')
  ON CONFLICT DO NOTHING;

-- 2. Factory image: a full-flash image (bootloader + partitions + boot_app0 + app,
--    i.e. Arduino's *.ino.merged.bin), written at address 0x0 on a blank board.
--    The OTA .bin (app only) stays in file_path as before.
ALTER TABLE firmware_releases
  ADD COLUMN factory_file_path  TEXT,             -- /srv/ota/factory/argus_2.4.0_merged.bin
  ADD COLUMN factory_file_size  INTEGER CHECK (factory_file_size > 0),
  ADD COLUMN factory_sha256     TEXT    CHECK (factory_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN factory_flash_size TEXT    CHECK (factory_flash_size IN ('2MB','4MB','8MB','16MB')),
  ADD COLUMN factory_default    BOOLEAN NOT NULL DEFAULT false,  -- pre-selected on the station
  ADD CONSTRAINT firmware_factory_complete CHECK (
        (factory_file_path IS NULL AND factory_file_size IS NULL AND factory_sha256 IS NULL)
     OR (factory_file_path IS NOT NULL AND factory_file_size IS NOT NULL AND factory_sha256 IS NOT NULL)),
  ADD CONSTRAINT firmware_factory_default_needs_image CHECK (
        NOT factory_default OR factory_file_path IS NOT NULL);
-- At most one default per chip model
CREATE UNIQUE INDEX firmware_factory_default_uq ON firmware_releases (chip_model) WHERE factory_default;

-- 3. One row per board on the bench: flash, tests, result.
--    Written by the browser station (Web Serial); nothing here comes from MQTT.
CREATE TYPE factory_result AS ENUM ('running', 'pass', 'fail', 'aborted');

CREATE TABLE factory_runs (
  id             BIGSERIAL PRIMARY KEY,
  mac            MACADDR        NOT NULL,          -- read by esptool-js over USB
  chip           TEXT           NOT NULL,          -- 'ESP32', 'ESP32-S3' ... as esptool reports it
  release_id     INTEGER        REFERENCES firmware_releases(id) ON DELETE SET NULL,
  fw_version     TEXT,                             -- copied, survives a deleted release; NULL = test only, not flashed
  flashed        BOOLEAN        NOT NULL DEFAULT false,
  flash_ms       INTEGER        CHECK (flash_ms >= 0),
  checks         JSONB          NOT NULL DEFAULT '[]',  -- [{"id":"boot","ok":true,"value":"v2.4.0","ms":2300}, ...]
  result         factory_result NOT NULL DEFAULT 'running',
  fail_reason    TEXT,                             -- first failed check, for the log filter
  log_tail       TEXT           CHECK (octet_length(log_tail) <= 16384),  -- last 16 KB of serial output
  notes          TEXT,
  station        TEXT,                             -- bench label typed once per PC, e.g. 'Bench 2'
  device_id      UUID           REFERENCES devices(id) ON DELETE SET NULL,  -- set when registered
  operator_id    UUID           REFERENCES users(id) ON DELETE SET NULL,
  operator_name  TEXT           NOT NULL,          -- copied, like audit_log
  started_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT factory_runs_finished CHECK ((result = 'running') = (finished_at IS NULL)),
  CONSTRAINT factory_runs_flashed_version CHECK (NOT flashed OR fw_version IS NOT NULL),
  CONSTRAINT factory_runs_checks_array CHECK (jsonb_typeof(checks) = 'array')
);
CREATE INDEX factory_runs_mac_idx      ON factory_runs (mac, started_at DESC);
CREATE INDEX factory_runs_started_idx  ON factory_runs (started_at DESC);
CREATE INDEX factory_runs_result_idx   ON factory_runs (result, started_at DESC);
CREATE INDEX factory_runs_operator_idx ON factory_runs (operator_id, started_at DESC);

COMMIT;
