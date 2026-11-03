# Reference notes: Water Tank project

Read-only survey of the earlier Water Tank project, used as the template for Argus.
Surveyed 2026-11-03. Nothing in the water project was modified.

- **Location:** `~/projects/waterlevel-platform` in the **`Ubuntu`** WSL distro (Claude Code runs in `Ubuntu-22.04`).
- **Read it with:** `wsl.exe -d Ubuntu -- bash -lc 'cd ~/projects/waterlevel-platform && <cmd>' 2>&1 | tr -d '\0'`
- **Where its context lives (there is no `PROJECT_CONTEXT.md`):** `README.md`, `DEPLOY.md`, `database/DESIGN.md` (stale on the QR format), `docs/API.md`, `docs/DEVICE-API.md`, `docs/ui-mockup.html`.
- **Latest commit:** `0f729cf`, "QR sticker holds only a random one-time token; read board MACs over USB".

All paths below are relative to the water project root.

---

## 1. Tech stack

**Backend** (`backend/package.json`)
- Node 22 (`node:22-alpine`), CommonJS, Express 5.
- Raw SQL with `pg` (no ORM).
- Other dependencies: bcryptjs, jsonwebtoken, mqtt 5, socket.io 4.8, zod 4, pino, helmet, cors, multer, qrcode, luxon, firebase-admin (FCM only).
- Scripts: `start`, `dev`, `migrate`, `migrate:status`, `create-admin`, `test`, `fake-device`.

**Admin panel** (`admin-panel/`)
- React 18, react-router 6, Vite 5, TypeScript.
- socket.io-client.
- esptool-js 0.7.0 (pinned).
- No UI library.

**Mobile** (`mobile/`)
- Flutter. Not needed for Argus.

**Infrastructure**
- postgres:16-alpine
- `iegomez/mosquitto-go-auth:3.0.0-mosquitto_2.0.18`
- nginx:1.27-alpine
- pgadmin4 (dev only)

## 2. Backend structure (`backend/`)

**Entry and core**
- `src/index.js`: boot order is DB check → app → Socket.IO → `live.start()` → MQTT connect → scheduler. Shuts down gracefully.
- `src/app.js`: helmet; `/mqtt` auth hook; `/fw` firmware files; `/health` returns `{ok, db, mqtt}` (503 when unhealthy); `/api/v1` routes; central error handler.
- `src/config.js`: every env var in one place. Dev defaults are allowed, but missing values throw in production.
- `src/db.js`: pg Pool plus `query / one / many / tx`.
- `src/errors.js`: `ApiError`. Error shape is `{error:{code,message,field}}`.
- `src/logger.js`: pino with redaction.

**Middleware**
- `middleware/auth.js`: `requireUser`, `requireAdmin`, `loadUserFromToken`.
- `middleware/rateLimit.js`: in-memory limiter.

**Helpers (`lib/`)**
- `crypto.js`: sha256, HMAC with pepper, claim token, bcrypt, `safeEqual`.
- `qr.js`: QR payload, PNG, A4 sticker sheet HTML.
- `format.js`: phone (E.164), MAC normalising, cursors, version compare.
- `validate.js`: zod → `400 VALIDATION`.
- `audit.js`, `serialize.js`, `sms.js`.

**Routes**
- `auth`, `me`, `devices`, `invites`, `notifications`, `dev`.
- `mqttAuth` (go-auth hook).
- `firmwareFiles`.
- `admin/{index, devices, users, firmware}`.

**Services**
- MQTT and live data:
  - `mqtt.js`: backend MQTT client.
  - `live.js`: the MQTT → in-memory cache → Socket.IO pipeline. It holds a lock per device, writes the DB only on change or on a heartbeat, and runs the online/offline stale sweep.
- Socket and device protocol:
  - `realtime.js`: Socket.IO rooms, throttled emits.
  - `commands.js`, `settingsSync.js`, `ota.js`.
- Access and events:
  - `access.js`: device permission middleware.
  - `events.js`, `alerts.js`, `push.js`.
- Background jobs:
  - `scheduler.js`: interval jobs (command expiry, stale sweep, stats, cleanup).

