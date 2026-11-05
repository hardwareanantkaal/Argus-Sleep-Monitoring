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
6. Customers of a vendor **cannot share** devices. Only the vendor (and its team) grants access.
7. Vendors see the **firmware version** only: no upload, no OTA.
8. Vendors see live data, history and alerts of their devices.

## Privacy
When temporary access ends, the customer loses the device. The device's history stays with the vendor.

## Not now
- fall detection
- per-group staff restriction
- group dashboards

## Global rule
Never show the sensor model name ("C1001" / "DFRobot") in the UI, API responses or docs shown to users. Write "Sensor" instead.
