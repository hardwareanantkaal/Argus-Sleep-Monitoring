# Argus database design (v1.1)

**Status:**
- **v1.0** was approved by Devam on 3 Nov 2026, with decisions D1–D7 as recommended.
- **v1.1** (same day) changes sleep data to one row **per session**, uses 3 sleep stages (the C1001 has no REM), and adds the user's country and the device's town/city. This follows owner decisions from the main thread and [DEVICE-DATA.md](DEVICE-DATA.md).
- v1.1 also applies the owner's final answers on conflicts C1–C4 ([§11](#11-conflicts-to-settle)): **MAC-only device login** and **no SMS for now**.
- **v1.1 was approved by Devam on 3 Nov 2026.**
**SQL:** [`database/schema.sql`](../database/schema.sql). It was tested on a throwaway PostgreSQL 16, along with the checks listed in [§9](#9-how-the-schema-was-checked).
**Based on:** the UI mockup (`mockup/index.html`, 3 Nov 2026), the device data draft ([DEVICE-DATA.md](DEVICE-DATA.md)) and the Water Tank schema ([REFERENCE_NOTES.md §7](REFERENCE_NOTES.md#7-database)).

---

## 1. The big idea in five lines

1. **A device** is one ESP32-S3 with one DFRobot C1001 60 GHz radar. The factory registers it over USB, and a customer claims it by scanning its QR sticker.
2. **Live values are not saved.** Heart rate, breathing, movement, presence and sleep stage arrive every 5 s while someone is in bed (60 s when the bed is empty). The backend keeps them in memory and pushes them to the browser. The mockup promises this: *"Live values … are not saved."*
3. **The saved health record is one summary per sleep session** (bed in → bed out), in `sleep_sessions`. A night can contain several sessions. The backend groups them into nights and naps when it reads them; nights are never stored.
4. **One permission system** for everyone:
   - The Argus team gets permissions **per role** (Owner, Developer, Manufacturing, Support, or a custom role).
   - Family members get permissions **per person, per sensor**.
5. **Everything else is copied from Water Tank:** login and tokens, the MQTT settings sync, commands, OTA and the audit log. Those parts already work in production.

## 2. Table map

```mermaid
erDiagram
  users ||--o{ devices : "owns"
  users }o--o| staff_roles : "staff role (optional)"
  staff_roles ||--o{ staff_role_permissions : ""
  permissions ||--o{ staff_role_permissions : ""
  permissions ||--o{ device_share_permissions : ""
  devices ||--o{ device_shares : "shared with"
  users ||--o{ device_shares : ""
  device_shares ||--o{ device_share_permissions : "switches on"
  devices ||--o{ device_invites : ""
  devices ||--|| device_settings : ""
  devices ||--|| device_state : ""
  devices ||--o{ sleep_sessions : "one per bed-in to bed-out"
  devices ||--o{ alert_rules : "one per type"
  devices ||--o{ alerts : ""
  alerts ||--o{ alert_deliveries : "push / sms per person"
  devices ||--o{ device_commands : ""
  devices ||--o{ device_events : ""
  devices ||--o{ device_log_uploads : ""
  firmware_releases ||--o{ ota_rollouts : ""
  ota_rollouts ||--o{ ota_rollout_devices : ""
  devices ||--o{ ota_rollout_devices : ""
```

There are 30 tables and 3 views, grouped below. The SQL has the full column list, with a comment on each column.

## 3. People and permissions

| Table | What it holds | Why |
|---|---|---|
| `users` | Everyone: customers, family and staff. Login is **phone + password**. Also stores **country** (ISO code such as `IN` or `US`), asked at sign-up. | One account per phone number. A staff member who also owns a sensor needs only one login. |
| `staff_roles` | Owner, Developer, Manufacturing, Support, plus any role added on the Team screen | The mockup lets the Owner add roles and switch their permissions. |
| `staff_role_permissions` | Which staff permissions each role has | The Team → Roles table in the mockup. |
| `permissions` | The 16 permission codes (11 staff, 5 device), e.g. `history.view`, `firmware.rollout` | One list. Each code is either `staff` or `device`, and the database refuses to mix them up. |
| `device_shares` + `device_share_permissions` | Which family member can do what on which sensor | The Share access screen (one switch per person). |
| `device_invites`, `staff_invites` | Pending invite **links** (migration 002: no phone; a `label` like "Rohan (son)" instead) | Link-only (owner, 3 Nov): whoever opens the link and is logged in accepts it, once. Works before the person has an account. |
| `refresh_tokens`, `otp_codes`, `push_tokens`, `user_notification_prefs`, `user_device_alert_mutes` | Sessions, SMS codes (unused in v1), push targets (unused in v1), in-app quiet hours, and per-person muted sensors ("Show me alerts from") | Alerts are in-app only in v1 (002 dropped the push/SMS switches). A mute affects only that one person. |

**How a permission is checked.** The backend asks one view, so the rules live in one place:

```sql
-- "May this user see sleep history for this sensor?"
SELECT 1 FROM device_user_permissions
 WHERE device_id = $1 AND user_id = $2 AND permission = 'history.view';
-- "May this staff member start an OTA rollout?"
SELECT 1 FROM staff_user_permissions WHERE user_id = $1 AND permission = 'firmware.rollout';
```

- The **device owner** automatically has all 5 device permissions.
- The **Owner role** automatically has all 11 staff permissions. It can't be edited and there is only one.

**Who is staff?** A user is staff when `users.staff_role_id` is set. That replaces Water Tank's fixed `super_admin | user` field.

## 4. Devices

| Table | What it holds | Notes |
|---|---|---|
| `devices` | Serial (`ARG-24A0012`), MAC (also the MQTT login, with no password), chip, hardware model, batch, date made, owner, name, room, disabled flag. Also the settings **only the backend uses**: **time zone** (where the sleeper is, e.g. `America/New_York`), optional **town/city** (`place`, 2–60 characters; NULL = the UI makes a label from the time zone, for labels like "Surat time"), the **sleep-date cut-off** (default noon) and **auto-update**. | One board per device, so Water Tank's `device_boards` table is dropped. The MQTT username is the MAC, as in Water Tank. |
| `device_settings` | Bed-exit timeout (5 min), live send rates (5 s in bed, 60 s idle), struggle and unattended detection | **Sent to the sensor** ([DEVICE-DATA.md §5](DEVICE-DATA.md)). Same versioned sync as Water Tank: change a setting → `version` goes up → the device acks → `applied_version`. |
| `settings_changes` | History of every settings change: who, old value, new value, when the device confirmed | Filled automatically by a trigger copied from Water Tank. |
| `device_state` | Online/offline, firmware, IP, Wi-Fi name and signal, uptime, last seen | **Connection health only. No health values.** This is what the device tables and the "Firmware in the field" chart read. |

**Why two places for settings:** any change to `device_settings` is sent to the sensor. Name, room, time zone, place, cut-off and auto-update don't concern the sensor (it sends UTC times), so they live in `devices`. Changing them doesn't wake the sensor.

## 5. Sleep data (the important part)

### What is stored: `sleep_sessions`
One row per **session**, from the moment the person gets into bed until they leave it. A session ends only after the 5-minute bed-exit timeout, so a trip to the bathroom doesn't end it. The sensor sends each session once it ends ([DEVICE-DATA.md §4](DEVICE-DATA.md)). A row holds:

- **Times:** bed in, bed out, and the length (worked out by the database).
- **From the C1001:** score, sleep minutes, awake minutes, light %, deep %, minutes out of bed, bed exits, turn-overs, large and small movement %, apnea events.
- **Body:** average heart rate and breathing rate from the C1001, plus lowest and highest, which the firmware tracks itself.
- **`hyp`:** the hypnogram as letters, one per 5 minutes: `D` deep, `L` light, `A` awake, `O` out of bed. An 8-hour night is 96 letters. **There is no REM**: the C1001 doesn't report it, so the app shows 3 stages.
- **`timezone`:** the device's time zone when the session arrived. If the owner later changes the time zone, old nights stay on the dates they were recorded on.
- **`raw`:** the exact message the sensor sent. The C1001 units still marked ⚠ in DEVICE-DATA.md can be fixed later without losing data.

**Re-sent sessions are ignored.** The sensor keeps a session in flash until the server acks it, so after a Wi-Fi drop it may send the same one again. The database keeps one row per device and start time, and the duplicate is dropped. Start time is used rather than the session counter, because the counter resets if the flash is wiped.

### How sessions become nights (worked out on read)
The backend does this with luxon, in each session's own time zone, so daylight-saving changes are handled:

1. **Hide short sessions.** Anything under **25 min** is kept but not shown (`app_settings.min_session_min`). These two settings and the default cut-off for new devices are edited on the admin "Sleep rules" screen (permission `platform.settings`).
2. **Merge.** Sessions **less than 30 min apart** form one group (`app_settings.merge_gap_min`, an admin setting).
3. **Date it.** A group belongs to the sleep date **before the cut-off** (default 12:00 noon, set per device in `devices.sleep_cutoff`). So 23:00 on 2 Nov → 07:00 on 3 Nov counts as "night of 2 Nov".
4. **Main sleep or nap.** The longest group on a date is the **main sleep**; the others are **naps** (shown, but trends use main sleep only).
5. **Night totals** are sums over the sessions. Heart and breathing averages are weighted by length; min and max are taken across the sessions.

**Why not store nights?** They depend on two admin settings and the cut-off. If any of those changes, stored nights would be wrong. Working them out on read takes milliseconds (a few rows per night) and is always correct.

**Size:** under 1 KB per session. 1,000 sensors × 1–2 sessions a night for a year is about 0.5 GB, which is small for PostgreSQL.

**Removing a device deletes its sleep history.** The mockup says so on the Remove device card. This also means that if the sensor is resold and claimed by someone else, the new owner can't see the old owner's nights.

## 6. Alerts

| Table | What it holds |
|---|---|
| `alert_rules` | Per sensor, per type: on/off plus the numbers. The five mockup rules: breathing low (< 8 /min for 30 s), heart rate out of range (< 45 or > 110 bpm), out of bed at night (> 10 min between 23:00 and 06:00), no movement (3 h), sensor offline (15 min). The backend creates the default rows when the sensor is claimed. |
| `alerts` | One row each time a rule fires: what, the value, when it started and when it cleared. This is the "Recent" alerts list. |
| `alert_deliveries` | Who was told, by push or SMS, whether it worked, and when they read it. |

- **Rules belong to the sensor.** Everyone on that sensor shares the same rules, and editing them needs `settings.edit`, as the mockup shows.
- **What you see belongs to you:** quiet hours (`user_notification_prefs`) and which sensors you've muted (`user_device_alert_mutes`). Alerts are in-app only in v1.
- **No repeat spam.** The database allows only **one open alert per sensor per type**, so a breathing alert that stays low for an hour stays one alert.

## 7. Factory, commands, firmware, audit

| Table | What it holds |
|---|---|
| `device_commands` | `reboot`, `config_mode`, `ota_check`, `logs`: who sent it, its status, and the ack. Same flow as Water Tank. |
| `device_log_uploads` | The result of the `logs` command (the last 200 log lines). Capped at 64 KB. |
| `device_events` | Online/offline, reboot, bed in/out, struggle, unattended, radar fault, session received, OTA results, claimed/unclaimed. |
| `firmware_releases` | Version, **channel (beta or stable)**, size, sha256, notes. |
| `ota_rollouts` + `ota_rollout_devices` | A rollout targets **all devices, a percentage, chosen serials, or devices on a given version**, with an install window (e.g. 10:00–18:00, so never during sleep). It can be paused. The chosen devices are fixed when the rollout starts. |
| `audit_log` | Every change by **staff and customers**. The database **refuses edits and deletes**; the mockup says "Entries cannot be edited." The person's name is copied into the row, so the log still reads correctly after an account is deleted. |
| `fleet_stats_hourly` | One row per hour for the dashboard chart "Devices online, last 24 h". |

## 8. What changed from Water Tank

| Kept as is | Changed | Dropped | New |
|---|---|---|---|
| UUID keys, UTC times, `set_updated_at`, hashed secrets, refresh tokens, OTP codes, push tokens, settings sync trigger, commands, events, OTA tables, audit log, `admin_stats` view | `users`: phone + password required, Google login removed, `staff_role_id` replaces `role`. `devices`: one board (MAC column on the device), adds batch / chip / room / time zone / place / cut-off. `firmware_releases`: `channel` replaces `is_stable`. `ota_rollouts`: targets, install window, pause. `audit_log`: cannot be edited | `device_boards`, `pump_runs`, `timers`, pump enums, the tank columns in settings and state, the old `notifications` and `alert_settings` | `permissions`, `staff_roles`, `staff_role_permissions`, `device_share_permissions`, `staff_invites`, `user_device_alert_mutes`, `sleep_sessions`, `app_settings`, `alert_rules`, `alerts`, `alert_deliveries`, `user_notification_prefs`, `device_log_uploads`, `fleet_stats_hourly` |

**Clean-up job** (runs every 6 h, as in Water Tank):

| Data | Deleted after |
|---|---|
| Commands, alert deliveries | 1 year |
| Events, alerts | 2 years |
| Uploaded logs | 30 days |
| Hourly fleet stats | 90 days |
| Expired OTP codes, refresh tokens and invites | When they expire |
| Sleep sessions | Kept until the device is removed or the account is deleted (see D5) |

## 9. How the schema was checked

`schema.sql` ran without errors on a throwaway `postgres:16-alpine` container. A test script then confirmed:

- **Permissions:** the Owner role gets 11 staff permissions and Manufacturing gets 3. The device owner gets 5 device permissions, and the family member gets only the 2 that were switched on. Putting a staff permission on a family member is refused.
- **Settings sync:** changing the bed-exit timeout from 300 to 600 s raises the version to 2 and logs the change. The device ack marks it applied. Changing the time zone does **not** bump the version.
- **Sleep sessions:** two sessions on one night are both kept. Re-sending a session is ignored. A hypnogram letter other than D/L/A/O is refused.
- **Users and devices:** a bad country code and a one-letter place are refused.
- **Alerts:** a second open alert of the same type is refused.
- **Audit log:** editing or deleting a row is refused. Deleting a user keeps their audit rows, with their name.
- **Other checks:** a bad serial is refused, and a percentage rollout without a percentage is refused.

## 10. Decisions (approved 3 Nov 2026)

| # | Question | Decision | Why it matters |
|---|---|---|---|
| **D1** | How does a sensor log in to MQTT? | ~~A per-device secret~~ **Replaced by C1: MAC only.** `devices.secret_hash` is kept, unused, for later. | Water Tank logs in with the MAC only. A MAC is not secret, so anyone who knows it could pretend to be that sensor and send fake vitals. For health data that matters more. |
| **D2** | Claim code and QR | Keep the mockup's **serial + code**, but make the code **12 characters** (`XXXX-XXXX-XXXX`) instead of 9. | 9 characters can be guessed with enough tries. 12 is far safer, together with the rate limit. |
| **D3** | Verify the phone number by SMS code at sign-up? | ~~Yes~~ **Replaced by C3: no SMS in v1.** The OTP code path stays, switched off. | Invites are matched by phone number. Without verification, someone could sign up with your mother's number and receive invites meant for her. It needs an SMS provider (msg91 is already wired up in the Water Tank code). |
| **D4** | Commands to an offline sensor | **Queue them for 24 h** (mockup behaviour), except `config_mode`, which should fail after 30 s. | Water Tank refuses with "device offline". The mockup says commands wait in a queue. Opening Wi-Fi setup hours later would surprise the customer. |
| **D5** | How long to keep sleep history? | **Until the device is removed or the account is deleted**, plus a "download my data" export later. | Health data: keep only what the customer expects. |
| **D6** | Who computes the sleep stages and score: the C1001/ESP32, or our backend? | **The device sends them**, per session. We store them, plus the raw payload. | Confirmed by DEVICE-DATA.md: the C1001 gives score, light/deep %, turn-overs and apnea. The firmware adds min/max and the hypnogram. |
| **D7** | Who checks the alert rules? | **The backend**, using the live data stream (same pipeline as Water Tank's `live.js`). | This means the sensor must send live values every second, even when no one has the app open. A device-side check would save bandwidth but needs firmware work. |
| **D8** | Serial format | **OPEN.** `ARG-` + 7 characters, e.g. `ARG-24A0012`. What do `24A` and `0012` mean? (year, batch, running number?) | The database checks the format, and the factory screen generates the serials. |

---

### What the decisions change

| Decision | Effect |
|---|---|
| **D1 → C1** | Nothing to do: login stays MAC-only, as in Water Tank. Registration writes nothing to the board, so the mockup text is right. |
| **D2** | The claim code is 12 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, shown as `XXXX-XXXX-XXXX`. The database stores only its HMAC, so the schema doesn't change. The mockup sample `7KQ-4MZ-2PX` and the "9 letters" hint need updating. |
| **D3 → C3** | No SMS step. **Because phone numbers aren't verified, an invite is accepted only through the link in it** (the token in `device_invites` / `staff_invites`), never just because the phone number matches. Without this, anyone who signs up with someone else's number would get their invites. |
| **D4** | The backend sets `device_commands.expires_at` to 24 h for `reboot`, `ota_check` and `logs`, and to 30 s for `config_mode`. |
| **D5–D7** | No schema change. These are rules for the backend and firmware, recorded here. |

## 11. Conflicts (all settled by the owner, 3 Nov 2026)

| # | First approved here | Other view | Final owner decision | Effect |
|---|---|---|---|---|
| **C1** | D1: per-device MQTT secret | MAC-only login | **MAC only, no password**, as in Water Tank. The owner accepts that a MAC isn't secret. | `secret_hash` is optional and unused (reserve). |
| **C2** | Alert tables and the Alerts screen (from the mockup) | CLAUDE.md: alerts, push and SMS not needed for now | **Alerts kept in v1.** | The alert tables stay. |
| **C3** | D3: SMS code at sign-up | SMS not needed for now | **No SMS in v1.** Phone + password only; the OTP path stays, switched off. | Invites are accepted only through their link (token). |
| **C4** | D7: backend checks alerts from live data about every second | DEVICE-DATA.md: live data every 5 s in bed, 60 s idle | **5 s / 60 s** | `device_settings.live_s` / `idle_s` defaults. A 30 s alert rule sees about 6 readings. |

**Next steps:**
1. ✅ The owner approved v1.1. C1–C4 are settled.
2. ✅ `database/migrations/001_initial_schema.sql` matches `schema.sql`. From the first time it's applied to any database, it must never be edited; changes go in `002_…`.
3. Write `docs/API.md` and send it for approval. Implementation (build step 5) starts after that.
