# Vendor v2: handoff for the next Claude session

Owner approved on 5 Nov 2026. **Built on 5 Nov 2026** (migration 008; see `docs/VENDOR.md` §v2 and `docs/API.md` §15). Not deployed to prod yet.
Read first: `CLAUDE.md`, `docs/VENDOR.md` (v1, already built and live), `docs/API.md` §15, `docs/CHECKLIST.md`.

## 1. Current state (v1, live on argus.ecobridgers.com)

**Admin:**
- creates a vendor (`POST /admin/vendors`)
- then **separately** invites the owner (`POST /admin/vendors/:id/invites`)

**Vendor members:**
- claim a device by QR, which sets `devices.vendor_id` and **clears the claim code**
- groups hold devices
- team invites by link
- temporary access grants (`device_access_grants`)

**Code:**
- Migration `database/migrations/007_vendors.sql`
- Backend:
  - `backend/src/routes/vendor.js`
  - `backend/src/routes/admin/vendors.js`
  - `backend/src/services/vendors.js`
  - `backend/src/lib/claim.js`
  - `backend/src/routes/devices.js` (claim)
- Web:
  - `web/src/app/(app)/vendor/*`
  - `web/src/app/(app)/admin/vendors/*`
  - `web/src/components/vendor.tsx`
  - `web/src/components/ClaimFlow.tsx`

## 2. What changes in v2 (owner decisions)

### A. Admin adds a vendor in ONE step
- One form: company name, owner full name, owner phone, owner email, optional contact.
- Save → creates the vendor AND returns the owner invite link at once (`inviteUrl`, shown once, 7 days).
- Remove the separate "create, then invite owner" step from the UI. The re-invite endpoint can stay for lost links.

### B. The QR works TWICE (same sticker)
1. **Admin** registers the device and ships it with its QR sticker. Unchanged.
2. **Vendor claims** by QR:
   - the device goes into the vendor's **stock** (`vendor_id` set, `owner_id` null)
   - **the claim code must NOT be cleared**
   - add a stage marker, e.g. `devices.claim_stage`: `factory` → `vendor_stock` → `owned`
3. **Customer claims** the SAME QR:
   - `owner_id` = customer, `vendor_id` KEPT (the device is "sold by" that vendor)
   - claim code cleared
   - the customer is now that vendor's customer
4. A non-vendor scanning a factory-stage code claims directly as a normal customer, as today.
5. A vendor member scanning a `vendor_stock` code of THEIR vendor → "already in your stock". Another vendor → `ALREADY_CLAIMED`.

### C. Vendor customer = full owner
- The customer can share with family and remove the device, the same as a direct customer.
- The vendor relation stays on the device.
- **Data visibility: NO privacy limit for now.** Vendor members keep full device permissions (live, history, alerts, settings) on sold devices too. `sharing.manage` stays owner-only.

### D. Vendor dashboard

| Section | Content |
|---|---|
| **Stock** | Counts: total, **not sold / not in use** (`vendor_stock`), sold (`owned`) |
| **Customers** (NEW) | Each customer who claimed one of this vendor's devices: name, phone, country, claimed date, plus **their devices**. One customer can have many devices. |
| **Devices** | All vendor devices: serial, stage (stock / sold), customer, online/offline, firmware, claimed date, group |
| **Groups** | Hold **devices**, not customers (already like this in v1) |

### E. Keep from v1
- **Temporary access grants:** owner wants this kept. It works on stock devices and sold devices.
- Vendor team (doctor, nurse, staff) by link.
- Firmware/OTA admin only; vendor sees the version.
- Sensor model name never shown ("Sensor").

### F. Admin view
Vendor detail shows stock, sold devices, and the vendor's customers.

## 3. Work list

1. **Migration 008:**
   - `devices.claim_stage` (enum or text + CHECK), backfilled from the current data
   - claim code kept for `vendor_stock`
   - update `database/schema.sql`
   - never edit 001–007
2. **Claim logic** (`lib/claim.js`, `routes/devices.js` 3.2/3.3): the two-stage claim above. Claim check (3.2) returns the stage, so the UI can say "Add to your stock" or "This sensor is sold by <vendor>".
3. **Sticker reprint** (`/admin/devices/:id/sticker`, migration 006 `claim_code_enc`): it must still work while the device is in `vendor_stock`. Clear it only at `owned`.
4. **Admin one-step vendor create:** `POST /admin/vendors` takes the owner fields too and returns `{vendor, inviteUrl, expiresAt}`.
5. **Vendor API:**
   - `GET /vendor/summary` (stock counts)
   - `GET /vendor/customers` (customers + their devices)
   - add `stage` + `customer` to `GET /vendor/devices`
6. **Web:**
   - admin one-step form
   - vendor dashboard tabs: Stock / Customers / Devices / Groups / Team / Access
   - ClaimFlow messages for both stages
   - device cards show "Sold by <vendor>" for customers
7. Update `docs/API.md` §15 and `docs/VENDOR.md`.

## 4. How to work in this repo

**Location:** WSL **Ubuntu-22.04**, `/home/dev29/projects/argus-sleep-platform`.

**Node:**
- 22.23.4 at `~/.local/node/bin`, not on PATH.
- Prefix commands with `export PATH="$HOME/.local/node/bin:$PATH"`.

**Dev stack:**
- `docker compose up -d` in the repo root.
- Ports: backend 127.0.0.1:3100, postgres 5434, mosquitto 1885, web dev 3101.
- If container networking stalls: `docker compose down && docker compose up -d`.

**Checks:**
- Backend tests: `cd backend && npm test`. The owner said no new tests are needed; `commands.test.js` has some known-stale assertions.
- Web: `cd web && npx next build` must pass.

**Deploy to prod** (Contabo 94.136.187.14, shared with the Water Tank project, so don't touch `/opt/watertank`). SSH key `~/.ssh/argus_contabo` (user root).
1. `git bundle create /tmp/x.bundle HEAD main`
2. `scp -i ~/.ssh/argus_contabo /tmp/x.bundle root@94.136.187.14:/root/argus.bundle`
3. On the server:
   ```
   cd /opt/argus && git pull --ff-only /root/argus.bundle main \
     && docker compose -f docker-compose.prod.yml up -d --build backend web
   ```
4. Check: `curl -s http://127.0.0.1:8090/health` should show ok/db/mqtt all true.

**Git:**
- This WSL can't push. The owner pushes from Windows PowerShell:
  `git -c safe.directory=* -C \\wsl.localhost\Ubuntu-22.04\home\dev29\projects\argus-sleep-platform push origin main`
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

**Owner:** Devam. He is strong in embedded and a beginner in web. Explain simply and briefly, and keep answers short.

## 5. Other open items (not part of vendor v2)

**Firmware:**
- The top-level `sleeplamp/` holds the fixed firmware (nightly report fixes, light/deep staging, keepalive 15 s, OTA deferred, min_sess).
- It is **not compiled yet** and **not committed** (the folder is untracked).
- The owner sets `FW_VERSION "2.3.0"`, compiles and flashes, then tests a night.
- After that, commit it and replace the old `firmware/sleeplamp/`.

**Other items:**
- GitHub is 26+ commits behind; the owner pushes.
- Serial format (D8), brand name, logo and support contact are still open.
- The owner is doing small UI fixes himself. Deploy them when he asks.
