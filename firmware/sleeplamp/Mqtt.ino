// Argus Sleep Monitoring · Mqtt.ino — the device <-> server data path.
// Replaces Firebase.ino. Contract: docs/API.md §11 + docs/DEVICE-DATA.md.
//
// Uses ESP-IDF's built-in MQTT client (esp-mqtt, ships with arduino-esp32 3.x):
// QoS 1 publish, last will, TLS with the IDF root bundle, auto-reconnect.
// It runs its own task, so its event callback only COPIES incoming messages
// into a queue; loop() (core 1) does all the real work.
//
//   device -> server                     server -> device
//   <p>/<d>/status   "online"/"offline"   <p>/<d>/cmd           {"id","c"}
//   <p>/<d>/info     identity, retained   <p>/<d>/settings/set  {"v",...} retained
//   <p>/<d>/state    live, QoS 0          <p>/<d>/ota           {"rid","ver","url","sha256","size"}
//   <p>/<d>/event    bed_in, bed_out ...  <p>/<d>/session/ack   {"sid"}
//   <p>/<d>/session  one finished session (kept in flash until acked)
//   <p>/<d>/cmd/ack, logs, settings/ack, ota/status
#include "types.h"
#include "config.h"
#include <time.h>
#include <esp_mac.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "mqtt_client.h"
#include "esp_crt_bundle.h"

static esp_mqtt_client_handle_t cli = nullptr;
static volatile bool connected = false;
static volatile bool justConnected = false;
static bool fsOk = false;

// ---- incoming messages: mqtt task -> loop() ----
struct InMsg { char sub[24]; char data[640]; };
static QueueHandle_t inQ;
// ---- events and sessions: sensor task -> loop() ----
struct EvMsg { char t[12]; uint32_t ts; };
static QueueHandle_t evQ, sessQ;
#define CKPT_FILE "/cur.bin"     // the running session, checkpointed by the sensor task

// ================= identity + time =================
String deviceId() {
  static String id;
  if (!id.length()) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);   // from efuse, works before WiFi is up
    char buf[13];
    snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    id = String(buf);
  }
  return id;
}

void timeBegin() { configTime(TZ_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER); }

uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;   // sane post-2023 time = synced
}

static String topic(const char* sub) { return String(MQTT_PREFIX "/") + deviceId() + "/" + sub; }

bool mqttConnected() { return connected; }

void mqttPublish(const String& sub, const String& payload, int qos, bool retain) {
  if (!cli || !connected) return;
  esp_mqtt_client_publish(cli, topic(sub.c_str()).c_str(), payload.c_str(), payload.length(), qos, retain);
}

// ================= settings (NVS "set") =================
DevSettings g_set;

void settingsLoad() {
  Preferences p; p.begin("set", true);
  g_set.v          = p.getInt("v", 0);
  g_set.exit_s     = p.getInt("exit_s", 300);
  g_set.live_s     = p.getInt("live_s", 2);
  g_set.idle_s     = p.getInt("idle_s", 60);
  g_set.struggle   = p.getInt("struggle", 1);
  g_set.unattended = p.getInt("unatt", 0);
  g_set.unatt_min  = p.getInt("unatt_min", 30);
  g_set.min_sess   = p.getInt("min_sess", AUTO_SAVE_MIN);
  p.end();
}

