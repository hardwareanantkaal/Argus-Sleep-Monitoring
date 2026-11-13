# Manufacturing station: how to use it

The station is the part of the web app where the factory team **flashes**, **tests** and **registers** new boards. It runs in Chrome or Edge on the bench PC. The browser talks to the board over USB (Web Serial + `esptool-js`); the server only stores the firmware files and each board's result.

API: [API.md §9b](API.md) · Database: migration `010_manufacturing.sql`.

---

## 1. Admin: upload a firmware with its factory image

Go to **Firmware**, card **Upload a build**.

| Chip | Files to pick | From the Arduino build folder |
|---|---|---|
| ESP32 / S3 / C3 | **2 files**: Firmware (OTA) and Factory image | `sleeplamp.ino.bin` and `sleeplamp.ino.merged.bin` |
| ESP8266 | **1 file** | `sleeplamp.ino.bin` (it already contains the bootloader) |

In Arduino IDE use *Sketch → Export Compiled Binary* (or look in `build/esp32.esp32.esp32/`). The version you type must equal `FW_VERSION` in `config.h`, and pick the right **Chip**.

The server checks the files before it saves them:
- Both start like ESP images (byte `0xE9`).
- The bootloader is at the right place for the chip (`0x1000` on ESP32, `0x0` on S3/C3).
- **The app inside the merged image is byte-for-byte the OTA `.bin`**, so a factory image can't be mixed up with another version.

Then press **Make default** in the *Factory image* column. The station picks that release for every board with that chip. An older release without a factory image gets an **Add** button.

Upload limit through Nginx is 8 MB per request: fine for 4 MB-flash boards (1.3 MB + 4 MB). For 8 or 16 MB flash, raise `client_max_body_size` in `deploy/nginx/gateway.conf` and `host-argus.conf`.

## 2. Factory team: the station, step by step

Menu **Station** (Manufacturing role). Close Arduino IDE and any serial monitor first.

1. **Connect.** Plug the board in, press **Connect board** and pick the COM port. The station reads the chip and MAC and shows whether the board is new, was tested before, or is already registered. Type the bench name once (e.g. "Bench 2"); the PC remembers it.
2. **Flash.** The default release is selected. Press **Erase and flash**. The image downloads once per release (sha256 checked) and is written from `0x0`, which also erases old Wi-Fi settings and data. An ESP32 4 MB image takes about 30–60 s. If the board already has the right firmware, **Skip, test only** goes straight to testing.
3. **Test.** The board is reset and the serial monitor opens at 115200 baud. The checks tick by themselves from the firmware's own prints:

   | Check | Pass when | Limit |
   |---|---|---|
   | Boots | `===== … vX.Y.Z booting` appears | 10 s |
   | Firmware version | that version = the flashed release | — |
   | Device ID | `[Argus] deviceId:` = the MAC read over USB | 15 s |
   | Free memory | `heap:` in the telemetry ≥ 40 000 | 25 s |
   | Radar link | `[RADAR] link up` or `radar:OK` | 60 s |
   | Presence | press **Start**, then sit or wave; `presence:1` appears | 30 s (can be skipped) |

   A crash line (`Guru Meditation`, `Backtrace:`, brownout) fails the board. **Pass** unlocks when every check is green; **Fail** and **Abort** are always there. The last 16 KB of serial output is saved with the result. Unplugging the board during a test saves it as **aborted**.
4. **Register.** After a pass: choose the hardware model and batch, press **Register and make sticker**. You get the serial, the claim code (shown only once) and the QR; **Print sticker** prints only the label. Then **Next board**.

The **Factory log** shows every board: counts per day and per person, the failure reasons, and each board's checks and serial log.

## 3. Who can do what

| Permission | Unlocks | Owner | Developer | Manufacturing | Support |
|---|---|---|---|---|---|
| `factory.flash` | Flash on the station | ✓ | ✓ | ✓ | |
| `factory.monitor` | Station: serial monitor + checks | ✓ | ✓ | ✓ | |
| `devices.register` | Register + sticker | ✓ | ✓ | ✓ | |
| `firmware.upload` | Upload, factory image, Make default | ✓ | ✓ | | |
| `devices.view` | Factory log | ✓ | ✓ | ✓ | ✓ |

Change these on **Team**.

## 4. Tests

```bash
cd backend && npm test               # needs the dev stack (docker compose up -d); test/factory.test.js covers this feature
cd web && npm test                   # bench checks, no browser or board needed
```

## 5. Not done yet / known limits

- **Flashing and the serial monitor have not been tried on a real board yet.** If a cheap USB cable fails at high speed, lower `baudrate` in `web/src/lib/serial.ts` from 921600 to 460800.
- The serial format is still provisional until D8.
- The Factory log reloads when you change a filter (no live socket event yet).