**Tests**
- `test/api.test.js`: 18 end-to-end tests against the Docker stack.
- `test/helpers.js`: a `FakeDevice` MQTT class.
- `test/fake-device.js`: a simulated-board CLI.

**Design notes**
- Express 5 catches async errors itself, so routes have no try/catch.
- The scheduler, rate limiter and caches are in-memory. That assumes **one backend instance**; scaling out would need Redis.

## 3. Auth

**Login**
- Phone (E.164) + password, bcrypt cost 11.
- An SMS OTP flow exists (msg91) but is off with `SMS_PROVIDER=none`.

**Access token**
- JWT HS256, 15 min.
- Claims: `sub`, `role`, `tv` (token_version), `sid`.
- Every request reloads the user and checks blocked, deleted and token_version.

**Refresh token**
- 32 random bytes, stored as a sha256 hash, 30 days.
- **Rotated on every refresh**, inside a transaction with `FOR UPDATE`.
- Reuse of a rotated token revokes everything and bumps token_version (theft detection).
- Logout **deletes** the row rather than revoking it, so a normal logout doesn't trip theft detection.
- logout-all, block and admin password reset bump token_version and disconnect the user's sockets.

**Purpose tokens**
- JWTs with `aud=purpose`.
- Used for password reset (10 min) and firmware download (`fw`, 10 min).

**Roles and permissions**
- Account roles: `super_admin | user`.
- Device access uses the `device_access` view (owner UNION shares). Rank: view < control < owner < admin.
- **Argus needs more than this:** custom per-permission roles for the admin team and family. This is a new design.

**Rate limits**
- Login: 5 failures per 10 min per phone+IP.
- Claim: 5 failures.
- Refresh: 60.

## 4. MQTT contract (water version)

Source: `docs/DEVICE-API.md`.

**Connection**
- MQTT 3.1.1, TLS 1.2 on 8883.
- Client ID = username = MAC (12 lowercase hex characters).
- Password ignored (MAC-only login).
- Keepalive 60 s, clean session.
- Last will: `<p>/<d>/status = offline`, QoS 1, retained.

**Topics**

| Topic | Direction | QoS / retain | Payload |
|---|---|---|---|
| `status` | device → server | 1, retained | `online` / `offline` |
| `state` | device → server | 0 | short-key JSON, every 5 s and on change |
| `event` | device → server | 1 | `{"t":"reboot"\|"config_mode"\|...}` |
| `cmd` | server → device | 1, not retained, not queued | `{"id":812,"c":"reboot"}` |
| `cmd/ack` | device → server | 1 | `{"id":812,"ok":1}` or `{"id":812,"ok":0,"err":"..."}` |
| `settings/set` | server → device | 1, **retained** | `{"v":4,...}` |
| `settings/ack` | device → server | 1 | `{"v":4}`, after saving to flash |
| `ota` | server → device | 1 | `{"rid","ver","url","sha256","size"}` |
| `ota/status` | device → server | 1 | `{"rid","s":"downloading"\|"success"\|"failed","err"}` |

**Commands**
1. Insert a `device_commands` row (pending, 30 s TTL), then publish; the row becomes `sent`.
2. The ack sets it to `acked` or `failed`. The scheduler expires old rows; going offline fails open ones.
3. The result goes out on Socket.IO `command:result`.
4. The REST API refuses with `409 DEVICE_OFFLINE` when the device is offline.

**Settings**
1. A DB trigger bumps `version` and logs `settings_changes`.
2. The backend publishes the retained message.
3. The device acks `{"v":N}`. The ack is applied only if `applied_version < v <= version`.
4. On reconnect, the backend republishes if the device is behind.
- The device must re-ack a duplicate `v`.
- An empty retained message means the device was deleted.

**Presence**
- The last will marks the device offline.
- The stale sweep (every 15 s) marks it offline after 60 s of silence.
- On coming online, the backend republishes pending settings and sends any pending OTA.