static void settingsApply(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) { LOG.println("[MQTT] settings: bad JSON"); return; }
  int v = d["v"] | -1;
  if (v < 0) return;
  DevSettings s = g_set;
  s.v          = v;
  s.exit_s     = constrain((int)(d["exit_s"]    | s.exit_s), 60, 3600);
  s.live_s     = constrain((int)(d["live_s"]    | s.live_s), 1, 60);
  s.idle_s     = constrain((int)(d["idle_s"]    | s.idle_s), 10, 300);
  s.struggle   = d["struggle"]   | s.struggle;
  s.unattended = d["unattended"] | s.unattended;
  s.unatt_min  = d["unatt_min"]  | s.unatt_min;
  s.min_sess   = constrain((int)(d["min_sess"] | s.min_sess), 1, 240);
  // TODO(hardware): push struggle/unattended to the C1001 once those config
  // calls are checked on a real board (DEVICE-DATA.md ⚠). Stored only for now.

  Preferences p; p.begin("set", false);
  p.putInt("v", s.v);           p.putInt("exit_s", s.exit_s);
  p.putInt("live_s", s.live_s); p.putInt("idle_s", s.idle_s);
  p.putInt("struggle", s.struggle); p.putInt("unatt", s.unattended);
  p.putInt("unatt_min", s.unatt_min);
  p.putInt("min_sess", s.min_sess);
  p.end();
  g_set = s;
  LOG.printf("[MQTT] settings v%d saved (exit %ds, live %ds, idle %ds, min_sess %d min)\n", s.v, s.exit_s, s.live_s, s.idle_s, s.min_sess);
  mqttPublish("settings/ack", String("{\"v\":") + v + "}", 1, false);   // also re-acks a duplicate v
}

// ================= events =================
void eventPush(const char* type, uint32_t ts) {
  if (!evQ) return;
  EvMsg e; strlcpy(e.t, type, sizeof(e.t)); e.ts = ts ? ts : nowEpoch();
  xQueueSend(evQ, &e, 0);
}

static void eventsDrain() {
  EvMsg e;
  while (connected && xQueuePeek(evQ, &e, 0) == pdTRUE) {
    if (!e.ts) e.ts = nowEpoch();        // queued before NTP synced
    char b[64]; snprintf(b, sizeof(b), "{\"t\":\"%s\",\"ts\":%lu}", e.t, (unsigned long)e.ts);
    mqttPublish("event", b, 1, false);
    xQueueReceive(evQ, &e, 0);
  }
}

// ================= sessions: store in flash, publish, delete on ack =================
void sessionSubmit(const SessionOut& s) {
  if (sessQ && xQueueSend(sessQ, &s, pdMS_TO_TICKS(2000)) != pdTRUE)
    LOG.println("[SESSION] queue full (no NTP time yet?) — session lost");
}

static void sessionQueueTrim() {
  File dir = LittleFS.open("/sq");
  uint32_t ids[64]; int n = 0;
  for (File f = dir.openNextFile(); f && n < 64; f = dir.openNextFile())
    ids[n++] = strtoul(f.name(), nullptr, 10);
  dir.close();
  while (n > SESSION_QUEUE_MAX) {                         // drop the oldest
    int lo = 0; for (int i = 1; i < n; i++) if (ids[i] < ids[lo]) lo = i;
    LittleFS.remove(String("/sq/") + ids[lo] + ".json");
    ids[lo] = ids[--n];
  }
}

