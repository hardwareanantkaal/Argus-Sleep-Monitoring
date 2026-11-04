-- Migration 004: firmware 2.0.0 extras (API.md §11a, 4 Nov 2026).
-- * New device command `recalibrate` (radar reset, about 11 s).
-- * Live state every 2 s while someone is present (live_s default 5 -> 2).
--   Sensors still on the old default move to 2; the settings trigger bumps
--   their version, so they receive it on the next sync.
BEGIN;

ALTER TYPE command_type ADD VALUE IF NOT EXISTS 'recalibrate';

ALTER TABLE device_settings ALTER COLUMN live_s SET DEFAULT 2;
UPDATE device_settings SET live_s = 2 WHERE live_s = 5;

COMMIT;