**OTA**
1. Admin uploads a `.bin` (multer). The first byte must be `0xE9`; sha256 is stored in `firmware_releases`.
2. A rollout creates `ota_rollouts` and `ota_rollout_devices` rows.
3. The device gets `url = PUBLIC_BASE_URL/fw/<id>.bin?t=<10-min JWT>` plus sha256 and size.
4. `/fw/:id.bin` verifies the token and serves the file with Content-Length and an `x-MD5` header.
5. `state.fw == ver` also counts as success.
6. Progress goes out as `ota:progress`. Cancel and retry are supported.

## 5. Mosquitto go-auth

Files: `mosquitto/config/mosquitto.conf` (dev), `deploy/mosquitto/mosquitto.conf` (prod), `backend/src/routes/mqttAuth.js`.

**How it works**
- The HTTP backend calls `backend:3000` at `/mqtt/user` and `/mqtt/acl`, with JSON params. The response is 200 to allow or 403 to deny.
- Superuser is disabled.
- Cache: auth 2 s, ACL 60 s.
- Prod also sets `max_keepalive 300`, `max_queued_messages 200` and `message_size_limit 4096`.

**Backend login**
- Username `MQTT_BACKEND_USERNAME`, password compared with `safeEqual`.
- Gets full ACL.

**Device login**
- Username must match `^[0-9a-f]{12}$`, and clientid must equal the username.
- The device must exist and not be disabled.
- A 10 s cache sits in front of the DB, and `forget()` clears it when a device is disabled.

**ACL**
- Topics are limited to `<p>/<username>/`.
- Devices may publish: status, state, event, cmd/ack, settings/ack, ota/status.
- Devices may subscribe: cmd, settings/set, ota.

**Exposure**
- Hook accepts private IPs only. Nginx returns 404 for `/mqtt`.
- Prod: 8883 TLS public; 1883 on `127.0.0.1` and inside the Docker network only.

## 6. Socket.IO (`services/realtime.js`)

**Auth**
- `io(url,{auth:{token}})`.
- A failed handshake returns `TOKEN_EXPIRED / INVALID_TOKEN / TOKEN_REVOKED`.
- The server emits `auth:expired` when the token expires.

**Rooms**
- `user:<id>`: joined automatically.
- `admin`: joined automatically by super admins.
- `device:<id>`: joined via `device:subscribe {deviceIds}` (access checked, at most 200), with ack `{ok, deviceIds, states}`.

**Events**
- `device:state`: at most 1 per second per device, only when changed.
- `device:online`, `command:result`, `settings:sync`, `device:event`, `notification`, `access:changed`.
- Admin room only: `admin:stats`, `ota:progress`.

**Client**
- `admin-panel/src/lib/socket.ts` keeps a handler registry that survives reconnects, and reconnects after a token refresh (bug fix 454ca47).
- Transport: websocket only.

## 7. Database

Files: `database/schema.sql`, `database/migrations/001..004`.

**Migrations** (`backend/scripts/migrate.js`)
- Apply `migrations/*.sql` in filename order, recorded in `schema_migrations`. Each file has its own BEGIN/COMMIT.
- Run on every container start.
- Never edit an applied migration; add a new one.

**Conventions**
- UUID primary keys.
- TIMESTAMPTZ in UTC.
- `set_updated_at` trigger.
- Soft-delete users.

**Reusable tables**
- Accounts: users, refresh_tokens, otp_codes, push_tokens.
- Firmware and devices: firmware_releases, devices, device_boards.
- Sharing: device_shares, device_invites.
- Activity: device_events, device_commands.
- Alerts: alert_settings, notifications.
- OTA and admin: ota_rollouts, ota_rollout_devices, audit_log.
- Views: `device_access`, `admin_stats`.

**Water-only (drop)**
- Tables: pump_runs, timers.
- The water columns in device_settings and device_state.
- The pump enums.

**Other notes**
- 002 adds pg_trgm search indexes and partial indexes for background jobs.
- For Argus, fold 003 and 004 into a fresh 001.
- Cleanup runs every 6 h: commands and notifications older than 1 year, events older than 2 years, expired OTP codes, refresh tokens and invites.

## 8. Registration and claim

