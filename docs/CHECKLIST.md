# Argus: progress checklist

Updated 4 Nov 2026. Live site: https://argus.ecobridgers.com

- [x] = done and tested
- [~] = done but uses sample data on the website, or is not tried by hand yet
- [ ] = not started

## 1. Planning and design
- [x] Plan, decisions and architecture (`CLAUDE.md`)
- [x] Water Tank reference survey (`docs/REFERENCE_NOTES.md`)
- [x] Database design v1.1 + migrations 001, 002 (`docs/DESIGN.md`, `database/`)
- [x] UI/UX clickable mockup v5 (`mockup/`, `docs/SCREENS.md`)
- [x] API contract v1.0 (`docs/API.md`)
- [x] Device data spec: what the ESP32 sends (`docs/DEVICE-DATA.md`)
- [ ] Serial number format (D8). Current default is `ARG-26A0001`.

## 2. Backend (server)

| Step | Status | What it covers |
|---|---|---|
| 1 | [x] | Skeleton: server, database, `/health` |
| 2 | [x] | Login: cookies, refresh, logout, reset links, admin account (18 tests) |
| 3 | [x] | Mosquitto + MQTT: MAC-only device login, per-device topics (27 tests) |
| 4 | [x] | Live data: online/offline, live heart rate and breathing to the browser (35 tests) |
| 5 | [x] | Factory registration, QR claim, my devices, admin devices (46 tests) |
| 6 | [x] | Sleep sessions: store + ack, nights, naps, history (54 tests) |
| 7 | [ ] | Sensor settings sync, commands (reboot, config mode, OTA check, logs), device events |
| 8 | [ ] | Sharing (family invite links), team and roles, audit log, sleep rules |
| 9 | [ ] | In-app alerts, firmware upload + OTA rollouts |
| | [ ] | Fake ESP32 tool, for end-to-end tests without hardware |

## 3. Web app (Next.js)

**Customer screens**

| Screen | Status |
|---|---|
| Login, sign-up, invite link, password reset | [x] real |
| My devices, live view, add device (QR / code), rename, remove | [x] real |
| Sleep history, night detail | [x] real, deployed today |
| Sensor settings, Wi-Fi setup | [~] sample data, waits for step 7 |
| Sharing (family) | [~] sample data, waits for step 8 |
| Alerts, account | [~] alert settings real; alert list waits for step 9 |

**Admin screens**

| Screen | Status |
|---|---|
| Dashboard, devices list + detail, register (USB / typed / CSV) + QR sticker | [x] real |
| Device commands, events | [~] waits for step 7 |
| Customers, team and roles, audit, sleep rules | [~] waits for step 8 |
| Firmware and OTA | [~] waits for step 9 |

## 4. Server (Contabo, shared with Water Tank)
- [x] Code in `/opt/argus`; secrets generated on the server only
- [x] Database, backend, web, gateway running; `/health` all OK
- [x] Domain `argus.ecobridgers.com` + HTTPS (auto-renew)
- [x] Device MQTT over TLS on port 8884 (unknown devices refused)
- [x] Nightly backup at 03:20
- [x] Owner admin account
- [x] Water Tank and magicoutline untouched and healthy

## 5. Things the owner should try by hand
- [ ] Log in on phone and desktop; click through the screens
- [ ] Register a real ESP32 by USB in Chrome or Edge (close Arduino IDE first)
- [ ] Print a QR sticker and claim the device with the phone camera
- [ ] Check the ⚠ values in `DEVICE-DATA.md` on a real C1001
- [ ] Brand name, logo, colours; support phone, email and hours (placeholders now)

## 6. Firmware (last)
- [ ] ESP32 + C1001 firmware over MQTT (follows `DEVICE-DATA.md`)
  - WiFiManager setup + reset 5 times
  - NTP time
  - TLS to port 8884
  - live state, events, info
  - session summary with store-and-forward
  - settings, commands, OTA
- [ ] Rotate the old Firebase secrets after the switch

## 7. Open decisions
- [ ] D8: serial number format
- [x] Days with only naps: kept OUT of main sleep and trends; their naps still show (owner, 4 Nov)
- [ ] Hypnogram resolution: 5 min (default) or 1 min
