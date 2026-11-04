// Argus Sleep Monitoring · config.h — all settings + pin map (plain ESP32, arduino-esp32 core 3.x)
// Sensor-only build: C1001 radar + WiFi + MQTT (docs/API.md §11, docs/DEVICE-DATA.md).
// No secrets live here: the device logs in to the broker with its MAC only.
#pragma once

#define DEVICE_BRAND     "Argus Sleep Monitoring"
// deviceId() (Mqtt.ino) is the WiFi MAC as 12 lowercase hex chars — it is the
// MQTT username, client id and the <d> part of every topic.

// ---------------- WiFi / network ----------------
// The device keeps a LIST of saved networks in NVS (see APMODE below), added
// from the /wifi setup page's scan-and-pick flow. Nothing to edit here for WiFi.
#define WIFI_HOSTNAME  "argus"

// ---------------- APMODE: multi-network WiFi list ----------------
// When no saved network is reachable (or after 5 quick power-cycles, or the
// `config_mode` command), the device opens this setup hotspot with a /wifi page.
#define APMODE_SSID       "Argus-Setup"
#define APMODE_PASS       "12345678"
#define APMODE_MAX_NETS   5        // how many saved SSID/password pairs to keep
#define RESET_TAPS        5        // power-cycles within RESET_TAP_WINDOW_MS -> setup hotspot
#define RESET_TAP_WINDOW_MS 10000

// ---------------- MQTT broker ----------------
// DEV  : plain MQTT to the PC running the Docker stack (port 1885, see docker-compose.yml)
// PROD : TLS on 8883 to the VPS domain, e.g. "mqtts://mqtt.example.com:8883"
//        (the server cert is checked against the ESP-IDF root bundle).
#define MQTT_URI          "mqtts://argus.ecobridgers.com:8884"   // Contabo prod (8883 = Water Tank)
#define MQTT_PREFIX       "argus"          // <p> in docs/API.md
#define MQTT_DUMMY_PASS   "x"              // broker ignores it (MAC-only login), must be non-empty
#define MQTT_KEEPALIVE_S  60
#define SESSION_RESEND_MS 60000UL          // re-publish un-acked sessions this often
#define SESSION_QUEUE_MAX 30               // keep at most this many un-acked sessions in flash

// ---------------- time sync (NTP) ----------------
// Timestamps sent to the server are always Unix UTC. The offset below is only
// used for the local serial printout.
#define TZ_OFFSET_SEC   19800      // India = GMT+5:30
#define DST_OFFSET_SEC  0
#define NTP_SERVER      "pool.ntp.org"

// ---------------- OTA (server pushes {url, sha256, size} on <p>/<d>/ota) ----------------
#define OTA_STALL_MS     20000UL   // abort if download stalls this long

// ---------------- C1001 radar (UART) ----------------
#define RADAR_RX   16              // ESP32 RX2 <- C1001 TX
#define RADAR_TX   17              // ESP32 TX2 -> C1001 RX

// ---------------- sleep engine (on-device staging) ----------------
// The bed-exit timeout is NOT here any more: it comes from the server setting
// `exit_s` (default 300 s), see DevSettings in types.h.
#define SLEEP_EPOCH_SEC   60   // one staging decision per minute
#define ONSET_QUIET_EP     3   // quiet minutes in bed -> counted as asleep
#define DEEP_AFTER_EP     10   // very-quiet asleep minutes -> deep sleep
#define QUIET_RANGE        8   // mean movement <= this = quiet minute
#define WAKE_RANGE        14   // mean movement >= this while asleep = awakening
#define BURST_RANGE       30   // single-sample movement spike
#define AUTO_SAVE_MIN     15   // sessions shorter than this (in bed) are discarded
#define HYP_BLOCK_MIN      5   // hypnogram: one character per 5 minutes

// ---------------- misc ----------------
#define FW_VERSION      "2.0.0"   // first MQTT build (Firebase removed)
#define SERIAL_PRINT_MS 2000
#define LOG_RING_BYTES  8192      // recent log kept in RAM for the `logs` command