static void sessionStore(const SessionOut& s) {
  Preferences p; p.begin("sess", false);
  uint32_t sid = p.getUInt("sid", 0) + 1;
  p.putUInt("sid", sid);
  p.end();

  const NightReport& r = s.r;
  // Only called once NTP is synced (see mqttLoop). If the session ended before
  // the sync, rebuild start/end from the uptime clock (millis) — never send 0.
  uint32_t nowE = nowEpoch(), nowMs = millis();
  uint32_t end   = r.endTs   ? r.endTs   : nowE - (nowMs - r.endMs) / 1000;
  uint32_t start = r.startTs ? r.startTs : nowE - (nowMs - r.startMs) / 1000;
  if (!r.startMs && !r.startTs) start = end - (uint32_t)r.bedMin * 60;
  if (end > nowE) end = nowE;
  if (start >= end) start = end - max(60, r.bedMin * 60);   // backend: end > start
  if (end - start > 86400) start = end - 86400;               // backend: <= 24 h

  JsonDocument d;
  d["sid"] = sid;           d["start"] = start;          d["end"] = end;
  d["score"] = constrain(r.score, 0, 100);     d["sleep_min"] = r.sleepMin;
  d["wake_min"] = max(0, r.awakeMin - r.oobMin);
  d["light_pct"] = r.sleepMin ? r.lightMin * 100 / r.sleepMin : 0;
  d["deep_pct"]  = r.sleepMin ? r.deepMin  * 100 / r.sleepMin : 0;
  d["oob_min"] = r.oobMin;  d["exits"] = r.exits;        d["turns"] = r.turns;
  d["big_mv_pct"] = s.bigMv; d["small_mv_pct"] = s.smallMv;
  d["apnea"] = r.apnea;
  d["hr_avg"] = r.avgHR;    d["hr_min"] = s.hrMin;       d["hr_max"] = s.hrMax;
  d["br_avg"] = r.avgBR;    d["br_min"] = s.brMin;       d["br_max"] = s.brMax;
  d["struggles"] = s.struggles;
  // diagnostics (backend keeps them in sleep_sessions.raw): the radar's movement
  // range while in bed vs the engine's limits (quiet <= QUIET_RANGE, very quiet <= 4)
  d["mr_avg"] = r.mrAvg;    d["mr_min"] = r.mrMin;
  d["quiet_pct"] = r.quietPct; d["vquiet_pct"] = r.vQuietPct; d["bed_off_pct"] = r.bedOffPct;
  d["hyp"] = s.hyp;         d["epoch_s"] = HYP_EPOCH_S;  d["fw"] = FW_VERSION;
  String out; serializeJson(d, out);
  if (out.length() >= 4000) {                               // broker limit 4096
    LOG.printf("[SESSION] #%lu too big (%d B), hypnogram dropped\n", (unsigned long)sid, out.length());
    d["hyp"] = ""; out = ""; serializeJson(d, out);
  }

  if (fsOk) {
    File f = LittleFS.open(String("/sq/") + sid + ".json", "w");
    if (f) { f.print(out); f.close(); }
    sessionQueueTrim();
  }
  LOG.printf("[SESSION] #%lu saved to flash (%d B): %d min asleep, score %d\n",
             (unsigned long)sid, out.length(), r.sleepMin, r.score);
  mqttPublish("session", out, 1, false);
  if (!fsOk) LOG.println("[SESSION] no flash queue — sent once, not kept");
}

static void sessionsResend() {
  if (!fsOk || !connected) return;
  File dir = LittleFS.open("/sq");
  int sent = 0;
  for (File f = dir.openNextFile(); f && sent < 3; f = dir.openNextFile()) {
    String body = f.readString();
    if (body.length()) { mqttPublish("session", body, 1, false); sent++; }
  }
  dir.close();
  if (sent) LOG.printf("[SESSION] re-sent %d un-acked session(s)\n", sent);
}

static void sessionAck(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) return;
  uint32_t sid = d["sid"] | 0;
  if (!sid) return;
  if (fsOk) LittleFS.remove(String("/sq/") + sid + ".json");
  if (!(d["ok"] | 1)) LOG.printf("[SESSION] #%lu rejected by server: %s\n", (unsigned long)sid, (const char*)(d["err"] | "?"));
  else                LOG.printf("[SESSION] #%lu acked, removed from flash\n", (unsigned long)sid);
}

// ================= commands =================
static void cmdAck(long id, bool ok, const char* err = nullptr) {
  String b = String("{\"id\":") + id + ",\"ok\":" + (ok ? 1 : 0);
  if (!ok && err) b += String(",\"err\":\"") + err + "\"";
  b += "}";
  mqttPublish("cmd/ack", b, 1, false);
}

static void sendLogs(long id) {
  String all = LOG.snapshot();
  const int CHUNK = 2600;                               // + JSON escaping stays under 3 KB
  int parts = max(1, (int)((all.length() + CHUNK - 1) / CHUNK));
  for (int i = 0; i < parts; i++) {
    JsonDocument d;
    d["id"] = id; d["part"] = i + 1; d["of"] = parts;
    d["text"] = all.substring(i * CHUNK, min((int)all.length(), (i + 1) * CHUNK));
    String out; serializeJson(d, out);
    mqttPublish("logs", out, 1, false);
    delay(20);
  }
}

