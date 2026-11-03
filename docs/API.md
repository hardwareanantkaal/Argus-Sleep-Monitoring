# Argus API contract (v1.0)

**Status:** APPROVED by Devam on 3 Nov 2026, with open items A1–A8 as proposed (§14). Still open inside A1: the meaning of the serial format (D8).

**Derived from:**
- [SCREENS.md](SCREENS.md), going screen by screen
- the approved database [DESIGN.md](DESIGN.md) v1.1 and [schema.sql](../database/schema.sql)
- [DEVICE-DATA.md](DEVICE-DATA.md) for the sensor messages
- the Water Tank `docs/API.md`, for conventions that already work

**Three ways in:**

| Part | Who uses it | What it's for |
|---|---|---|
| **REST** (§1–§9) | the Next.js web app | load data and send actions |
| **Socket.IO** (§10) | the web app | live updates pushed to the browser |
| **MQTT** (§11) | the sensor (ESP32-S3 + C1001) | sends readings, receives commands and settings |

---

## 0. Conventions

| Item | Rule |
|---|---|
| Base URL | `https://<domain>/api/v1`. Locally, `http://localhost:<backend port>/api/v1`; the port is picked at build time, avoiding 3000, 1883, 5432, 5433 and 5050. |
| Auth (web) | **httpOnly cookies**; the browser JavaScript never sees a token. See [auth cookies](#auth-cookies). |
| Auth (device) | MQTT only: **MAC-only login** (owner decision C1). Devices never call REST, except to download firmware (§9). |
| CSRF protection | Cookies are `SameSite=Lax`. Every non-GET request must also send an `Origin` header that is in `CORS_ORIGINS`, otherwise `403 BAD_ORIGIN`. |
| Permissions | Each endpoint lists what it needs. `public` = not logged in. `user` = any logged-in account. **Device permissions** (`live.view`, `history.view`, `alerts.receive`, `settings.edit`, `sharing.manage`) come from the `device_user_permissions` view; the owner has all five. **Staff permissions** (`devices.view` … `platform.settings`) come from `staff_user_permissions`. **No access looks like "not found":** a device you can't see returns `404 NOT_FOUND`, not 403, so nobody can probe which serials exist. |
| Phone | E.164 format (`+919825012345`). |
| Country | ISO 3166 alpha-2 (`IN`, `US`, `AE`). |
| Time | ISO 8601 **UTC** in JSON (`2026-11-02T17:30:00Z`). Every device object carries `tz` (IANA) and `place`, and the UI shows sleep times in the device's time zone. Times of day are local `HH:mm` (`sleepCutoff`, alert windows, install windows). |
| Sleep date | `YYYY-MM-DD`, worked out in the device time zone using the noon cut-off ([DESIGN §5](DESIGN.md#5-sleep-data-the-important-part)). |
| IDs | Devices are addressed by `id` (UUID) in URLs. The `serial` is shown to people. |
| Lists | `?limit=20&cursor=<opaque>` → `{ "items": [...], "nextCursor": "..." \| null }`. Admin lists also return `total`. |
| Errors | `{ "error": { "code": "INVALID_CODE", "message": "That claim code is not valid", "field": "claimCode" } }`. Status codes: 400 `VALIDATION` (with `field`), 401, 403, 404, 409, 422 for business rules, 429, 501 `NOT_ENABLED`. Full list in §12. |
| Disabled user | Any call returns `403 USER_DISABLED`, and refresh fails. |
| Rate limits | Login: 5 failures per 10 min per phone + IP. Claim: 5 failures per 10 min per user. Invite accept: 10 per 10 min per IP. Exceeding them returns `429`. |
| Audit | **Every write** (by staff or customers) adds an `audit_log` row, e.g. `device.claim`, `share.invite`, `team.role.update`. |

### Auth cookies

| Cookie | Holds | Lifetime | Path | Flags |
|---|---|---|---|---|
| `argus_at` | access JWT: `sub`, `tv` (token_version), `sid` | 15 min | `/` | httpOnly, Secure (in production), SameSite=Lax |
| `argus_rt` | refresh token (random; stored only as a sha256 hash in `refresh_tokens`) | 30 days | `/api/v1/auth` | httpOnly, Secure, SameSite=Lax |

- When `argus_at` expires, any call returns `401 TOKEN_EXPIRED`. The web app then calls `POST /auth/refresh` once and retries the request.
- **The refresh token rotates on every refresh.** Re-using an old one logs that user out everywhere (theft detection), the same as Water Tank.
- **Every request reloads the user.** Disabled, deleted and `token_version` are re-checked each time, so a block takes effect immediately.

---

## 1. Auth

Screens: **Login** and **Sign-up**.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 1.1 | POST | `/auth/register` | public | `{fullName, phone, country, password}` → `201 {user}` and sets the cookies. Password at least 8 characters. 409 `PHONE_TAKEN`. **No SMS step in v1** (C3), so `phone_verified_at` stays null. |
| 1.2 | POST | `/auth/login` | public | `{phone, password}` → `{user}` and sets the cookies. 401 `BAD_CREDENTIALS`, 403 `USER_DISABLED`. |
| 1.3 | POST | `/auth/refresh` | `argus_rt` cookie | → `204`, with new cookies. 401 `REFRESH_INVALID`. |
| 1.4 | POST | `/auth/logout` | user | → `204`. **Deletes** this refresh token (so logout never trips theft detection) and clears both cookies. |
| 1.5 | POST | `/auth/logout-all` | user | → `204`. Bumps `token_version` and deletes every refresh token for the user. |
| 1.6 | POST | `/auth/password/reset` | public | `{token, newPassword}` → `204`. `token` comes from a reset link made by support (7.4). Logs the user out everywhere. 400 `RESET_TOKEN_INVALID`. |
| 1.7 | POST | `/auth/otp/*` | — | `501 NOT_ENABLED` in v1. The code path is kept so SMS can be switched on later (C3). |

**The `user` object** (returned by 1.1, 1.2 and 2.1):
```json
{ "id": "uuid", "fullName": "Priya Shah", "phone": "+919825012345", "country": "IN",
  "kind": "customer", "role": null, "permissions": [], "createdAt": "2026-10-02T06:00:00Z" }
```
- For staff: `"kind": "admin"`, `"role": {"id": 3, "name": "Manufacturing"}`, and `permissions` lists their staff permission codes.
- `kind` is `admin` when `users.staff_role_id` is set. A staff member who also owns a sensor sees both the admin menu and "My devices".
- Device permissions are **not** in this object; they come per device (`myPermissions` in 3.x).

**Forgot password (v1):** with no SMS, the Login screen says "Ask Argus support to send you a reset link". Support uses 7.4.

## 2. My account

Screens: **Profile**, and "How to reach me" on the Alerts screen.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 2.1 | GET | `/me` | user | → `user` |
| 2.2 | PATCH | `/me` | user | `{fullName?, country?}` → `user`. The phone can't be changed (it's the login); the UI says "contact support". |
| 2.3 | POST | `/me/password` | user | `{currentPassword, newPassword}` → `204`. Logs out every *other* session. 401 `BAD_CREDENTIALS`. |
| 2.4 | DELETE | `/me` | user | `{password}` → `204`. Soft-deletes the account. **Every device the user owns is released**: owner removed, shares and invites deleted, **sleep sessions and alerts deleted** (D5), new claim code needed from support. Shares the user had on other people's devices are removed. |
| 2.5 | GET | `/me/notification-prefs` | user | → `{quietEnabled, quietFrom, quietTo, mutedDeviceIds: []}`. In-app alert preferences. In quiet hours only `critical` alerts pop up (all still appear in the list). `mutedDeviceIds` = "Show me alerts from" switched off: alerts from those sensors are **not shown to this user at all** (6.1, `alert:new`); other people are unaffected. |
| 2.6 | PATCH | `/me/notification-prefs` | user | the same fields → the saved prefs. `mutedDeviceIds` replaces the whole list and may only contain devices you can access (`404 NOT_FOUND` otherwise). Quiet hours need both times (`400 VALIDATION`); they're read in each sensor's own time zone, as the UI shows them. Alerts are **in-app only** in v1 (owner decision 3 Nov), so there are no push or SMS switches. |
| 2.7 | POST | `/me/push-subscriptions` | user | **v1: `501 NOT_ENABLED`** (alerts are in-app only). Kept for later: `{subscription, platform: "web"}` → `204`, where `subscription` is the browser's Web Push subscription JSON (upsert, called after the browser grants permission). |
| 2.8 | DELETE | `/me/push-subscriptions` | user | **v1: `501 NOT_ENABLED`.** Kept for later: `{endpoint}` → `204`, called on logout. |

## 3. My devices

Screens: **My devices**, **Live view**, **Add device**, **Device settings**.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 3.1 | GET | `/devices` | user | → `{items: [deviceCard]}`. Owned and shared devices, no paging (one person has a few sensors). |
| 3.2 | POST | `/devices/claim/check` | user | `{qr}` or `{claimCode, serial?}` → `{serial, hwModel, registeredAt}`. Shows "ARG-24A0031, registered 1 Nov 2026" before confirming. 404 `INVALID_CODE` (also for an already-used code), 409 `ALREADY_CLAIMED`, 403 `DEVICE_DISABLED`. |
| 3.3 | POST | `/devices/claim` | user | `{qr}` or `{claimCode, serial?}`, plus `{name, room?, tz, place?}` → `201 deviceDetail`. In one transaction: sets the owner, clears `claim_code_hash`, copies `app_settings.default_sleep_cutoff`, creates `device_settings` and the 5 default `alert_rules`, writes a `claimed` event. The `tz` must be a valid IANA name (`422 INVALID_TIMEZONE`). |
| 3.4 | GET | `/devices/:id` | any device permission | → `deviceDetail` |
| 3.5 | PATCH | `/devices/:id` | `settings.edit` | `{name?, room?, tz?, place?, sleepCutoff?, autoUpdate?}` → `deviceDetail`. Backend-only settings, so the sensor isn't contacted. A new `tz` applies to **new** sessions only; old nights keep their time zone. `place: null` clears it. |
| 3.6 | GET | `/devices/:id/sensor-settings` | `settings.edit` | → `sensorSettings` |
| 3.7 | PATCH | `/devices/:id/sensor-settings` | `settings.edit` | `{exitS?, liveS?, idleS?, struggle?, unattended?, unattMin?}` → `{settings: sensorSettings}`. Sent to the sensor at once if it's online, otherwise when it reconnects (retained message). Ranges follow the DB checks, e.g. `exitS` 30–3600 (`400 VALIDATION`). |
| 3.8 | POST | `/devices/:id/wifi-setup` | `settings.edit` | → `202 {commandId, status}`. Sends the `config_mode` command ("Change Wi-Fi network"). **Expires after 30 s** if the sensor is offline (D4): `status` comes back as `"sent"` or `"expired"`. |
| 3.9 | DELETE | `/devices/:id` | owner only | `{confirmName}` → `204`. "Remove device": owner removed, shares, invites, **sleep sessions, alerts and rules deleted**, `unclaimed` event. The old QR stops working, and support issues a new code (8.6) so a resold sensor can't be re-claimed by the old owner. 422 `CONFIRM_MISMATCH` if `confirmName` isn't the device name. |
| 3.10 | DELETE | `/devices/:id/me` | a share (not the owner) | → `204`. "Leave shared device" (also clears your mute for it). The owner gets `422 OWNER_CANNOT_LEAVE` (they remove the device instead, 3.9). |

**`deviceCard`:**
```json
{ "id": "uuid", "serial": "ARG-24A0012", "name": "Mom's bedroom", "room": "Master bedroom",
  "tz": "Asia/Kolkata", "place": "Surat", "isOwner": true, "sharedBy": null,
  "myPermissions": ["live.view","history.view","alerts.receive","settings.edit","sharing.manage"],
  "status": { "online": true, "lastSeenAt": "2026-11-03T08:20:11Z" },
  "live": { "pr": 1, "bed": 1, "ss": 1, "hr": 61, "br": 14, "at": "2026-11-03T08:20:10Z" },
  "lastNight": { "sleepDate": "2026-11-02", "score": 82, "totalSleepMin": 432 } }
```
- `live` is the **latest value held in memory** (it's never stored). It's only included with `live.view`, and is `null` when the sensor is offline or the backend has just restarted.
- `lastNight` is only included with `history.view`.
- `sharedBy` is `{fullName}` when the device is shared with you.

**`deviceDetail`** = `deviceCard` +
```json
{ "sleepCutoff": "12:00", "autoUpdate": true, "hwModel": "ARG-S1 rev B",
  "connection": { "fw": "1.4.2", "rssi": -57, "wifiSsid": "Shah_Home_5G", "uptimeS": 533000 },
  "sensorSync": { "version": 4, "appliedVersion": 4, "sync": "applied" } }
```
- `sync` is `"applied"`, `"sending"` (online and waiting for the ack) or `"queued_offline"`. It drives the "Saved on device ✓" badge.
- `connection.fw` is included with `live.view` (the Live view shows it); the rest of `connection` and `sensorSync` only with `settings.edit`.

**`sensorSettings`:** `{exitS: 300, liveS: 5, idleS: 60, struggle: true, unattended: false, unattMin: 30, version, appliedVersion, sync}`

**QR and claim code:**
- The code is 12 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, shown as `XXXX-XXXX-XXXX` (D2). Dashes and lower case are accepted when typed.
- The QR holds only `<QR prefix>:<code>`, e.g. `ARG1:K7P29XQM4HTR`, the same idea as Water Tank's `WT2`. That way a normal phone scanner learns nothing about the device. The prefix is open (§14).
- The serial is printed beside the QR. If it's typed together with the code, the backend checks they match. With about 59 bits of randomness the code alone is enough to find the device.

## 4. Sleep history

Screens: **Sleep history** and **Night detail**. All of this is computed from `sleep_sessions` when it's read, using the rules in [DESIGN §5](DESIGN.md#5-sleep-data-the-important-part):
- hide sessions under `min_session_min`
- merge sessions less than `merge_gap_min` apart
- date each group by the device's `sleep_cutoff`, in the **session's own `timezone`**
- the longest group on a date is the main sleep; the rest are naps

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 4.1 | GET | `/devices/:id/nights?days=14` | `history.view` | → `{device: {tz, place}, nights: [nightCard], averages}`. Newest first. `days` 1–90. Also accepts `?from=2026-10-01&to=2026-10-31` (sleep dates). |
| 4.2 | GET | `/devices/:id/nights/:sleepDate` | `history.view` | → `nightDetail`. 404 when there's no main sleep on that date. |

**`nightCard`:**
```json
{ "sleepDate": "2026-11-02", "start": "2026-11-02T17:12:00Z", "end": "2026-11-03T01:30:00Z",
  "score": 82, "totalSleepMin": 432, "inBedMin": 498,
  "stageMin": { "deep": 147, "light": 250, "awake": 35, "outOfBed": 66 },
  "sessionCount": 2, "naps": [ { "start": "2026-11-03T09:40:00Z", "end": "2026-11-03T10:25:00Z" } ] }
```

`averages` (main sleeps only): `{nights, totalSleepMin, score, hrAvg, wakeUps}`. These feed the four tiles on Sleep history.

**`nightDetail`** = `nightCard` +
```json
{ "efficiencyPct": 87, "wakeUps": 3, "exits": 1, "oobMin": 66,
  "sessions": [ { "start": "...", "end": "..." }, { "start": "...", "end": "..." } ],
  "epochS": 300, "hyp": "AALLLDDDLLDDDLLALL...OOOOLLDDD...",
  "hr": { "avg": 61, "min": 52, "max": 78 }, "br": { "avg": 14.2, "min": 11, "max": 19 },
  "turns": 14, "bigMvPct": 6, "smallMvPct": 21, "apnea": 0, "struggles": 0,
  "naps": [ { "start": "...", "end": "...", "totalSleepMin": 38, "hyp": "AALLL..." } ] }
```

**How the numbers are worked out** (written here so the UI and backend agree):

| Field | Calculation |
|---|---|
| `start` / `end` | first session start / last session end |
| `inBedMin` | the sum of session lengths |
| `totalSleepMin` | the sum of `sleep_min` |
| `oobMin` | the sum of `oob_min` plus the gaps between sessions |
| `efficiencyPct` | `totalSleepMin / (end − start)`, rounded |
| `stageMin` | count of each `hyp` letter × `epochS` / 60. Gaps between sessions count as `outOfBed`. |
| `hyp` | the sessions' hypnograms joined, with gaps filled with `O` (shaded in the UI) |
| `wakeUps` | the number of `A` runs after the first `D`/`L` |
| `score`, `hr.avg`, `br.avg` | averages weighted by session length |
| min / max | taken across the sessions |
| counts (`exits`, `turns`, `apnea`, `struggles`) | summed |

## 5. Sharing (family)

Screen: **Share access**.

**Invites are link-only** (owner decision 3 Nov). Only the token's hash is stored, so **the link is shown once, at creation**: lists (5.1, 9.10) never contain a URL; to re-send, cancel the invite and create a new one. An invite has no phone number: whoever opens the link and is logged in can accept it, once. The token in the link is the secret (256 bits, only its HMAC is stored). The owner sends the link themselves (WhatsApp, a normal SMS, or copy and paste). Link format: **`inviteUrl = PUBLIC_BASE_URL + /invite/<token>`**.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 5.1 | GET | `/devices/:id/shares` | `sharing.manage` | → `{owner: {fullName, phone}, shares: [{userId, fullName, phone, permissions[], status: "joined"}], invites: [{id, label, permissions[], status: "invite_sent", expiresAt}]}`. `label` is the owner's note, e.g. "Rohan (son)". |
| 5.2 | POST | `/devices/:id/invites` | `sharing.manage` | `{label, permissions[]}` → `201 {invite: {id, label, permissions[], expiresAt}, inviteUrl, expiresAt}`. `label` 1–60 characters. `inviteUrl` = `PUBLIC_BASE_URL/invite/<token>`, **shown only in this response**. Valid for 7 days. Only device permissions are allowed (`422 BAD_PERMISSION`). You can't give `sharing.manage` unless you're the owner. |
| 5.3 | DELETE | `/devices/:id/invites/:inviteId` | `sharing.manage` | → `204` (cancels it; the link stops working) |
| 5.4 | PATCH | `/devices/:id/shares/:userId` | `sharing.manage` | `{permissions[]}` → share. An empty list → `422`; use 5.5 instead. |
| 5.5 | DELETE | `/devices/:id/shares/:userId` | `sharing.manage` | → `204`. The person loses access at once (Socket.IO `access:changed`). |
| 5.6 | GET | `/invites/:token` | public | → `{kind: "device" \| "staff", inviterName, label, deviceName?, roleName?, permissions[], expiresAt}`. `permissions` = the device permissions offered, or for a staff invite the role's permission codes. The invite landing page uses this before log-in or sign-up. 404 `INVITE_INVALID` (unknown, expired, used or cancelled). |
| 5.7 | POST | `/invites/:token/accept` | user | → `{device: deviceCard}` or `{role}`. Needs only a session and a valid token (no phone check). Single use: the invite is marked accepted in the same transaction. Works for both family and team invites. 409 `ALREADY_SHARED` if you already own or share that device; 409 `ALREADY_STAFF` for a team invite when you already have a staff role. |

**Accepting an invite:** the landing page (`/invite/<token>`) shows who invited you and to what (5.6), offers "Log in" or "Create account", and calls 5.7 right after log-in or sign-up.

## 6. Alerts

Screen: **Alerts** (kept for v1, C2). Rules belong to the device; how you're reached belongs to you (2.5).

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 6.1 | GET | `/alerts?deviceId=&limit&cursor` | user | → `{items: [{id, deviceId, deviceName, type, severity, title, detail, value, startedAt, endedAt}]}`. Only devices where I have `alerts.receive`. Newest first. |
| 6.2 | GET | `/devices/:id/alert-rules` | `alerts.receive` or `settings.edit` | → `{rules: [alertRule], canEdit}` |
| 6.3 | PUT | `/devices/:id/alert-rules` | `settings.edit` | `{rules: [alertRule]}` → the saved rules. 422 `BAD_RULE` (e.g. low ≥ high). |

**`alertRule`:** `{type, enabled, low, high, durationS, windowFrom, windowTo}`. These are the five types from the mockup:

| `type` | Default | Severity |
|---|---|---|
| `breath_low` | low 8 /min for 30 s | critical |
| `hr_out_of_range` | low 45, high 110 bpm, for 60 s | critical |
| `out_of_bed` | longer than 600 s, between 23:00 and 06:00 | warning |
| `no_movement` | in bed with no movement for 10800 s; off by default | warning |
| `device_offline` | 900 s | warning |

**How alerts are checked and sent:**
- The backend checks the rules on every live message. The sensor sends one every 5 s in bed, so a 30 s rule sees about 6 readings.
- An open alert closes when the value is back to normal (`endedAt`).
- **Delivery is in-app only in v1** (owner decision 3 Nov; replaces A5): every alert appears in the list (6.1) and on Socket.IO `alert:new` to users who are online. No Web Push, no SMS.
- There's no read/unread state in v1 (§14).

## 7. Admin: customers

Screens: **Customers** and **Customer detail**. Every path starts with `/admin`, and every write is audited.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 7.1 | GET | `/admin/customers?q&country&tz&status&limit&cursor` | `customers.view` | `q` matches name or phone. `tz` matches any of the customer's device time zones. `status` is `active` or `disabled`. → `{items: [{id, fullName, phone, country, deviceTimeZones[], deviceCount, familyCount, createdAt, lastActiveAt, status}], total, nextCursor}` |
| 7.2 | GET | `/admin/customers/:id` | `customers.view` | → customer (incl. country) + `devices[{id, serial, name, tz, online, fw, lastSeenAt}]` + `family[{fullName, phone, deviceName}]` |
| 7.3 | POST | `/admin/customers/:id/disable` | `customers.edit` | `{reason}` → `204`. Bumps `token_version` (logs them out at once). `/enable` → `204`. |
| 7.4 | POST | `/admin/customers/:id/reset-link` | `customers.edit` | → `{resetUrl, expiresAt}` with **`resetUrl = PUBLIC_BASE_URL + /reset/<token>`**. A single-use link valid for **24 h** (a purpose token tied to `token_version`; support sends it by WhatsApp), **shown once**. Support sends it to the customer. It replaces "Send password reset link by SMS" in v1. |
| 7.5 | POST | `/admin/customers/:id/logout-all` | `customers.edit` | → `204` |

## 8. Admin: devices and factory

Screens: **Dashboard**, **Devices**, **Device detail**, **Register by USB**.

| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 8.1 | GET | `/admin/dashboard` | any staff | → `{counts: {registered, online, offline, unclaimed, disabled, customers, registeredThisWeek, customersThisWeek, rolloutsRunning}, onlineHourly: [{hour, online}] (24), fwVersions: [{version, count}], recentAudit: [...5]}`. `recentAudit` is only included with `audit.view`. |
| 8.2 | GET | `/admin/devices?q&status&fw&tz&registeredFrom&limit&cursor` | `devices.view` | `q` matches serial, MAC (with or without colons, 4+ hex digits), device name, or owner name or phone. `status` is `online`, `offline`, `unclaimed` or `disabled`. `registeredFrom` is `YYYY-MM-DD`. → `{items: [{id, serial, mac, name, owner: {id, fullName} \| null, online, isDisabled, tz, fw, chip, lastSeenAt, createdAt}], total, nextCursor}`, newest first. "Registered today" on the Register screen uses `registeredFrom`. |
| 8.3 | GET | `/admin/devices/:id` | `devices.view` | → `{hardware: {mac, chip, radar: "DFRobot C1001", hwModel, batch, manufacturedAt, fwAtRegister, registeredAt, registeredBy}, connection: {online, lastSeenAt, ip, wifiSsid, rssi, uptimeS, fw, radarOk}, tz, place, sleepCutoff, isDisabled, disabledReason, owner, shares[], claimCodeActive, sensorSettings}` |
| 8.4 | POST | `/admin/devices` | `devices.register` | `{mac, chip, hwModel, batch?, manufacturedAt?, fwOnBoard?}` → `201 {device: {id, serial, mac, chip, registeredAt}, serial, claimCode, qrPayload, qrPngBase64}`. `claimCode` = `XXXX-XXXX-XXXX`, `qrPayload` = `ARG1:<code without dashes>`; **both are shown only in this response** (only the HMAC is stored). `qrPngBase64` is optional for the UI (the web draws the QR itself). The serial is generated under an advisory lock so two registrations never get the same one: `ARG-<YY><letter><4 digits>`, e.g. `ARG-26A0001` (format still open, D8). The MQTT username is the MAC as 12 lowercase hex characters. Nothing is written to the board (MAC-only login). 409 `MAC_EXISTS`. Bulk registration = one call per CSV line (no bulk route in v1). The MAC and chip are read in the browser with Web Serial (esptool-js), as in Water Tank. |
| 8.5 | PATCH | `/admin/devices/:id` | `devices.command` | `{isDisabled, disabledReason?}` → `{id, serial, isDisabled, disabledReason}`. A reason is required when disabling (`400 VALIDATION`). Disabling refuses new MQTT logins at once; an already-connected sensor loses topic access within about 60 s (the broker's ACL cache). |
| 8.6 | POST | `/admin/devices/:id/claim-code` | `devices.register` | → `{serial, claimCode, qrPayload, qrPngBase64}`. A new code; the old one stops working. For a lost sticker or a resold device. On a device that still has an owner the code only works after unclaim (claim gives `409 ALREADY_CLAIMED`). |
| 8.7 | POST | `/admin/devices/:id/unclaim` | `customers.edit` | `{reason}` → `204`. Same effect as 3.9 (history deleted). `409 NOT_CLAIMED` if it has no owner. |
| 8.8 | POST | `/admin/devices/:id/commands` | `devices.command` | `{type: "reboot" \| "config_mode" \| "ota_check" \| "logs"}` → `202 {commandId, status: "sent" \| "queued"}`. Offline sensors: `config_mode` expires after 30 s, the others **wait up to 24 h** (D4) and are sent when the sensor reconnects. |
| 8.9 | GET | `/admin/devices/:id/commands?limit&cursor` | `devices.view` | → `{items: [{id, type, requestedBy, status, error, createdAt, sentAt, ackedAt}]}` |
| 8.10 | GET | `/admin/devices/:id/logs` | `devices.view` | → `{items: [{id, createdAt, content}]}`. The last 5 uploads from the `logs` command. |
| 8.11 | GET | `/admin/devices/:id/events?limit&cursor` | `devices.view` | → `{items: [{id, type, detail, createdAt}], nextCursor}`, newest first. |
| 8.12 | DELETE | `/admin/devices/:id` | `devices.register` | → `204`. Only for a device that was **never claimed** (e.g. a mistyped MAC); otherwise 409 `DEVICE_IN_USE`. |

## 9. Admin: firmware, team, audit, sleep rules

### Firmware and OTA (screen: Firmware & OTA)
| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 9.1 | GET | `/admin/firmware` | `firmware.view` | → `{items: [{id, version, channel, chipModel, fileSize, sha256, notes, uploadedBy, createdAt, deviceCount}]}` |
| 9.2 | POST | `/admin/firmware` | `firmware.upload` | multipart: `file` (.bin, max **4 MB**; the first byte must be `0xE9`), `version`, `channel`, `notes` → `201 release`. The backend computes sha256 and saves the file under `OTA_DIR`. 409 `VERSION_EXISTS`, 422 `NOT_ESP_IMAGE`. |
| 9.3 | PATCH | `/admin/firmware/:id` | `firmware.upload` | `{channel?, notes?}` → release |
| 9.4 | DELETE | `/admin/firmware/:id` | `firmware.upload` | → `204`. Refused while a rollout uses it (409). |
| 9.5 | POST | `/admin/ota/rollouts` | `firmware.rollout` | `{releaseId, target: "all" \| "percent" \| "serials" \| "from_version", percent?, serials?[], fromVersion?, installWindow: {from: "10:00", to: "18:00"} \| null}` → `201 {rolloutId, devices: n}`. The device list is fixed now. Devices with `autoUpdate = false` are left out unless listed by serial. |
| 9.6 | GET | `/admin/ota/rollouts` | `firmware.view` | → `{items: [{id, version, target, createdBy, createdAt, status, counts: {done, downloading, waiting, failed}}]}`. `status` is `running`, `paused`, `finished` or `cancelled`. |
| 9.7 | GET | `/admin/ota/rollouts/:id` | `firmware.view` | → rollout + `devices[{deviceId, serial, status, fromVersion, error, updatedAt}]` |
| 9.8 | POST | `/admin/ota/rollouts/:id/pause` · `/resume` · `/cancel` · `/retry` | `firmware.rollout` | → `204`. Pause stops new sends; devices already updated keep the new version. Cancel marks `pending` devices as `skipped`. Retry re-sends to `failed` devices. |
| 9.9 | GET | `/fw/:releaseId.bin?t=<token>` | device | Firmware download for OTA, outside `/api/v1`. The token is in the MQTT `ota` message and lasts 10 min. Responses include `Content-Length` and `x-MD5`. |

**OTA install window:** an OTA is only sent when the device's local time is inside `installWindow`. Combined with the `tz` column, that means "daytime only, never during sleep".

### Team and roles (screen: Team & permissions)
| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 9.10 | GET | `/admin/team` | `team.manage` | → `{members: [{userId, fullName, phone, role: {id, name}, lastActiveAt}], invites: [{id, label, role: {id, name}, expiresAt}]}` |
| 9.11 | POST | `/admin/team/invites` | `team.manage` | `{label, roleId}` → `201 {invite: {id, label, role, expiresAt}, inviteUrl, expiresAt}`. Link-only, as in 5.2 (`PUBLIC_BASE_URL/invite/<token>`, 7 days). Only the Owner can invite into the Owner role. |
| 9.12 | DELETE | `/admin/team/invites/:id` | `team.manage` | → `204` |
| 9.13 | PATCH | `/admin/team/:userId` | `team.manage` | `{roleId}` → member. You can't change your own role (`422 OWN_ROLE`), and the Owner role always keeps at least one member (`422 LAST_OWNER`). |
| 9.14 | DELETE | `/admin/team/:userId` | `team.manage` | → `204`. Removes the staff role; the account stays as a customer. Bumps `token_version`. |
| 9.15 | GET | `/admin/roles` | `team.manage` | → `{roles: [{id, name, isOwner, permissions[], memberCount}], permissions: [{code, label, scope: "staff"}]}` |
| 9.16 | POST | `/admin/roles` | `team.manage` | `{name, permissions[]}` → `201 role`. 409 `ROLE_EXISTS`. |
| 9.17 | PATCH | `/admin/roles/:id` | `team.manage` | `{name?, permissions?}` → role. The Owner role is refused with `409 ROLE_LOCKED`. Members' sessions pick up the change on their next request. |
| 9.18 | DELETE | `/admin/roles/:id` | `team.manage` | → `204`. Only when the role has no members (`409 ROLE_IN_USE`). |

### Audit log and sleep rules
| # | Method | Path | Needs | Body → Response |
|---|---|---|---|---|
| 9.19 | GET | `/admin/audit?q&action&actorId&targetType&targetId&from&to&limit&cursor` | `audit.view` | `action` is a prefix (`device`, `ota`, `firmware`, `share`, `customer`, `team`). → `{items: [{id, at, actorName, action, targetType, targetLabel, detail}]}`. Read-only. `from` / `to` are `YYYY-MM-DD`, inclusive, in UTC. |
| 9.20 | GET | `/admin/platform-settings` | `platform.settings` | → `{mergeGapMin: 30, minSessionMin: 25, defaultSleepCutoff: "12:00"}` |
| 9.21 | PATCH | `/admin/platform-settings` | `platform.settings` | same fields → saved. History regroups on the next read. The default cut-off applies only to devices claimed afterwards. |

---

## 10. Socket.IO (live updates to the browser)

- **Connect:** `io({ withCredentials: true, transports: ["websocket"] })`, same origin, through Nginx at `/socket.io`. The server reads the `argus_at` cookie from the handshake. If it fails: `TOKEN_EXPIRED`, `INVALID_TOKEN` or `USER_DISABLED`.
- **When the token expires,** the server emits `auth:expired` and disconnects. The app calls `POST /auth/refresh`, then reconnects (the Water Tank `socket.ts` reconnect fix).

| Direction | Event | Payload | Who / when |
|---|---|---|---|
| client → server | `devices:subscribe` | `{deviceIds}` (max 200) | My devices, Live view. Joins `device:<id>` for the devices you can access. Ack: `{ok, deviceIds, status: [{deviceId, online, lastSeenAt}]}`. |
| client → server | `live:subscribe` / `live:unsubscribe` | `{deviceId}` | Live view, and the cards on My devices. Needs `live.view`. Ack: `{ok, live}` (the latest value). |
| client → server | `admin:subscribe` | `{topics: ["devices", "rollouts"]}` | Admin screens. Needs `devices.view` / `firmware.view`. |
| server → client | `device:status` | `{deviceId, serial, online, lastSeenAt}` | the device room and `admin:devices`; on change only |
| server → client | `device:live` | `{deviceId, serial, pr, bed, ss, hr, br, bs, mv, mr, dist, rssi, at}` | live subscribers only; every live message (5 s in bed / 60 s idle). **Never stored.** |
| server → client | `settings:sync` | `{deviceId, version, appliedVersion, sync}` | the device room ("Saved on device ✓") |
| server → client | `command:status` | `{commandId, deviceId, serial, type, status, error}` | the sender, plus `admin:devices` |
| server → client | `rollout:progress` | `{rolloutId, status, counts, deviceId, deviceStatus}` (`status` = the rollout's `running \| paused \| finished \| cancelled`; `deviceStatus` = that device's OTA status) | `admin:rollouts` |
| server → client | `alert:new` | `{alertId, deviceId, serial, type, severity, title, at}` | users with `alerts.receive` on that device |
| server → client | `alert:ended` | `{alertId, deviceId, endedAt}` | the same users |
| server → client | `access:changed` | `{deviceId, myPermissions[] \| null}` | the affected user, when a share is added, changed or removed |
| server → client | `auth:expired` | `{}` | see above |

## 11. MQTT (sensor ↔ backend)

The full payloads are in [DEVICE-DATA.md](DEVICE-DATA.md); this table is the contract summary.

- **Broker:** Mosquitto with go-auth, as in Water Tank. TLS on 8883 in production; plain 1883 only inside Docker or locally, on a port picked to avoid the taken ones.
- **Login (C1):** username = client id = MAC as 12 lowercase hex characters. The password is ignored, but the firmware should send a non-empty dummy value. The device must exist and not be disabled.
- **Session:** keepalive 60 s, clean session. Last will: `<p>/<d>/status = offline`, QoS 1, retained.
- **Topic names:** `<p>` = topic prefix (proposed `argus`, still open). `<d>` = the MQTT username.

| Topic | Direction | QoS / retain | Payload → what the backend does |
|---|---|---|---|
| `<p>/<d>/status` | device → | 1, retained | `online` on connect; `offline` from the last will. Updates `device_state.is_online` and emits `device:status`. Coming online also re-sends pending settings, queued commands and any pending OTA. |
| `<p>/<d>/info` | device → | 1, retained | **New (proposed):** `{"fw","ip","ssid","chip","radar":1,"rst":"poweron"}`, sent once on connect. Fills `device_state` (ip, ssid, fw, radar_ok), which the Device settings and Device detail screens show. Not in DEVICE-DATA.md yet (§14). |
| `<p>/<d>/state` | device → | 0 | Live values (DEVICE-DATA §2). Kept **in memory only**; emits `device:live`; checks alert rules; updates `last_seen_at` / `rssi` / `uptime` in `device_state`, but only on change or every 5 min. |
| `<p>/<d>/event` | device → | 1 | `bed_in`, `bed_out`, `struggle`, `unattended`, `reboot`, `config_mode`, `radar_fault`, `radar_ok` → `device_events`. |
| `<p>/<d>/session` | device → | 1 | One session summary (DEVICE-DATA §4). Validated, then `INSERT … ON CONFLICT (device_id, started_at) DO NOTHING`, with `timezone` = the device's current `tz`. **The `session/ack` is always sent, even for a duplicate** (so the device can clear its flash). If the device is **unclaimed**, the session is acked and dropped (nobody owns it). If validation fails: acked with `{"sid":N,"ok":0,"err":"..."}` and logged as an event, so a bad message can't block the flash queue. |
| `<p>/<d>/session/ack` | → device | 1 | `{"sid":128}`. The device deletes that session from flash. |
| `<p>/<d>/cmd` | → device | 1, not retained | `{"id":812,"c":"reboot"}`. Commands: `reboot`, `config_mode`, `ota_check`, `logs`. |
| `<p>/<d>/cmd/ack` | device → | 1 | `{"id":812,"ok":1}` or `{"id":812,"ok":0,"err":"..."}` → `device_commands` + `command:status` |
| `<p>/<d>/logs` | device → | 1 | Reply to `logs`: `{"id":812,"part":1,"of":4,"text":"..."}`, each part ≤ 3 KB (the broker limit is 4 KB). The backend joins the parts into `device_log_uploads`. The device sends `cmd/ack` after the last part. |
| `<p>/<d>/settings/set` | → device | 1, **retained** | `{"v":4,"exit_s":300,"live_s":5,"idle_s":60,"struggle":1,"unattended":0,"unatt_min":30}` |
| `<p>/<d>/settings/ack` | device → | 1 | `{"v":4}` after saving to flash. Applied only if `applied_version < v ≤ version`. The device must re-ack a duplicate `v`. |
| `<p>/<d>/ota` | → device | 1 | `{"rid":7,"ver":"1.4.3","url":"https://<domain>/fw/12.bin?t=…","sha256":"…","size":1240000}` |
| `<p>/<d>/ota/status` | device → | 1 | `{"rid":7,"s":"downloading" \| "success" \| "failed","err":"…"}`. A later `info` / `state` with `fw == ver` also counts as success. |

**What a device may publish and subscribe to (ACL):** only topics under `<p>/<its own username>/`.
- Publish: `status`, `info`, `state`, `event`, `session`, `cmd/ack`, `logs`, `settings/ack`, `ota/status`.
- Subscribe: `cmd`, `settings/set`, `ota`, `session/ack`.
- The backend's own MQTT user has full access.

**Broker limits:** `message_size_limit 4096` (largest message: a session, under 1 KB; log parts are ≤ 3 KB), `max_keepalive 300`, `max_queued_messages 200`.

## 12. Error codes

| Status | Codes |
|---|---|
| 400 | `VALIDATION` (+`field`), `RESET_TOKEN_INVALID` |
| 401 | `NOT_LOGGED_IN`, `TOKEN_EXPIRED`, `REFRESH_INVALID`, `BAD_CREDENTIALS` |
| 403 | `FORBIDDEN` (staff permission missing), `USER_DISABLED`, `DEVICE_DISABLED`, `BAD_ORIGIN` |
| 404 | `NOT_FOUND` (also used when you have no access to a device), `INVALID_CODE`, `INVITE_INVALID` |
| 409 | `PHONE_TAKEN`, `ALREADY_CLAIMED`, `ALREADY_SHARED`, `ALREADY_STAFF`, `NOT_CLAIMED`, `MAC_EXISTS`, `VERSION_EXISTS`, `ROLE_EXISTS`, `ROLE_LOCKED`, `ROLE_IN_USE`, `DEVICE_IN_USE` |
| 422 | `INVALID_TIMEZONE`, `BAD_PERMISSION`, `BAD_RULE`, `CONFIRM_MISMATCH`, `OWN_ROLE`, `LAST_OWNER`, `NOT_ESP_IMAGE`, `OWNER_CANNOT_LEAVE` |
| 429 | `RATE_LIMITED` (+`retryAfterS`) |
| 501 | `NOT_ENABLED` (OTP / SMS and push subscriptions in v1) |

## 13. Screen → API map

| Screen | Calls |
|---|---|
| Login | 1.2, then 2.1 |
| Sign-up | 1.1 → (3.2, 3.3 or skip) |
| Invite landing | 5.6 → 1.2 or 1.1 → 5.7 |
| My devices | 3.1, socket `devices:subscribe`, `live:subscribe` per card, `device:status`, `device:live` |
| Live view | 3.4, socket `live:subscribe`, `device:live` |
| Sleep history | 3.1 (device switcher), 4.1 |
| Night detail | 4.2 |
| Add device | 3.2, 3.3 |
| Share access | 5.1–5.5 |
| Device settings | 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, socket `settings:sync` |
| Alerts | 6.1, 6.2, 6.3, socket `alert:new` |
| Profile | 2.1–2.4, 3.10, 1.4 |
| Admin dashboard | 8.1, socket `device:status` |
| Admin devices / detail | 8.2, 8.3, 8.5–8.12, socket `command:status` |
| Register by USB | 8.4, 8.2 (`registeredFrom=today`) |
| Customers / detail | 7.1–7.5 |
| Firmware & OTA | 9.1–9.8, socket `rollout:progress` |
| Team & permissions | 9.10–9.18 |
| Audit log | 9.19 |
| Sleep rules | 9.20, 9.21 |

## 14. Decisions (approved as proposed, 3 Nov 2026)

| # | Item | Decision |
|---|---|---|
| A1 | **Topic prefix, QR prefix and serial format** (D8) | Topic prefix `argus`, QR prefix `ARG1`. Serial: tell me what `ARG-24A0012` stands for. |
| A2 | **QR content** | The code only (`ARG1:<12-char code>`), as in Water Tank. Typing in the app needs the code only, and the serial is optional. This differs slightly from D2 ("serial + code"); the code alone is safe at 12 characters. |
| A3 | **New `info` message** on connect (§11) | Add it to DEVICE-DATA.md. Without it, the IP, Wi-Fi name and radar status on the settings and admin screens stay empty. |
| A4 | **Sensor options in the UI** | SCREENS.md still lists mockup placeholders (mounting, range, night LED). The real settings are those in DEVICE-DATA.md §5 (bed-exit timeout, rates, struggle, unattended). The UI thread should switch. |
| A5 | **Push technology** | ~~Web Push (VAPID keys)~~ **Replaced 3 Nov by the owner: alerts are in-app only in v1.** Endpoints 2.7/2.8 return 501; Web Push can be switched on later without an API change. |
| A6 | **Alert read/unread** | Not in v1 (no unread badge). Adding it later is one small table. |
| A7 | **Forgot password** | v1: support sends a reset link (7.4). Self-service reset arrives with SMS later. |
| A8 | **Firmware size limit** | 4 MB (ESP32-S3 app partitions are 1.5–3 MB). Nginx `client_max_body_size` must match. |
