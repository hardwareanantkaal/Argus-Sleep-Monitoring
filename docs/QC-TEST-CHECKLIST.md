# Argus: QC test checklist

- **Site:** https://argus.ecobridgers.com
- **Status:** as of 4 Nov 2026
- **Test data only.** Use test phone numbers and test device names. Logins are shared through a separate safe channel, never by email.

## What is live and what is sample data

The app runs in **mixed mode** while the backend is finished area by area. Screens marked **Sample** show built-in demo data and a "Sample data" badge. Nothing typed into them is saved.

| Area | State |
|---|---|
| Login, sign-up, logout, password reset link | **Live** |
| My devices, device detail, live view, add device (QR / code), rename, remove | **Live** |
| Sleep history, night detail | **Live** (empty until a device uploads a session) |
| Admin: dashboard, devices list and detail, register device (USB / MAC / CSV), QR sticker | **Live** |
| Device sensor settings, admin device commands / logs / events | **Live after the next deploy** |
| Firmware & OTA | **Sample.** The real OTA screen goes live before the Friday demo. |
| Customers, team & roles, audit log, sharing (family), alerts list, sleep rules | **Sample** |

## Test cases

| # | Flow | Steps | Expected result |
|---|---|---|---|
| 1 | Login | Log in with the test customer account | Lands on My devices; refreshing the page keeps you logged in |
| 2 | Wrong password | Enter a wrong password 6 times | Error message; after 5 failures, a "try again later" message |
| 3 | Logout | Log out, then press Back | Login page; no data visible |
| 4 | My devices | Open My devices | Test device ARG-26A0001 is listed, with online/offline status |
| 5 | Device detail | Open the device | Name, room, time zone, town, last seen. If online: live heart rate, breath rate and presence update every few seconds |
| 6 | Sleep history, empty | Open History with a device that has no nights | "No nights yet" style empty state, **not** "Device not found" |
| 7 | Rename | Device settings → change the name → save | The new name appears in the list |
| 8 | Admin dashboard | Log in with the test admin account → Admin | Device and customer counts match the real data |
| 9 | Admin devices | Admin → Devices → search "ARG-26A0001" | Device found; detail shows the MAC, chip, firmware and owner |
| 10 | Register (typed MAC) | Admin → Register → enter a test MAC like `02:00:00:00:00:01` | New serial ARG-26A000N, plus a QR sticker with a typed code |
| 11 | Claim | With the customer login → Add device → type the sticker code | Device added to My devices; using the same code again fails |
| 12 | Wrong claim code | Type a random code | "Code not valid"; after 5 tries, a "try again later" message |
| 13 | Mobile layout | Open the site on a phone | Bottom tabs, readable screens, no sideways scrolling |
| 14 | Access control | Customer login: open an /admin URL | "No access" |

**Please don't test yet:** OTA updates, sharing and invites, the team, and alerts (they're still sample data). These are tested after the next deploys.

## How to report

Send the test case number, the account used (customer or admin), the browser and device, what you expected, what happened, and a screenshot.
