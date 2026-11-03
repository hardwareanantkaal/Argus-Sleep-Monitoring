# CLAUDE.md — Argus Sleep Monitoring Platform

Context for Claude Code working in this folder. Read fully before doing anything.

## 1. Who you're working with

- Owner: Devam Gandhi, Anantkaal LLP (R&D electronics, Surat, India).
- Strong in embedded firmware (ESP32/ESP8266, ESP-IDF, Arduino), hardware, IoT protocols.
- **Beginner at web/backend.** Explain backend, database, Docker and deployment steps simply, with the "why", and give exact commands.
- Conversation in English. Frame explanations from an IoT / embedded point of view.
- When changing existing code, show only the changes, not the whole file again.

## 2. What this project is

Argus Sleep Monitoring: **one ESP32 + DFRobot C1001 60 GHz mmWave radar per device**, placed near a bed. It measures presence, movement, heart rate, breath rate and sleep stages, and produces a nightly sleep summary.

Today it uses **Firebase RTDB** + a React/Vite PWA.
- Existing repo: `hardwareanantkaal/Argus_Sleep_Monitoring` (firmware on `IOT` branch, web app on `main`), web deployed on Vercel.

**Goal of this project:** remove Firebase and re-platform onto our own server:
- MQTT (Mosquitto) between device and server
- WebSocket (Socket.IO) between server and browser
- PostgreSQL database
- Customer onboarding, admin + customer panels, team/family access
- Device registration by USB (auto-detect MAC + chip model) and QR-sticker claiming
- OTA firmware updates from the panel
- Hosting on a Contabo VPS (or AWS EC2)

## 3. Reference project (READ-ONLY)

This is the second project of this kind. The first was the **Water Tank** project (ESP + Node backend + admin panel + MQTT + Socket.IO + PostgreSQL on Contabo).

- Location: `~/projects/waterlevel-platform` (same WSL distro, `Ubuntu`).
- It has no `PROJECT_CONTEXT.md`. The context lives in `README.md`, `DEPLOY.md`, `database/DESIGN.md`, `docs/API.md`, `docs/DEVICE-API.md` and `docs/ui-mockup.html`. A full survey is in `docs/REFERENCE_NOTES.md` here.
- **Never modify anything in the water project.** Read it, copy code and patterns into this repo, adapt here.
- Reuse as much as possible: backend structure, auth (JWT + refresh rotation), MQTT bridge, Mosquitto go-auth setup, Socket.IO rooms, registration + QR claim, OTA flow, Docker Compose, Nginx config, DEPLOY.md, backup script.

## 4. Decisions already made

