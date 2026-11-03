# Argus — Screens and the data each one needs

Approved design: `mockup/index.html` (v2, 2026-11-03). Private preview: https://claude.ai/artifact/D7Zqt4MmDQyV4sMX1RpkAA

This list feeds the API contract (build step 4). For each screen: **Reads** = data the screen loads, **Writes** = actions it sends, **Live** = Socket.IO events (not stored).

Field names follow `docs/DEVICE-DATA.md`. Fields marked *(PH)* are still placeholders until the ⚠ items there are checked on real hardware.

## Shared rules

- **One app.** The menu is built from the logged-in user's **kind** (`admin` | `customer`) and **permissions**.
- **One permission system** for both sides:
  - Admin team: a **role** holds a list of permissions.
  - Customer family: each **share** (person × device) holds a list of permissions.
- **Admin permissions:**
  - `devices.view`, `devices.command`, `devices.register`
  - `customers.view`, `customers.edit`
  - `firmware.view`, `firmware.upload`, `firmware.rollout`
  - `team.manage`, `audit.view`, `platform.settings`
- **Family permissions:** `live.view`, `history.view`, `alerts.receive`, `settings.edit`, `sharing.manage`. The device owner has all of them.
- **Phone numbers:** stored in E.164 format (`+919825012345`). Each user also has a **country**, pre-filled from the phone code.
- **Invites (family and staff):** phone numbers are unverified (no SMS OTP), so an invite is accepted **only by opening its link**, which carries a one-time token (7 days). It is never matched to a phone number at sign-up or login. The inviter copies the link and sends it themselves.
- **No SMS anywhere in v1** (owner 3 Nov). Alerts are in-app only (Alerts screen + bell count); push or SMS may come later. Password reset = an admin-created one-time link, sent by support by hand.
- **Web login:** uses an httpOnly cookie session, so the app never handles a token. (Devices log in by MAC only. That doesn't affect any screen.)
- **Audit log:** every write by staff or customers creates an entry.

### Time zones

- **Every device has an IANA time zone** and an optional **place name** ("Town or city", owner 3 Nov):
  - Both are picked when the device is claimed, with the time zone pre-filled from the browser.
  - Both can be changed in device settings.
- **Sleep times are shown in the device's time zone.** When the viewer's own time zone is different, the screen adds a label such as **"Surat time"**. If the place name is empty, the label comes from the time zone instead (e.g. `Asia/Kolkata` → "India time").
- **The API returns:**
  - times in UTC
  - the device's `tz` and `place`
  - the viewer's `tz`, from the browser, for comparison

### Nights, sessions and naps

- **A session:** the device sends one per bed-in → bed-out. Its hypnogram has one character per 5 min: `D` deep, `L` light, `A` awake, `O` out of bed. There is **no REM**.
- **Grouping:** the server groups sessions into nights.
  - **Joining:** sessions less than **30 min** apart are joined. This is an admin setting.
  - **Sleep date:** cut off at **noon in the device time zone**. Each device can change this time.
  - **Main sleep and naps:** the longest group on a date is the **main sleep**. Every other group is a **nap**.
  - **Short sessions:** sessions under **25 min** are hidden (stored, flagged).
- **On screen:**
  - History shows one card per night.
  - Night detail shows the joined timeline, with out-of-bed gaps shaded.
  - Trends use the main sleep only.

## Auth

| Screen | Reads | Writes |
|---|---|---|
| **Login** | — | login (phone E.164, password) → sets cookie, returns user `{id, name, phone, country, kind, role?, permissions[]}`. If opened from an invite link, returns to **Accept invite** after login. "Forgot password?" shows Anantkaal support contact details (static, from config); support then creates a reset link (see Customer detail). |
| **Sign-up** (3 steps) | — | create account (name, phone, password, country). The phone is **not verified** (no SMS OTP). Step 2 = claim device (same as Add device) or skip; step 3 = placement tips (static). If opened from an invite link, returns to **Accept invite** after step 1. |
| **Accept invite** (opened from the link `/invite/<token>`, logged in or out) | invite by token: `{kind: family / staff, inviterName, deviceName + place + permissions[] / roleName, expiresAt, status}` | accept(token), needs a logged-in session; logged out → log in or sign up first, then back here. **Never** matched to a phone number. One use, expires after 7 days. |

## Customer side

| Screen | Reads | Writes | Live |
|---|---|---|---|
| **My devices** | devices I own or that are shared with me: `serial, name, room, tz, place, online, lastSeen, sharedBy?, myPermissions[]`; latest HR, breath, in-bed for the card; last night `{score, totalSleepMin}` | — | `device:status`, `device:live` |
| **Live view** | device `{serial, name, room, tz, place, online, lastSeen, fw}` | — | `device:live` every 5 s in bed / 60 s empty: `pr, bed, ss` (deep/light/awake), `hr, br, bs` (breath state), `mv, mr` (movement range 0–100), `dist, rssi`. Not saved. |
| **Sleep history** | my devices; per device the last N **nights** (main sleep): `sleepDate, start, end, totalSleepMin, stageMin{deep, light, awake, outOfBed}, score, sessionCount, naps[{start, end}]`; averages over main sleeps (sleep, score, HR, wake-ups) | — | — |
| **Night detail** | one night: `score, sleepMin, inBedMin, oobMin, efficiency, wakeUps, exits`; `sessions[{start, end}]` plus the gaps between them; **joined hypnogram** (`D/L/A/O`, gaps filled with `O`); `hr avg/min/max`, `br avg/min/max`, `turns`, `bigMvPct`, `smallMvPct`, `apnea`, `struggles` *(PH)*; `naps[{start, end, hyp}]` | — | — |
| **Add device** | browser time zone (client side) | claim by `{serial, claimCode}` (from QR or typed); then set `{name, room, tz, place}` | — |
| **Share access** | device owner + members: `name, phone, permissions[]`; open invites: `label, permissions[], expiresAt` (no link: it is shown **once**, at creation, and only its hash is stored; a lost link = cancel and invite again) | create invite `{label, permissions[]}` → `{inviteUrl, expiresAt}` (shown once; the owner copies the link and sends it themselves; no SMS from us); cancel invite (link stops working); update a member's permissions; remove a member | — |
| **Device settings** | `name, room, tz, place, nightCutoff (default 12:00), wifiSsid, rssi, fw, autoUpdate`; sensor options `{mounting, range, ledNightOff}` *(PH)* | update settings; "Change Wi-Fi" = send `config_mode`; remove device (deletes history and shares) | — |
| **Alerts** (kept for v1; **in-app only**) | recent alerts `{time, device, type, severity, title, detail}`; no unread badge in v1; rules per device; my per-device "show alerts from" choices | update rules (breath low, out of bed at night, HR range, no movement, offline; thresholds *(PH)*, needs `settings.edit`); turn alerts from a device on/off for me | `alert:new` |
| **Profile** | me `{name, phone, country}`; devices shared with me | update name and country; change password; leave shared devices; delete account; theme (local only) | — |

## Admin side

| Screen | Permission | Reads | Writes | Live |
|---|---|---|---|---|
| **Dashboard** | (any admin) | counts: registered, online, offline, not claimed, customers, running rollouts; online count per hour (24 h); devices per firmware version; last 5 audit entries | — | `device:status` |
| **Devices** | `devices.view` | paged list with search (serial, MAC, name, owner) and status filter: `serial, name, owner, status, tz, fw, chip, lastSeen` | — | `device:status` |
| **Device detail** | `devices.view` | hardware `{mac, chip, radar, fw, registeredAt}`; connection `{online, lastSeen, tz, nightCutoff, ip, rssi, uptime}`; owner + shares; command history `{command, by, sentAt, status}`; latest uploaded logs | send `reboot` / `config_mode` / `ota_check` / `logs` (needs `devices.command`; queued while offline) | `command:status`, `device:status` |
| **Register by USB** | `devices.register` | registered today | register `{mac, chip, hwModel, batch, manufacturedAt, fwOnBoard}` → `{serial, claimCode, qrPayload}`. MAC and chip are read in the browser with Web Serial. No device password: device login is MAC-only. | — |
| **Customers** | `customers.view` | paged list with search, **country** filter and **time zone** filter (device time zones): `name, phone, country, deviceTimeZones[], deviceCount, familyCount, joinedAt, lastActive, status` | — | — |
| **Customer detail** | `customers.view` | customer (incl. country), their devices (with tz), their family members | create password reset link (one-time, 24 h; the admin copies it and sends it); disable / enable account (needs `customers.edit`, with a reason) | — |
| **Firmware & OTA** | `firmware.view` | versions `{version, channel, uploadedAt, size, sha256, deviceCount, notes}`; rollouts `{id, version, target, by, startedAt, state, counts{done, downloading, waiting, failed}}` | upload `.bin` + version, channel, notes (`firmware.upload`); start rollout `{version, target: all / percent / serials / fromVersion, installWindow}`, pause (`firmware.rollout`) | `rollout:progress` |
| **Team & permissions** | `team.manage` | members `{name, phone, role, lastActive}`; open invites `{label, role, expiresAt}` (no link: it is shown **once**, at creation; only its hash is stored); roles with their permission lists | create invite `{label, roleId}` → `{inviteUrl, expiresAt}` (shown once; copy and send the link); cancel invite; change a member's role; add role; switch a permission on/off for a role (Owner is locked) | — |
| **Audit log** | `audit.view` | paged entries `{at, actor, action, target, detail}` with search and action-type filter | — (read-only) | — |
| **Sleep rules** (new) | `platform.settings` | `{mergeGapMin: 30, minSessionMin: 25, defaultNightCutoff: "12:00"}` | update them | — |

## Socket.IO events (summary)

| Event | Payload | Who receives it |
|---|---|---|
| `device:live` | `{serial, pr, bed, ss, hr, br, bs, mv, mr, dist, rssi, at}` | users with `live.view` on that device (only while a live screen is open) |
| `device:status` | `{serial, online, lastSeen}` | the device's owner/shares; admins with `devices.view` |
| `command:status` | `{commandId, serial, status}` | the admin who sent it |
| `rollout:progress` | `{rolloutId, counts}` | admins with `firmware.view` |
| `alert:new` | `{alertId, serial, type, severity, title, at}` | shares with `alerts.receive` |

## Still open

- **`platform.settings`:** a new admin permission for the Sleep rules screen. Handed to the implementation thread (row in `permissions`).
- **Hardware checks:** the ⚠ items in `DEVICE-DATA.md` (sleep-state codes, units, score range).
- **Formats:** serial and claim-code format, and the chip model. The mockup uses `ARG-24A0012`, `7KQ-4MZ-2PX`, ESP32-S3.