**USB (Web Serial)**
- `admin-panel/src/lib/usbMac.ts`: `requestPort` → esptool-js `ESPLoader` → `detectChip` → `readMac` → hard reset. Nothing is written to the board.
- Chrome/Edge only, over https or localhost.
- Error hints: "close Arduino IDE"; "hold BOOT, press RESET".
- **Works for ESP32 as is.**

**Register** (`POST /admin/devices`)
- Runs in a transaction with `pg_advisory_xact_lock` so serial numbers never collide.
- Duplicate MAC returns 409.
- Serial format: `WT-<year>-<5 digits>`.
- MQTT username = MAC.
- Publishes the retained settings straight away.
- Returns the claim code once, plus the QR PNG.
- Bulk version returns a sticker sheet. Admin can reissue codes.

**Claim token**
- 16 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (about 78 bits), shown as `XXXX-XXXX-XXXX-XXXX`.
- Stored as `HMAC-SHA256(HASH_PEPPER, "claim:"+code)`.
- **Never change `HASH_PEPPER`**: it invalidates every printed sticker.

**QR payload**
- `WT2:<token>`, with no serial or MAC inside.

**Claim endpoints**
- `POST /devices/claim/check`, then `POST /devices/claim`.
- The claim is a single-use UPDATE that is safe if two people try at once.
- Errors: `INVALID_CODE`, `ALREADY_CLAIMED`, `DEVICE_DISABLED`.
- Removing a device does not re-enable its QR.

## 9. Docker, Nginx, deploy

**Dev** (`docker-compose.yml`)

| Service | Port | Notes |
|---|---|---|
| postgres | `127.0.0.1:5433` | 5432 is taken on the dev machine |
| mosquitto | `1883` | |
| backend | `3000` | `node --watch`, bind-mounts the source |
| pgadmin | `127.0.0.1:5050` | |

The Vite dev server on 5173 proxies `/api`, `/fw` and `/socket.io`.

**Prod** (`docker-compose.prod.yml`)
- One internal network; postgres not published.
- backend: runs as `node`, has a healthcheck, `TRUST_PROXY=2`.
- mosquitto: `8883` public, `127.0.0.1:1883`.
- web: `127.0.0.1:8088`.
- The stack never binds 80 or 443 (the host Nginx is shared with another site).

**Nginx**
- `deploy/nginx/web.conf` (the web container):
  - `/mqtt` returns 404; `/api` proxies to the backend.
  - `/socket.io` with Upgrade headers and a 3600 s timeout.
  - `/fw` with buffering off.
  - SPA fallback; assets cached.
- `deploy/nginx/host-*.conf`: proxies to `127.0.0.1:8088`, WebSocket upgrade map. Certbot `--nginx --redirect` adds the 443 lines.

**Certificates**
- `deploy/certbot-deploy-hook.sh` copies the certificates to `deploy/certs/mosquitto/` with owner uid 1000 and key mode 600, then restarts Mosquitto and reloads Nginx.

**Backup** (`deploy/backup.sh`, cron 03:15)
- `pg_dump -Fc` plus a tar of the OTA files, kept 14 days.
- Restore with `pg_restore --clean --if-exists`.

**Deploy steps** (`DEPLOY.md`)
1. Check ports.
2. Install Docker.
3. Clone to `/opt/...`.
4. Create `.env` (chmod 600).
5. Start postgres, backend and web.
6. Host Nginx block, then certbot.
7. Install the certificate hook, then start Mosquitto.
8. `ufw allow 8883` only.
9. `create-admin`.
10. Backup cron.

**Env variable names** (values never copied)
- Domain and proxy: DOMAIN, PUBLIC_BASE_URL, CORS_ORIGINS, TRUST_PROXY, WEB_PORT.
- PostgreSQL: POSTGRES_*, DATABASE_URL.
- Secrets: JWT_SECRET, HASH_PEPPER.
- MQTT: MQTT_BACKEND_USERNAME/PASSWORD, MQTT_*_PORT, MQTT_URL.
- SMS: SMS_PROVIDER, MSG91_*.
- Timing: ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_DAYS, OTA_DIR, OTA_TOKEN_TTL_S, DEVICE_STALE_S, COMMAND_TTL_S, STATE_HEARTBEAT_S.
- Other: LOG_LEVEL, DEV_ENDPOINTS, MQTT_AUTH_HOOK_TOKEN.