static long recalId = 0;          // pending recalibrate command id

static void onCommand(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) return;
  long id = d["id"] | 0L;
  const char* c = d["c"] | "";
  LOG.printf("[MQTT] command #%ld: %s\n", id, c);
  if (!strcmp(c, "reboot")) {
    cmdAck(id, true); delay(300); ESP.restart();
  } else if (!strcmp(c, "config_mode")) {
    cmdAck(id, true); g_configMode = true;
  } else if (!strcmp(c, "ota_check")) {
    // the server re-sends any pending OTA when the device announces itself
    cmdAck(id, true);
    mqttPublish("status", "online", 1, true);
  } else if (!strcmp(c, "recalibrate")) {             // MISSING API (API.md §11a)
    recalId = id; g_recalDone = false; g_sensorReset = true;  // acked in mqttLoop when done
  } else if (!strcmp(c, "logs")) {
    sendLogs(id); cmdAck(id, true);
  } else {
    cmdAck(id, false, "unknown command");
  }
}

// ================= connection =================
static void mqttEvent(void*, esp_event_base_t, int32_t eventId, void* data) {
  esp_mqtt_event_handle_t e = (esp_mqtt_event_handle_t)data;
  switch ((esp_mqtt_event_id_t)eventId) {
    case MQTT_EVENT_CONNECTED:    connected = true; justConnected = true; break;
    case MQTT_EVENT_DISCONNECTED: connected = false; break;
    case MQTT_EVENT_DATA: {
      // ignore fragments of oversized messages (nothing we expect is > 640 B)
      if (e->current_data_offset != 0 || e->data_len != e->total_data_len) break;
      String t(e->topic, e->topic_len);
      String pre = String(MQTT_PREFIX "/") + deviceId() + "/";
      if (!t.startsWith(pre)) break;
      InMsg m;
      strlcpy(m.sub, t.c_str() + pre.length(), sizeof(m.sub));
      int n = min(e->data_len, (int)sizeof(m.data) - 1);
      memcpy(m.data, e->data, n); m.data[n] = 0;
      xQueueSend(inQ, &m, 0);
      break;
    }
    default: break;
  }
}

// call in setup() before the sensor task starts: queues + flash session store
void mqttInit() {
  inQ   = xQueueCreate(6, sizeof(InMsg));
  evQ   = xQueueCreate(16, sizeof(EvMsg));
  sessQ = xQueueCreate(2, sizeof(SessionOut));
  fsOk = LittleFS.begin(true);
  if (fsOk && !LittleFS.exists("/sq")) LittleFS.mkdir("/sq");
  if (!fsOk) LOG.println("[MQTT] LittleFS mount failed — sessions won't survive a reboot");

  // A session was running when power was lost / the ESP rebooted: send its
  // last checkpoint as a finished session (mqttLoop stores + publishes it).
  if (fsOk && LittleFS.exists(CKPT_FILE)) {
    File f = LittleFS.open(CKPT_FILE, "r");
    SessionOut s;
    bool ok = f && f.size() == sizeof(s) && f.read((uint8_t*)&s, sizeof(s)) == sizeof(s) &&
              s.r.startTs && s.r.endTs > s.r.startTs;
    if (f) f.close();
    LittleFS.remove(CKPT_FILE);
    if (ok) {
      s.r.startMs = s.r.endMs = 0;                 // millis() from before the reboot mean nothing now
      s.hyp[sizeof(s.hyp) - 1] = 0;
      xQueueSend(sessQ, &s, 0);
      LOG.printf("[SESSION] recovered an interrupted session (%d min in bed)\n", s.r.bedMin);
    }
  }
}

void sessionCheckpointSave(const SessionOut& s) {
  if (!fsOk) return;
  File f = LittleFS.open(CKPT_FILE, "w");
  if (f) { f.write((const uint8_t*)&s, sizeof(s)); f.close(); }
}

