# Device data: draft v0.1 (for owner review)

This is the data the Argus device (ESP32 + DFRobot C1001, sleep mode) sends, and what we store.

- **Status:** DRAFT. The owner will confirm it on real hardware, then it feeds `DESIGN.md`, `schema.sql` and the MQTT section of `API.md`.
- **Source:** the official `DFRobot_HumanDetection` library header (sleep mode `eSleepMode = 0x02`).
- **Unconfirmed values:** anything marked ⚠ must be checked on the real sensor (units, codes or ranges the header doesn't document).
- **Naming (per API.md v1.0):**
  - Topic prefix `<p>` = `argus`
  - `<d>` = MAC as 12 lowercase hex characters
  - QR payload `ARG1:<12-char code>`
- **Source of truth:** `docs/API.md` wins wherever it differs from this draft.
- **MQTT login:**
  - username = clientId = MAC (12 lowercase hex characters).
  - The password is ignored, but it **must not be empty**: the broker (go-auth) refuses empty passwords before the check runs. Send any dummy string, e.g. `"x"`.

---

## 1. What the C1001 gives us (sleep mode)

| Library call | Values |
|---|---|
| `smHumanData()` | presence, movement, movement range (0–100), distance |
| `getHeartRate()` | heart rate (bpm) |
| `getBreatheValue()` | breath rate (per min) |
| `getBreatheState()` | 1 normal, 2 too fast, 3 too slow, 4 none |
| `smSleepData()` | in/out of bed, sleep state, abnormal struggle, unattended state, sleep deadline |
| `getSleepComposite()` | presence, sleepState, avg respiration, avg heartbeat, turnovers, large-move %, minor-move %, apnea events |
| `getSleepStatistics()` | quality score, sleep time (min), wake duration, light %, deep %, time out of bed, exit count, turnover count, avg respiration, avg heartbeat, apnea events |

**Things the C1001 does NOT give:**
- **No REM stage.** It reports only deep, light and awake, so the UI shows 3 stages.
- **No min/max heart rate or breath rate.** The firmware will track these itself during the session.

---

## 2. Live values: `<p>/<d>/state` (device → server, QoS 0, not stored)

These go to the screen only, through Socket.IO. They are never stored in the database.

**When to send:**
- Every **5 s** while someone is in bed.
- Every **60 s** while the bed is empty (keeps the device "online").
- Immediately when presence, bed or sleep state changes.

```json
{"pr":1,"bed":1,"ss":1,"hr":62,"br":14,"bs":1,"mv":1,"mr":12,"dist":85,"rssi":-61,"up":36012,"fw":"1.0.0"}
```

| Key | Meaning | Type / range |
|---|---|---|
| `pr` | presence | 0 no, 1 yes |
| `bed` | in bed | 0 out, 1 in |
| `ss` | sleep state | 0 deep, 1 light, 2 awake, 3 none ⚠ check the sensor's codes |
| `hr` | heart rate | bpm, 0 = no reading |
| `br` | breath rate | per min, 0 = no reading |
| `bs` | breath state | 1 normal, 2 fast, 3 slow, 4 none |
| `mv` | movement | 0 none, 1 still, 2 active ⚠ |
| `mr` | movement range | 0–100 |
| `dist` | distance to person | cm ⚠ |
| `rssi` | Wi-Fi signal | dBm |
| `up` | uptime | s |
| `fw` | firmware version | string |

Size is about 120 bytes. At 5 s that's tiny for MQTT.

---

## 3. Events: `<p>/<d>/event` (device → server, QoS 1, stored in `device_events`)

```json
{"t":"bed_in","ts":1762200000}
```

| `t` | When |
|---|---|
| `bed_in` | Session started |
| `bed_out` | Session ended, sent only after the **5 min bed-exit timeout** |
| `struggle` | C1001 abnormal struggle (if enabled) |
| `unattended` | C1001 unattended state (if enabled) |
| `reboot` | Boot, with reset reason |
| `config_mode` | Entered the WiFiManager portal |

`ts` is Unix time in UTC. The device must sync NTP before it starts sessions.

---

## 3a. Device info: `<p>/<d>/info` (device → server, QoS 1, **retained**, sent on every connect)

Added per API.md v1.0 decision A3.

```json
{"fw":"1.0.0","ip":"192.168.1.42","ssid":"HomeWiFi","chip":"ESP32-S3","radar":"C1001 v?","rst":"poweron"}
```

| Key | Meaning |
|---|---|
| `fw` | Firmware version |
| `ip` / `ssid` | Local IP and the Wi-Fi network name |
| `chip` | Chip model (e.g. ESP32 / ESP32-S3) |
| `radar` | Radar module and version ⚠ (what the C1001 reports) |
| `rst` | Last reset reason (`esp_reset_reason()`) |

## 3b. Logs: `<p>/<d>/logs` (device → server, QoS 1, reply to the `logs` command)

- The device sends its recent log buffer in **chunks of at most 3 KB**, because the broker's message limit is 4 KB.
- The exact chunk fields (`id`, part number, total, text) are defined in `docs/API.md`.

---

## 4. Nightly summary: `<p>/<d>/session` (device → server, QoS 1, **stored**)

This is the **only sleep data we store**. One message per session (bed entry → bed exit).

```json
{
  "sid": 128,
  "start": 1762200000,
  "end": 1762228800,
  "score": 82,
  "sleep_min": 432,
  "wake_min": 18,
  "light_pct": 58,
  "deep_pct": 34,
  "oob_min": 9,
  "exits": 1,
  "turns": 14,
  "big_mv_pct": 6,
  "small_mv_pct": 21,
  "apnea": 0,
  "hr_avg": 61, "hr_min": 52, "hr_max": 78,
  "br_avg": 14, "br_min": 11, "br_max": 19,
  "struggles": 0,
  "hyp": "AALLLDDDLLDDDLLALL...",
  "epoch_s": 300,
  "fw": "1.0.0"
}
```

| Key | Meaning | From |
|---|---|---|
| `sid` | Device session counter, increments every session | firmware |
| `start` / `end` | Bed in / bed out (Unix UTC) | firmware |
| `score` | Sleep quality score | C1001 stats ⚠ range (0–100?) |
| `sleep_min` | Total sleep time | C1001 stats |
| `wake_min` | Awake time in bed | C1001 stats ⚠ unit |
| `light_pct` / `deep_pct` | Light / deep sleep % | C1001 stats |
| `oob_min` | Time out of bed during the session | C1001 stats ⚠ unit |
| `exits` | Bed exits | C1001 stats |
| `turns` | Turnovers | C1001 stats |
| `big_mv_pct` / `small_mv_pct` | Large / minor body movement % | C1001 composite |
| `apnea` | Apnea events | C1001 stats |
| `hr_avg` / `br_avg` | Average heart / breath rate | C1001 stats |
| `hr_min` / `hr_max` / `br_min` / `br_max` | Min / max over the session | **firmware tracks** |
| `struggles` | Abnormal struggle count | firmware counts events |
| `epoch_s` | Length of one hypnogram character in seconds: 300 (default if missing) or 60 | firmware |
| `hyp` | **Hypnogram**: one character per `epoch_s` (5 min by default) (`D` deep, `L` light, `A` awake, `O` out of bed) | firmware samples `ss` |
| `fw` | Firmware version that produced it | firmware |

**Why the hypnogram (`hyp`):** it draws the sleep-stage timeline on the night detail screen. An 8 h night is only 96 characters, so it's still a summary and not raw data. The whole message is under 1 KB, well inside the broker's 4 KB limit.

**Reliability (store and forward):**
1. At session end the firmware saves the summary to flash first, then publishes it.
2. The server replies on `<p>/<d>/session/ack` with `{"sid":128}`. Only then does the firmware delete the summary from flash.
3. If Wi-Fi is down, summaries queue in flash (keep the last ~30) and send on reconnect.
4. The server ignores a duplicate `sid`, the same idea as re-acking a settings version.

---

## 5. Device settings: `<p>/<d>/settings/set` (retained, versioned, same as the water project)

```json
{"v":3,"exit_s":300,"live_s":2,"idle_s":60,"struggle":1,"unattended":0,"unatt_min":30,"min_sess":25}
```

| Key | Meaning | Default |
|---|---|---|
| `exit_s` | Bed-exit timeout: an exit shorter than this keeps the session going | 300 (5 min) |
| `live_s` | Live state rate while in bed | 5 |
| `idle_s` | Live state rate while the bed is empty | 60 |
| `struggle` | C1001 abnormal struggle detection on/off | 1 |
| `unattended` | C1001 unattended detection on/off | 0 |
| `unatt_min` | Unattended time | 30 ⚠ check the C1001 range |
| `min_sess` | Discard a session shorter than this many minutes (don't publish it). From the server's Sleep rules (`min_session_min`); changing it there re-sends settings to every device. | 25 |

The device acks with `{"v":3}` after saving to flash.

---

## 6. Server-side rules (from approved decisions)

- **Store every session raw.** Sessions shorter than 25 min are hidden from history and trends (stored flagged, not deleted).
- **Merge into a night:** sessions less than 30 min apart become one night (admin setting).
- **Sleep date:** noon cut-off in the **device timezone** (configurable per device).
- **Main sleep vs nap:** the longest group on a date is the main sleep; the rest are naps.
- **Night totals:** sums of the sessions. HR/BR averages are weighted by duration. Min/max are taken across the night's sessions.

---

## 7. Questions for the owner

1. **Hardware check:** the ⚠ items (sleep-state codes, units of wake and out-of-bed time, score range). Can you print `getSleepStatistics()` once on a real board?
2. **When does the C1001 produce its statistics?** Does the sensor only give `getSleepStatistics()` at sleep end (its "sleep deadline"), or can the firmware read it any time? This decides whether the firmware calculates the summary itself or reads it from the sensor.
3. **Live rate:** is 5 s OK, or faster (1–2 s) for a smoother live heart-rate graph?
4. **Hypnogram:** is one character per 5 min OK, or 1 min (480 characters for 8 h, still small)?
5. **Struggle / unattended:** should these events trigger alerts? The owner kept the Alerts screen for v1 (3 Nov), so they could become alert types along with device offline.


## OTA status `deferred` (added 5 Nov 2026)

While a sleep session is active the firmware does not install an update. It answers the `ota` message with
`argus/<d>/ota/status {"rid":7,"s":"deferred","err":"sleep session active"}` and does nothing else. The server
keeps the update as `deferred` (not failed) and offers it again every 60 s while the device is online, so it
installs after the person gets up (still only inside the rollout's install window).
