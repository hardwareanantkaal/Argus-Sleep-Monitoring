-- Schema smoke test. Run AFTER the migrations on an EMPTY throwaway database:
--   cat database/migrations/*.sql database/tests/schema_test.sql | psql -U postgres -X -q
-- Lines marked "EXPECT ERROR" must print an ERROR; everything else must not.
\set ON_ERROR_STOP 0

\echo == staff permissions per role (expect Devam 10, Kiran 3)
INSERT INTO users (full_name, phone, country, password_hash, staff_role_id) VALUES
 ('Devam','+919898011223','IN','x',(SELECT id FROM staff_roles WHERE name='Owner')),
 ('Kiran','+919723044871','IN','x',(SELECT id FROM staff_roles WHERE name='Manufacturing')),
 ('Priya','+919825012345','IN','x',NULL),
 ('Rohan','+919909055210','IN','x',NULL);
SELECT u.full_name, count(*) FROM staff_user_permissions s JOIN users u ON u.id = s.user_id GROUP BY 1 ORDER BY 1;

\echo == device permissions (expect Priya owner 5, Rohan share 2)
INSERT INTO devices (serial_no, mac, mqtt_username, secret_hash, chip_model, hw_model, owner_id, claimed_at, place)
 VALUES ('ARG-24A0012','34:85:18:a1:0f:22','348518a10f22','h','ESP32-S3','ARG-S1 rev B',
         (SELECT id FROM users WHERE full_name='Priya'), now(), 'Surat');
INSERT INTO device_settings (device_id) SELECT id FROM devices;
INSERT INTO device_shares (device_id, user_id) SELECT d.id, u.id FROM devices d, users u WHERE u.full_name='Rohan';
INSERT INTO device_share_permissions
 SELECT d.id, u.id, p FROM devices d, users u, unnest(ARRAY['live.view','history.view']) p WHERE u.full_name='Rohan';
SELECT u.full_name, via, count(*) FROM device_user_permissions x JOIN users u ON u.id = x.user_id GROUP BY 1,2 ORDER BY 1;
\echo == EXPECT ERROR: staff permission on a family share
INSERT INTO device_share_permissions SELECT d.id, u.id, 'team.manage' FROM devices d, users u WHERE u.full_name='Rohan';

\echo == settings sync (expect version 2, diff exit_s 300->600, then applied; timezone change keeps version 2)
UPDATE device_settings SET exit_s = 600;
SELECT version, applied_version FROM device_settings;
SELECT version, old_values, new_values FROM settings_changes;
UPDATE device_settings SET applied_version = 2, applied_at = now();
SELECT version, applied_at IS NOT NULL AS applied FROM settings_changes;
UPDATE devices SET timezone = 'America/New_York';
SELECT version AS still_2 FROM device_settings;

\echo == sessions (expect 2 rows: two sessions in one night kept, the re-send ignored)
INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, hyp, raw)
 SELECT id, 1, '2026-11-02 17:30Z', '2026-11-02 21:00Z', 'Asia/Kolkata', 'AALLDD', '{}' FROM devices;
INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, hyp, raw)
 SELECT id, 2, '2026-11-02 21:20Z', '2026-11-03 01:00Z', 'Asia/Kolkata', 'LLDDAO', '{}' FROM devices;
INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, hyp, raw)
 SELECT id, 2, '2026-11-02 21:20Z', '2026-11-03 01:00Z', 'Asia/Kolkata', 'LLDDAO', '{}' FROM devices
 ON CONFLICT (device_id, started_at) DO NOTHING;
SELECT sid, duration_min, hyp FROM sleep_sessions ORDER BY started_at;
\echo == EXPECT ERROR: R (REM) is not a hypnogram letter
INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, hyp, raw)
 SELECT id, 3, '2026-11-03 17:30Z', '2026-11-03 21:00Z', 'Asia/Kolkata', 'LLRR', '{}' FROM devices;
\echo == EXPECT ERROR: session ends before it starts
INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, raw)
 SELECT id, 4, '2026-11-03 21:00Z', '2026-11-03 20:00Z', 'Asia/Kolkata', '{}' FROM devices;
SELECT merge_gap_min, min_session_min FROM app_settings;

\echo == EXPECT ERROR x2: bad country, one-letter place
UPDATE users SET country = 'India' WHERE full_name = 'Priya';
UPDATE devices SET place = 'X';

\echo == EXPECT ERROR: second open alert of the same type
INSERT INTO alerts (device_id, type, severity, title) SELECT id, 'breath_low', 'critical', 'a' FROM devices;
INSERT INTO alerts (device_id, type, severity, title) SELECT id, 'breath_low', 'critical', 'b' FROM devices;

\echo == audit log: EXPECT ERROR x2 (update, delete); then deleting the user keeps the row with its name
INSERT INTO audit_log (actor_id, actor_name, action) SELECT id, 'Kiran', 'device.register' FROM users WHERE full_name='Kiran';
UPDATE audit_log SET action = 'x';
DELETE FROM audit_log;
DELETE FROM users WHERE full_name = 'Kiran';
SELECT actor_id IS NULL AS nulled, actor_name, action FROM audit_log;

\echo == EXPECT ERROR x2: bad serial, percent rollout without percent (a device WITHOUT a secret is fine: MAC-only login)
INSERT INTO devices (serial_no, mac, mqtt_username, secret_hash, chip_model, hw_model)
 VALUES ('WT-1','34:85:18:a1:0f:23','348518a10f23','h','x','y');
INSERT INTO devices (serial_no, mac, mqtt_username, chip_model, hw_model)
 VALUES ('ARG-24A0099','34:85:18:a1:0f:99','348518a10f99','x','y');
INSERT INTO firmware_releases (version, file_path, file_size, sha256) VALUES ('1.4.2','/x',1,repeat('a',64));
INSERT INTO ota_rollouts (release_id, target) VALUES (1, 'percent');

SELECT * FROM admin_stats;