| Topic | Decision |
|---|---|
| Client app | **No mobile app.** One responsive web app (works on phone, tablet, desktop). PWA install is optional. |
| Frontend | Next.js |
| Backend | Node.js (reuse the water project's Express backend pattern): REST API + MQTT bridge + Socket.IO in a long-running service. Next.js API routes are NOT used for MQTT/WebSocket. |
| Database | PostgreSQL 16 (Docker), SQL migrations run on backend start |
| Broker | Mosquitto (`iegomez/mosquitto-go-auth`), TLS on 8883; 1883 only inside Docker/localhost |
| Live updates | Socket.IO, room per device + `admin` room |
| Hosting | Contabo VPS or EC2, Docker Compose, host Nginx + certbot, shared VPS rules from reference |
| Dev machine | Windows + WSL, project in `~/projects/argus-sleep-platform` |
| Login | Phone + password (E.164). SMS OTP not now. |
| Alerts / push / SMS | **Not needed** for now |
| Wi-Fi setup on device | Same as reference: WiFiManager portal + 5x reset |
| Device commands | Same as reference: `reboot`, `config_mode`, `ota_check`, plus `logs` request |
| Night boundary | **None.** A session = bed entry → bed exit, decided by the device |
| Data storage | **Store only nightly sleep summaries** (plus devices, users, events, commands, OTA). Live values go MQTT → Socket.IO → screen only and are not stored. |
| Web app | One app, role-based screens (admin side + customer side) |

> Some rows here were refined on 3 Nov 2026 (alerts are now in-app only, and sessions are grouped into nights). See §11.

## 5. Users, roles and access

Two account types:

1. **Admin side (Anantkaal)**
   - Main admin (super admin) has full control.
   - Main admin can create a **team**: e.g. Developer, Manufacturing, and decide what each member can do (register devices, print QR, firmware/OTA, view customers, view devices, manage team…).
2. **Customer side**
   - Device owner claims devices via QR.
   - Owner can give access to family or anyone else and control what each person can do (same permission system as admin team).

Design: one permission system used by both sides (account → members → permissions per device or per area). Every admin write goes to `audit_log`.

## 6. Device registration and claim (from reference, adapted)

1. Technician connects device by USB on the admin page (Chrome/Edge, Web Serial + `esptool-js`): reads **MAC and chip model** (ESP32 / ESP32-S3 / ESP8266…) automatically.
2. Backend creates the device, serial number, MQTT username = MAC (lowercase, no colons), and a one-time claim token (only HMAC stored).
3. QR sticker with opaque payload `<QR_PREFIX>:<token>` + serial + typed code printed beside it.
4. Customer scans QR in the web app → `claim/check` → `claim` → becomes owner. One owner. Admin can reissue code.
5. Broker accepts the device's MQTT login only after registration.

## 7. MQTT contract

The final contract is in `docs/API.md`; device payloads are in `docs/DEVICE-DATA.md`. Topic prefix `<p>` = `argus`; `<d>` = device MAC.

## 8. Open items

- D8: the serial number format / meaning.
- Check the ⚠ items in `docs/DEVICE-DATA.md` on a real C1001 board.
- Domain / subdomain (given at deployment time). Brand name and theme.
- The support contact details (phone/WhatsApp, email, hours) on the "Forgot password" card are placeholders.

## 9. Build order

Follow the reference: **contract first, code later.** Get owner approval at each step.

1. Planning doc: feature list + architecture ✅
2. Database design → `docs/DESIGN.md` + `database/schema.sql` ✅ (v1.1 approved)
3. UI/UX: clickable HTML mockup of all screens (`mockup/index.html`, `docs/SCREENS.md`) ✅ (approved)
4. API contract `docs/API.md` ✅ (v1.0 approved)
5. Build backend + web app + deploy files ← **NEXT**
6. Deploy to VPS step by step, checking `/health` after each step
7. Move firmware from Firebase to MQTT (last), then rotate any old Firebase secrets

## 10. Rules

- Never put secrets in code, firmware or chat. Secrets live only in the server `.env`.
- Never modify the water project.
- Don't start writing code before the owner approves the plan / schema / API for that step.
- Keep the database small: nightly summaries only, no raw time series.
- Bind containers to 127.0.0.1; never expose 1883, 3000, 5432 publicly.
- Dev ports must not clash with the water and magic-outline stacks, which already use 3000, 1883, 5432, 5433 and 5050.

## 11. Decisions added on 3 Nov 2026

The details are in `docs/DESIGN.md` §10–11, `docs/API.md` and `docs/DEVICE-DATA.md`.

**Environment**
- The project lives in the `Ubuntu-22.04` WSL distro. The planned move to `Ubuntu` was cancelled.
  - Docker 29.9.2 is installed here.
  - Node 22.23.4 is at `~/.local/node/bin` and is not on PATH, so prefix commands with `export PATH="$HOME/.local/node/bin:$PATH"`.
- Dev ports: backend 3100, postgres 5434, mosquitto 1885, web 3101.
- **Pushing:** git in this distro has no GitHub login. The owner pushes from Windows PowerShell:
  `git -c safe.directory=* -C \\wsl.localhost\Ubuntu-22.04\home\dev29\projects\argus-sleep-platform push origin main`
- GitHub repo: `hardwareanantkaal/Argus-Sleep-Monitoring`.

**Auth and accounts**
- **Device MQTT login:** MAC only, no password (`secret_hash` nullable, kept as a reserve).
- **Web login:** httpOnly cookies.
- **No SMS anywhere in v1.**
  - Password reset is a one-time link that an admin creates and support sends.
  - Invites are accepted only through the link token (`/invite/<token>`), never by matching the phone.

**Alerts**
- Kept for v1, **in-app only** (no push, no SMS).

**Sleep data**
- **Sessions:** one stored row per device session (`sleep_sessions`).
- **Nights:** sessions less than 30 min apart merge into one night (admin "Sleep rules" setting).
  - Sleep date uses a noon cut-off in the device timezone, configurable per device.
  - The longest group is the main sleep; the others are naps (shown).
  - Sessions under 25 min are hidden.
- **Stages:** the C1001 has **no REM**. Stages are Deep / Light / Awake / Out of bed (hypnogram D/L/A/O).

**Regions**
- Each device has an IANA timezone and an optional `place` ("Town or city", e.g. "Surat time"; when empty the label falls back to the timezone).
- Each user has a `country` (ISO-2).

**Firmware**
- The firmware is not written yet; it follows `docs/DEVICE-DATA.md`.
- Live state every 5 s in bed and 60 s when idle, with a 5 min bed-exit timeout.
