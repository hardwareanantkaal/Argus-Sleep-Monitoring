-- Migration 011: device command `end_session` (13 Nov 2026).
-- Firmware 2.5.1 closes the running sleep session on this command and sends
-- it at once (like the original SleepLamp "End session" button). Needed when
-- something keeps the radar's presence on after the person got up.
ALTER TYPE command_type ADD VALUE IF NOT EXISTS 'end_session';
