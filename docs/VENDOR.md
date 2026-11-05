# Vendor feature (approved by owner, 5 Nov 2026)

## Roles
- **Admin (Anantkaal):** everything. Only the admin can upload firmware and run OTA. Admins see all vendors.
- **Vendor:** an organization or a person, e.g. a hospital, a mall, or one individual.
- **Customer:** an end user.

Two paths:
- Admin → Customer: direct sale, as today.
- Vendor → Groups (simple list, e.g. "Ward 3", "Floor 1") → devices → customers / users.

## Vendor can
1. Be created by the admin. The admin can also see every vendor with its devices and groups.
2. **Claim devices by QR** (the same claim code as customers). The device then belongs to the vendor (`devices.vendor_id`), not to a person.
3. Create **groups** (name only; simple) and put devices in a group.
4. Have a **vendor team** (doctor, nurse, staff):
   - The vendor owner invites team members by **link** (same mechanism as staff invites).
   - Team members see the vendor's devices.
   - Keep it simple: members see all of the vendor's devices. Per-group restriction can come later.
5. Give a **customer/user login with TEMPORARY access** to one device:
   - custom start date/time and end date/time
   - a login invite link
   - access ends automatically at `ends_at`
   - the vendor can extend it or end it early
6. People with **temporary access** cannot share devices. Only the vendor (and its team) grants access. (v2: a customer who **bought** a device from the vendor is its full owner and can share it, see below.)
7. Vendors see the **firmware version** only: no upload, no OTA.
8. Vendors see live data, history and alerts of their devices.

## Privacy
When temporary access ends, the customer loses the device. The device's history stays with the vendor.
(v2.1: once a customer owns a sensor, the vendor keeps only a record of the sale and has no access.)

## v2: vendors resell (approved by owner, 5 Nov 2026, migration 008)

A vendor can also be a **reseller / distributor**: it has its own device **stock** and its own **customers**, and sells to customers the same way the admin does. The hospital features (groups, team, temporary access) stay; every vendor has both (one vendor type).

Flow:
```
Admin ──registers + ships──► Vendor stock ──sells──► Customer (vendor's customer)
Admin ──sells──────────────────────────────────────► Customer (direct)
```

1. **Admin adds a vendor in one step:** company name, owner's full name, owner's phone, optional email. Saving creates the vendor AND the owner's invite link (shown once, 7 days). A new owner link can be made later on the vendor page (lost link).
2. **The QR sticker works twice** (`devices.claim_stage`):
   - `factory`: registered by the admin, nobody has it.
   - `vendor_stock`: a vendor member scanned it. It is in the vendor's stock; **the claim code is kept**.
   - `owned`: a customer scanned the SAME sticker. The customer is the owner, the device stays "sold by" the vendor (`vendor_id` kept), the claim code is cleared.
   - A non-vendor scanning a factory sticker becomes the owner directly, as before.
   - A member scanning their own vendor's stock gets "already in your stock" (`ALREADY_IN_STOCK`); another vendor gets `ALREADY_CLAIMED`.
   - Nights and alerts recorded while the device was in stock (demos) are deleted when a customer claims it.
3. **A vendor's customer is a full owner:** shares with family, removes the device, like a direct customer. Removing it (or an admin unclaim) sends it back to `factory` and drops the vendor link; the admin issues a new sticker code before it can be claimed again.
4. ~~No privacy limit~~ replaced by v2.1 below.
5. **Vendor screens:** Stock & devices, Customers, Groups, Team, Access (details in v2.1).
6. **Admin vendor page:** stock counts, devices with stage and customer, the vendor's customers.
7. The admin can reprint the sticker while the device is in vendor stock; a new claim code (8.6) also works then (the old sticker stops working).

## v2.1: clean vendor usage (approved by owner, 5 Nov 2026, migration 009)

Registering is only "this is my stock". After that the vendor either **sells** the sensor or **uses** it itself (hospital ward, home).

| Stage | How it gets there | QR sticker | What the vendor team sees | Data saved |
|---|---|---|---|---|
| `vendor_stock` (In stock) | Vendor scans the QR and confirms. No name, room or time zone asked. | Works (a customer can buy it) | Online/offline, live values and connection (to test it) | **Nothing**: no sessions, no history, no alerts |
| `vendor_use` (In use) | "Use here" (name, room, time zone, town, optional group), or putting a stock sensor in a group | **Locked** | Everything except sharing; temporary access allowed | Yes |
| `owned` (Sold) | A customer scans the sticker of a stock sensor | Cleared | **Nothing**: only a record (customer, phone, date) | Yes, for the customer only |

Rules:
- **Back to stock** (in use → stock): sleep history, alerts and temporary access are **deleted** (clean start for the next user), name and group cleared, the QR works again.
- **Sale:** anything from before the sale is deleted; the vendor's temporary access on that sensor ends; the vendor team loses access at once. The customer's claim screen says "Sold by <vendor>. <vendor> keeps only a record of the sale and can't see your data."
- **Groups** hold in-use sensors only. "No group" keeps a sensor in use; "Back to stock" is its own action.
- **Claim for myself** (a member's own account, not the vendor) stays possible under "More" on the add screen.
- Returns (a customer giving a sensor back to the vendor): not decided yet. Today the customer removes it or the admin unclaims it, and it goes back to `factory`.
- Every step is in `audit_log` (`vendor.device.use`, `vendor.device.stock`, `vendor.device.group`, `device.claim`).

## Not now
- fall detection
- per-group staff restriction
- group dashboards

## Global rule
Never show the sensor model name ("C1001" / "DFRobot") in the UI, API responses or docs shown to users. Write "Sensor" instead.
