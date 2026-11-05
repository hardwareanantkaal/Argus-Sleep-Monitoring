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
(v2: for sold devices the vendor team still sees everything, owner decision "no privacy limit for now".)

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
4. **Data visibility: no privacy limit for now.** Vendor members keep live, history, alerts and settings on sold devices. `sharing.manage` stays owner-only. The customer is told on the claim screen that the vendor's team can see the sensor.
5. **Vendor screens:** Stock & devices (counts: all / in stock / sold / customers, filter In stock / Sold, customer on each sold device), Customers (each customer with the devices they bought), Groups, Team, Access. Temporary access works on stock and sold devices.
6. **Admin vendor page:** stock counts, devices with stage and customer, the vendor's customers.
7. The admin can reprint the sticker while the device is in vendor stock; a new claim code (8.6) also works then (the old sticker stops working).

## Not now
- fall detection
- per-group staff restriction
- group dashboards

## Global rule
Never show the sensor model name ("C1001" / "DFRobot") in the UI, API responses or docs shown to users. Write "Sensor" instead.