void sessionCheckpointClear() {
  if (fsOk && LittleFS.exists(CKPT_FILE)) LittleFS.remove(CKPT_FILE);
}

void mqttBegin() {
  if (cli) return;

  static String uri = MQTT_URI, id = deviceId(), will = topic("status");
  esp_mqtt_client_config_t c = {};
  c.broker.address.uri = uri.c_str();
  if (uri.startsWith("mqtts://")) c.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
  c.credentials.username = id.c_str();
  c.credentials.client_id = id.c_str();
  c.credentials.authentication.password = MQTT_DUMMY_PASS;
  c.session.keepalive = MQTT_KEEPALIVE_S;
  c.session.disable_clean_session = false;
  c.session.last_will.topic = will.c_str();
  c.session.last_will.msg = "offline";
  c.session.last_will.qos = 1;
  c.session.last_will.retain = 1;
  c.buffer.size = 4096;
  c.network.reconnect_timeout_ms = 5000;

  cli = esp_mqtt_client_init(&c);
  esp_mqtt_client_register_event(cli, MQTT_EVENT_ANY, mqttEvent, nullptr);
  esp_mqtt_client_start(cli);
  LOG.printf("[MQTT] connecting to %s as %s\n", MQTT_URI, id.c_str());
}

static void publishInfo() {
  static const char* rst[] = {"unknown","poweron","ext","sw","panic","int_wdt","task_wdt",
                              "wdt","deepsleep","brownout","sdio","usb","jtag","efuse","pwr_glitch","cpu_lockup"};
  int r = (int)esp_reset_reason();
  JsonDocument d;
  d["fw"] = FW_VERSION;
  d["ip"] = WiFi.localIP().toString();
  d["ssid"] = WiFi.SSID();
  d["chip"] = ESP.getChipModel();
  d["radar"] = radarOk ? 1 : 0;                        // generic 1/0 flag, never a model name
  d["rst"] = (r >= 0 && r < (int)(sizeof(rst) / sizeof(rst[0]))) ? rst[r] : "unknown";
  String out; serializeJson(d, out);
  mqttPublish("info", out, 1, true);
}

// state = DEVICE-DATA §2 + the "MISSING API" blocks (API.md §11a).
// sess/cmp/ngt are sent only while a sleep session runs.
static void publishState(const SensorData& s, const SleepLive& lv) {
  bool vitals = s.presence && s.inBed;                 // too far / moving -> no valid HR/BR
  char b[900];                                         // worst case ~650 B; snprintf may report more than it wrote
  int n = snprintf(b, sizeof(b),
    "{\"pr\":%d,\"bed\":%d,\"ss\":%d,\"hr\":%d,\"br\":%d,\"bs\":%d,\"mv\":%d,\"mr\":%d,"
    "\"dist\":%d,\"rssi\":%d,\"up\":%lu,\"fw\":\"" FW_VERSION "\",\"seq\":%lu,\"radar\":%d",
    s.presence, s.inBed, s.sleepState, vitals ? s.heartRate : 0, vitals ? s.breathRate : 0,
    vitals ? s.breathState : 4, s.motion, s.movingRange, s.distance, (int)WiFi.RSSI(),
    (unsigned long)(millis() / 1000), (unsigned long)s.seq, radarOk ? 1 : 0);
  if (lv.active && n < (int)sizeof(b)) {
    n += snprintf(b + n, sizeof(b) - n,
      ",\"sess\":{\"st\":%d,\"start\":%lu,\"bed\":%d,\"slp\":%d,\"dp\":%d,\"lt\":%d,\"aw\":%d,"
      "\"on\":%d,\"wk\":%d,\"tn\":%d,\"sc\":%d}"
      ",\"cmp\":{\"dis\":%d,\"abn\":%d,\"rat\":%d,\"resp\":%d,\"hr\":%d,\"apn\":%d,\"turn\":%d,\"lg\":%d,\"mn\":%d}"
      ",\"ngt\":{\"sc\":%d,\"slp\":%d,\"wk\":%d,\"sh\":%d,\"dp\":%d,\"oob\":%d,\"ex\":%d,\"tn\":%d,\"resp\":%d,\"hr\":%d,\"apn\":%d}",
      lv.stage, (unsigned long)lv.start, lv.bedMin, lv.sleepMin, lv.deepMin, lv.lightMin, lv.awakeMin,
      max(0, lv.onsetMin), lv.wakes, lv.turns, lv.score,
      s.disturbance, s.abnormal, s.rating, s.cResp, s.cHeart, s.cApnea, s.cTurn, s.cLarge, s.cMinor,
      s.sScore, s.sSleepTime, s.sWake, s.sShallow, s.sDeep, s.sOOB, s.sExit, s.sTurn, s.sResp, s.sHeart, s.sApnea);
  }
  if (n >= (int)sizeof(b) - 1) { LOG.println("[MQTT] state too big, skipped"); return; }
  b[n++] = '}'; b[n] = 0;
  mqttPublish("state", b, 0, false);
}

