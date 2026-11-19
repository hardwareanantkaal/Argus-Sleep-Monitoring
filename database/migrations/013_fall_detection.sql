-- Migration 013: Fall Detection product (19 Nov 2026, owner approved).
-- A second product beside the sleep monitor: ESP32-S3 + TI IWR6843AOP radar
-- (3D People Tracking). Same registration, QR claim, sharing and OTA as the
-- sleep device, but its own MQTT topics (fall/<mac>/...) and its own data.
--
-- Stored: ONLY fall events (FALL and RECOVERED), one row each, in fall_events.
-- Not stored: the "alive" heartbeat (fall/<mac>/alive) and radar frames.
-- docs/DEVICE-DATA.md §8 has the two JSON messages.
BEGIN;

ALTER TABLE devices ADD COLUMN product TEXT NOT NULL DEFAULT 'sleep'
  CONSTRAINT devices_product CHECK (product IN ('sleep', 'fall'));
CREATE INDEX devices_product_idx ON devices (product);

-- Firmware is per product too: an OTA rollout only goes to devices of the
-- release's product (sleep firmware must never reach a fall detector).
ALTER TABLE firmware_releases ADD COLUMN product TEXT NOT NULL DEFAULT 'sleep'
  CONSTRAINT firmware_releases_product CHECK (product IN ('sleep', 'fall'));
DROP INDEX firmware_factory_default_uq;
CREATE UNIQUE INDEX firmware_factory_default_uq ON firmware_releases (chip_model, product) WHERE factory_default;

-- In-app alert for a fall. Opens on FALL, closes on RECOVERED.
-- (Not used in this transaction, so ADD VALUE is safe here.)
ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'fall';

CREATE TABLE fall_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  eid          BIGINT      NOT NULL,             -- the device's event counter (kept in NVS); a resend has the same eid
  kind         TEXT        NOT NULL,             -- 'fall' | 'recovered'
  occurred_at  TIMESTAMPTZ NOT NULL,             -- device ts (NTP), or the receive time if the clock looks wrong
  tid          SMALLINT    NOT NULL,             -- radar track id of the person
  -- FALL only (NULL on 'recovered'):
  ema_now      REAL,                             -- smoothed height now (m)
  ema_peak     REAL,                             -- highest smoothed height in the look-back window (m)
  drop_m       REAL,                             -- ema_peak - ema_now (m)
  drop_pct     REAL,                             -- drop as % of ema_peak
  pos_x        REAL, pos_y REAL, pos_z REAL,     -- target position (m), optional
  vel_x        REAL, vel_y REAL, vel_z REAL,     -- target velocity (m/s), optional
  height_m     REAL,                             -- target height maxZ - minZ (m), optional
  presence     BOOLEAN,                          -- room occupied flag (TLV 1021), optional
  preset       TEXT,                             -- sensitivity preset 'LOW' | 'MED' | 'HIGH'
  -- RECOVERED: which FALL it ends. FALL: filled in when the RECOVERED arrives.
  fall_eid     BIGINT,
  recovered_at TIMESTAMPTZ,
  recovery_s   INTEGER CHECK (recovery_s IS NULL OR recovery_s >= 0),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fall_events_kind CHECK (kind IN ('fall', 'recovered')),
  CONSTRAINT fall_events_preset CHECK (preset IS NULL OR preset IN ('LOW', 'MED', 'HIGH')),
  CONSTRAINT fall_events_eid UNIQUE (device_id, eid)
);
CREATE INDEX fall_events_device_time_idx ON fall_events (device_id, occurred_at DESC);
-- Falls still waiting for a RECOVERED
CREATE INDEX fall_events_open_idx ON fall_events (device_id) WHERE kind = 'fall' AND recovered_at IS NULL;

COMMIT;