## 10. Lessons learned

**Certificates and TLS**
- Mosquitto (uid 1000) can't read `/etc/letsencrypt`. Copy the certificates with the right owner and modes; missing certificates cause a restart loop.
- Start the stack without Mosquitto until the certificate exists.
- ESP TLS needs NTP time first. Use the ISRG Root X1 CA; `setInsecure()` only while testing.

**Proxy and networking**
- `CORS_ORIGINS` must match exactly, or login fails with a "network error".
- The host Nginx must pass Upgrade/Connection headers, or live updates break.
- `TRUST_PROXY=2` (host Nginx plus the web container) so `req.ip` is right for rate limits.
- Never expose `/mqtt`, 1883, 3000, 5432 or 8088.

**MQTT and devices**
- MQTT 3.1.1 silently drops publishes that the ACL denies; the client gets no error.
- The last will can be lost, so the stale sweep is needed.
- Commands are not retained or queued.
- The device must re-ack a duplicate settings version.
- One-off warning events are stored already resolved.
- `live.js` writes the DB only on change or on a heartbeat, with a lock per device.

**Auth**
- Logout deletes the refresh token, so it doesn't trip theft detection.
- Never change `HASH_PEPPER`.

## 11. Reuse map for Argus

**Copy and rename (`wt` → Argus prefix, project names, domain)**
- Backend core:
  - `backend/src/{index,app,config,db,errors,logger}.js`
  - `middleware/*`
  - `lib/{crypto,validate,audit,qr,sms,format}.js`
- Auth and accounts:
  - `services/tokens.js`
  - `routes/{auth,me,invites,notifications}.js`, `routes/admin/users.js`
- MQTT and devices:
  - `routes/mqttAuth.js` (change the topic sets)
  - `services/{mqtt,realtime,access,events,commands,settingsSync,ota}.js`
- Firmware:
  - `routes/firmwareFiles.js` (drop the legacy `/ota` routes)
  - `routes/admin/firmware.js` (raise the 1 MB limit)
- Scripts and tests:
  - `scripts/{migrate,create-admin}.js`, `docker-start.sh`, `backend/Dockerfile`
  - Test FakeDevice
- Infrastructure:
  - Both compose files
  - Both mosquitto.conf files
  - `deploy/*` (Nginx, certbot hook, backup.sh)
  - `.env.example`, `pgadmin/servers.json`
- Admin panel:
  - `admin-panel/src/lib/{api,socket,usbMac,format}.ts`, `components/ui.tsx`
  - Page patterns: Login, Users, Firmware, Rollout, Audit, Dashboard
- Docs as templates: `DEPLOY.md`, `docs/DEVICE-API.md`, `docs/API.md`

**Rewrite for Argus**
- Live data and jobs:
  - `services/live.js`: keep the skeleton, rewrite the state and event handling for radar values.
  - `services/scheduler.js`: keep the runner, drop the pump jobs.
  - `services/alerts.js`: not needed now.
  - `services/{settingsService,deviceViews}.js`
- Routes:
  - `routes/devices.js`: keep claim and sharing; drop pump and timers.
  - `routes/admin/devices.js`: one ESP32 board, new serial prefix, chip model.
- Database:
  - The device_settings and device_state columns.
  - Enums and event types.
  - Add a sleep summary table.
- Web app: Next.js replaces `admin-panel` and `mobile/`.

## 12. Open decisions found during the survey

1. **Device MQTT login.** The water project is MAC-only, which is weak because a MAC isn't secret. Suggest a per-device secret (`secret_hash` already exists).
2. **Firmware upload limit.** 1 MB is too small for ESP32. Raise it in multer and in Nginx `client_max_body_size`.
3. **Web auth storage.** For Next.js, consider httpOnly cookies instead of tokens in JS memory or storage.
4. **Permissions.** Argus needs custom per-permission roles (admin team plus family), beyond view/control/owner.
5. **Mosquitto `message_size_limit 4096`.** Check it against the size of the sleep summary payload.