void mqttLoop() {
  static bool firstConnect = true, lastRadar = false;
  static uint32_t tState = 0, tResend = 0;
  static int lastPr = -1, lastBed = -1, lastSs = -1;
  uint32_t now = millis();

  // finished sessions go to flash first, even while offline
  static SessionOut s;                          // ~1.6 KB (1-minute hypnogram)
  // ...but only once NTP is synced, so start/end are real Unix UTC
  // (a session ending before the first sync waits here, max 2 in the queue)
  if (nowEpoch()) while (xQueueReceive(sessQ, &s, 0) == pdTRUE) sessionStore(s);
  if (!cli) return;

  if (justConnected) {
    justConnected = false;
    LOG.println("[MQTT] connected");
    mqttPublish("status", "online", 1, true);
    publishInfo();
    const char* subs[] = {"cmd", "settings/set", "ota", "session/ack"};
    for (auto sub : subs) esp_mqtt_client_subscribe(cli, topic(sub).c_str(), 1);
    if (firstConnect) {
      firstConnect = false;
      eventPush("reboot");
      otaBootReport();
    }
    tResend = now - SESSION_RESEND_MS + 3000;            // flush the flash queue soon
    lastPr = -1;                                         // force a state message
  }

  InMsg m;
  while (xQueueReceive(inQ, &m, 0) == pdTRUE) {
    if      (!strcmp(m.sub, "cmd"))          onCommand(m.data);
    else if (!strcmp(m.sub, "settings/set")) settingsApply(m.data);
    else if (!strcmp(m.sub, "ota"))          otaOffer(m.data);
    else if (!strcmp(m.sub, "session/ack"))  sessionAck(m.data);
  }

  if (!connected) return;
  eventsDrain();

  if (radarOk != lastRadar) {                            // radar link changed
    lastRadar = radarOk;
    eventPush(lastRadar ? "radar_ok" : "radar_fault");
    publishInfo();
  }

  // recalibrate: ack once the radar is back up after the reset
  // (radarOk alone is not enough: it stays 1 during the 11 s reset)
  if (recalId && g_recalDone) { g_recalDone = false; cmdAck(recalId, true); recalId = 0; }

  SensorData d; SleepLive lv;
  xSemaphoreTake(mux, portMAX_DELAY); d = g; lv = live; xSemaphoreGive(mux);
  uint32_t every = (d.presence ? g_set.live_s : g_set.idle_s) * 1000UL;
  bool changed = d.presence != lastPr || d.inBed != lastBed || d.sleepState != lastSs;
  if (changed || now - tState >= every) {
    tState = now; lastPr = d.presence; lastBed = d.inBed; lastSs = d.sleepState;
    publishState(d, lv);
  }

  if (now - tResend >= SESSION_RESEND_MS) { tResend = now; sessionsResend(); }
}
