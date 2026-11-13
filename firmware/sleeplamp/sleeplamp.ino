/**
 * Argus Sleep Monitoring — contactless sleep sensor node  | arduino-esp32 core 3.1+
 * Plain ESP32 + C1001 mmWave radar ONLY. MQTT (Mqtt.ino) is the only data path.
 *
 *  Architecture (deliberate):
 *   - setup() brings up WiFi FIRST. The radar is initialised inside
 *     sensorTask (core 0) with retries — a dead/booting radar can NEVER block
 *     WiFi/MQTT. radarOk reports link health live.
 *   - sensorTask owns the UART exclusively (init, recovery, recalibration),
 *     runs the sleep engine and hands finished sessions/events to Mqtt.ino.
 *   - loop() (core 1) runs MQTT: live state, info, events, session queue,
 *     commands, settings and OTA.
 *   - WiFi: a saved LIST of networks is tried in order; if none connect, or
 *     after 5 quick power-cycles, or on the `config_mode` command, the AP
 *     setup hotspot comes up with a scan-and-pick /wifi page (Provision.ino).
 *
 *  deviceId = WiFi MAC (12 lowercase hex) = MQTT username + client id.
 *
 *  Libraries: ArduinoJson 7. MQTT = ESP-IDF esp-mqtt (built into the core).
 *  Board: ESP32 Dev Module. Partition: "Minimal SPIFFS (1.9MB APP with OTA)"
 *  — "Default" is 97% full with this build. LittleFS uses the spiffs part.
 *  The partition table only changes over USB, never by OTA.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include "config.h"
#include "types.h"

DNSServer dnsServer;   // captive portal: redirects every DNS query to us while in AP mode

// ---- global definitions (declared extern in types.h) ----
SensorData              g;
WebServer               server(80);   // /wifi setup + captive portal + OTA ONLY
ShubhSensor             hu(&Serial1);
SemaphoreHandle_t       mux;
volatile bool           g_sensorReset = false;
volatile bool           g_recalDone = false;
volatile bool           radarOk = false;
volatile bool           g_configMode = false;
volatile bool           g_endSession = false;
TeeLog                  LOG;
SleepLive               live;
SessSample              sessBuf[SESS_MAX];
int                     sessN = 0, sessStart = 0;

// while in AP setup mode, any unknown URL redirects to the config page
// (captive portal behaviour) instead of a 404. Outside AP mode this server
// only exists for a future /wifi visit, so a plain 404 is fine.
void handleCaptiveNotFound() {
  if (WiFi.getMode() & WIFI_MODE_AP) {
    server.sendHeader("Location", "/wifi", true);
    server.send(302, "text/plain", "");
  } else {
    server.send(404, "text/plain", "Not found");
  }
}

static void printTelemetry() {
  SensorData d; SleepLive lv;
  xSemaphoreTake(mux, portMAX_DELAY);
  d=g; lv=live;
  xSemaphoreGive(mux);
  const char* kState[] = {"Deep","Light","Awake","None"};
  const char* kMot[]   = {"None","Still","Active"};
  // plain Serial on purpose: this 2 s printout would flush the `logs` ring
  Serial.println("------------------------------------------------");
  Serial.printf("radar:%s  presence:%d  bed:%s  radarState:%s  motion:%s  range:%d\n",
                radarOk?"OK":"DOWN", d.presence, d.inBed?"in":"out",
                kState[d.sleepState&3], kMot[d.motion>2?0:d.motion], d.movingRange);
  Serial.printf("HR:%d bpm  resp:%d rpm  breathState:%d\n",
                d.heartRate, d.breathRate, d.breathState);
  Serial.printf("SLEEP[engine] %s  stage:%s  bed:%dm asleep:%dm (deep %d/light %d/awake %d)\n",
                lv.active?"SESSION":"idle", kState[lv.stage&3],
                lv.bedMin, lv.sleepMin, lv.deepMin, lv.lightMin, lv.awakeMin);
  Serial.printf("SLEEP[engine] onset:%dm  wakes:%d  turns:%d  liveScore:%d   mqtt:%s  heap:%lu\n",
                lv.onsetMin, lv.wakes, lv.turns, lv.score,
                mqttConnected()?"up":"down", (unsigned long)ESP.getFreeHeap());
}

void setup() {
  Serial.begin(115200);
  delay(300);
  LOG.printf("\n===== " DEVICE_BRAND " v" FW_VERSION " booting (partition %s) =====\n",
             esp_ota_get_running_partition()->label);

  // 5 quick power-cycles -> setup hotspot (counter cleared after 10 s uptime in loop)
  Preferences bp; bp.begin("boot", false);
  int taps = bp.getInt("taps", 0) + 1;
  bp.putInt("taps", taps >= RESET_TAPS ? 0 : taps);
  bp.end();
  if (taps >= RESET_TAPS) { LOG.println("[Boot] 5x reset -> setup hotspot"); g_configMode = true; }

  settingsLoad();
  mqttInit();
  mux = xSemaphoreCreateMutex();

  // Radar UART: big RX buffer so proactive radar frames never overflow while
  // we're busy handling WiFi/MQTT. Init itself happens inside sensorTask.
  Serial1.setRxBufferSize(1024);
  Serial1.begin(115200, SERIAL_8N1, RADAR_RX, RADAR_TX);
  LOG.println("[RADAR] init runs in background (radar needs ~10-15 s after power-on)");

  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.setHostname(WIFI_HOSTNAME);
  WiFi.setAutoReconnect(true);
  LOG.printf("[Argus] deviceId: %s\n", deviceId().c_str());

  // APMODE network list: try every saved SSID/password (strongest signal
  // first) before giving up and opening the setup hotspot.
  if (!wifiConnectAny(15000)) {
    WiFi.mode(WIFI_AP); WiFi.softAP(APMODE_SSID, APMODE_PASS);
    dnsServer.start(53, "*", WiFi.softAPIP());   // captive portal: any domain -> us
    LOG.printf("[WiFi] no saved network reachable — AP fallback \"%s\" IP: %s\n",
                  APMODE_SSID, WiFi.softAPIP().toString().c_str());
    LOG.println("[WiFi] join the hotspot — setup page opens automatically (captive portal)");
  } else {
    timeBegin();           // NTP sync: sessions/events carry Unix UTC
    mqttBegin();
  }

  // /wifi setup portal + OTA firmware update — the only local web surface left
  server.on("/wifi",   HTTP_GET,  handleWifiPage);
  server.on("/wifi",   HTTP_POST, handleWifiSave);
  server.on("/update", HTTP_GET,  handleUpdatePage);
  server.on("/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
  server.on("/api/reset", handleFactoryReset);
  // captive-portal probe URLs (phones/laptops hit these to detect a portal
  // and auto-pop the browser) — all answered with the setup page
  server.on("/generate_204",      handleWifiPage);  // Android
  server.on("/gen_204",           handleWifiPage);  // Android
  server.on("/hotspot-detect.html", handleWifiPage); // Apple
  server.on("/library/test/success.html", handleWifiPage); // Apple
  server.on("/ncsi.txt",          handleWifiPage);  // Windows
  server.on("/connecttest.txt",   handleWifiPage);  // Windows
  server.onNotFound(handleCaptiveNotFound);         // any other URL while in AP mode
  server.begin();
  LOG.println("[HTTP] /wifi setup portal up");

  xTaskCreatePinnedToCore(sensorTask, "radar", 8192, nullptr, 2, nullptr, 0);
  LOG.println("[TASKS] radar(core0) started");
}

void loop() {
  if (WiFi.getMode() & WIFI_MODE_AP) dnsServer.processNextRequest();  // captive portal DNS
  server.handleClient();
  static uint32_t tPrint = 0, tWifi = 0;
  uint32_t now = millis();

  // ---- config mode trigger: forces the AP setup hotspot on demand ----
  // Set by the `config_mode` MQTT command or 5 quick power-cycles: re-opens
  // /wifi + /update even while the
  // device is already happily connected to home WiFi — useful for changing
  // WiFi networks or flashing new firmware without needing to break the
  // existing connection first.
  if (g_configMode) {
    g_configMode = false;
    if (!(WiFi.getMode() & WIFI_MODE_AP)) {
      WiFi.mode(WIFI_AP_STA);           // AP_STA so MQTT keeps running
      eventPush("config_mode");
      WiFi.softAP(APMODE_SSID, APMODE_PASS);
      dnsServer.start(53, "*", WiFi.softAPIP());
      LOG.printf("[Config] forced AP setup mode — hotspot \"%s\" IP: %s\n",
                    APMODE_SSID, WiFi.softAPIP().toString().c_str());
      LOG.println("[Config] /wifi (change network) and /update (OTA) are live");
    } else {
      LOG.println("[Config] already in AP setup mode");
    }
  }

  if (now - tPrint > SERIAL_PRINT_MS) { tPrint = now; printTelemetry(); }

  static bool tapsCleared = false;
  if (!tapsCleared && now > RESET_TAP_WINDOW_MS) {        // a normal boot: forget the taps
    tapsCleared = true;
    Preferences bp; bp.begin("boot", false); bp.putInt("taps", 0); bp.end();
  }

  mqttLoop();   // no-op until WiFi has connected once
  otaLoop();

  if (now - tWifi > 10000) {                      // auto-recover dropped WiFi
    tWifi = now;
    if (WiFi.getMode() == WIFI_STA && WiFi.status() != WL_CONNECTED) {
      LOG.println("[WiFi] reconnecting...");
      WiFi.reconnect();
    }
  }
  // AP fallback: keep the setup hotspot up, but quietly retry home WiFi every
  // 5 min — a router that was down at boot no longer strands the device in AP
  // mode until someone power-cycles it. This auto-close only applies to the
  // NO-WIFI fallback case (pure WIFI_AP) — a deliberately forced config mode
  // (WIFI_AP_STA, already connected, see g_configMode above) stays open until
  // you leave /wifi's "Save & Reboot" or /update, so triggering config mode
  // while already on home WiFi doesn't snap shut instantly.
  static uint32_t tSta = 0;
  if (WiFi.getMode() == WIFI_AP) {
    if (WiFi.status() == WL_CONNECTED) {
      LOG.printf("[WiFi] home WiFi joined, IP %s — closing setup hotspot\n",
                    WiFi.localIP().toString().c_str());
      dnsServer.stop();
      WiFi.mode(WIFI_STA);
      timeBegin();
      mqttBegin();
    } else if (now - tSta > 300000UL) {
      tSta = now;
      LOG.println("[WiFi] AP mode: retrying saved networks in background");
      WiFi.mode(WIFI_AP_STA);
      wifiConnectAny(6000);
    }
  }
  delay(1);
}
