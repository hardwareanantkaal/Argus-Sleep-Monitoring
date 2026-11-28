// Argus Sleep Monitoring · types.h — shared data model + global declarations
// Pure C1001 radar sensor node: no lamp, no touch button, no alarm, no Matter.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "ShubhSensor.h"
#include "config.h"

// All telemetry: C1001 radar only
struct SensorData {
  bool valid = false; uint32_t seq = 0;
  // live human (radar)
  int presence=0, motion=0, movingRange=0, distance=0;
  int heartRate=0, breathRate=0, breathState=4;
  // live sleep (radar)
  int inBed=0, sleepState=3, wakeDur=0, lightDur=0, deepDur=0, quality=0;
  int disturbance=3, rating=0, abnormal=0;
  // composite (radar)
  int cResp=0, cHeart=0, cTurn=0, cLarge=0, cMinor=0, cApnea=0;
  // nightly statistics (radar)
  int sScore=0, sSleepTime=0, sWake=0, sShallow=0, sDeep=0,
      sOOB=0, sExit=0, sTurn=0, sResp=0, sHeart=0, sApnea=0;
};

// On-device sleep-session recording (1 sample/min, ~10 h ring buffer).
// stage: 0 deep, 1 light, 2 awake in bed, 3 no session, 4 out of bed (in a session)
#define SESS_MAX 1440   // 24 h: a night longer than the old 600 min ring broke the hypnogram
struct SessSample { uint8_t stage, hr, br; };

// Live output of the on-device sleep-staging engine (Sleep.ino).
// stage: 0 deep, 1 light, 2 awake-in-bed, 3 no session — same coding as radar.
struct SleepLive {
  bool active = false;
  int  stage = 3;
  int  bedMin=0, sleepMin=0, deepMin=0, lightMin=0, awakeMin=0;
  int  onsetMin=-1, wakes=0, turns=0, score=0;   // score = live estimate
  uint32_t start = 0;                            // session start, Unix UTC (0 = unknown)
};

struct NightReport {
  bool     valid = false;
  uint32_t startTs = 0, endTs = 0;               // Unix UTC: bed in / bed out (0 = NTP not synced yet)
  uint32_t startMs = 0, endMs = 0;               // millis() at bed in / bed out (fills start/end after a late NTP sync)
  int  bedMin=0, sleepMin=0, deepMin=0, lightMin=0, awakeMin=0, oobMin=0, exits=0;
  int  onsetMin=0, wakes=0, turns=0, avgHR=0, avgBR=0, apnea=0, score=0;
  int  mrAvg=0, mrMin=0, quietPct=0, vQuietPct=0;  // diagnostics: movement range in bed
  int  bedOffPct=0;                                // diagnostics: % present minutes the radar said "not in bed"
};

// One finished session, ready to become a <p>/<d>/session message
struct SessionOut {
  NightReport r;
  int  hrMin=0, hrMax=0, brMin=0, brMax=0, bigMv=0, smallMv=0, struggles=0;
  char hyp[SESS_MAX / HYP_BLOCK_MIN + 2] = "";
};

// Server-controlled settings (<p>/<d>/settings/set), saved in NVS
struct DevSettings {
  int v = 0, exit_s = 300, live_s = 2, idle_s = 60;
  int struggle = 1, unattended = 0, unatt_min = 30;
  int min_sess = AUTO_SAVE_MIN;                  // discard sessions shorter than this (minutes)
};

// A firmware update offered on <p>/<d>/ota (Ota.ino)
struct OtaJob { bool pending = false; long rid = 0; int size = 0; String ver, url, sha; };

// Serial + RAM ring buffer, so the `logs` command can upload recent output
class TeeLog : public Print {
public:
  size_t write(uint8_t c) override;
  size_t write(const uint8_t* b, size_t n) override;
  String snapshot();
};

// ---- globals (defined in sleeplamp.ino) ----
extern SensorData              g;
extern WebServer               server;
extern ShubhSensor             hu;
extern SemaphoreHandle_t       mux;
extern TeeLog                  LOG;
extern DevSettings             g_set;
extern volatile bool           g_sensorReset; // please reset the radar
extern volatile bool           g_recalDone;   // sensor task -> MQTT: user reset finished, radar back up
extern volatile bool           radarOk;       // sensor task -> world: radar link healthy
extern volatile bool           g_configMode;  // set true -> device opens the AP setup hotspot
extern volatile bool           g_endSession;  // MQTT -> sensor task: close the running session now
extern SleepLive               live;          // engine -> world (guarded by mux)
extern SessSample              sessBuf[SESS_MAX];
extern int                     sessN, sessStart;

// ---- entry points across the .ino tabs ----
void   sensorTask(void*);     // Sensor.ino
void   sleepFeed(const SensorData& s, SleepLive& outLive,
                 NightReport& outRep, bool& repReady);  // Sleep.ino
// Mqtt.ino — the only data path (device <-> server)
String   deviceId();          // WiFi MAC, 12 lowercase hex chars
uint32_t nowEpoch();          // Unix UTC once NTP synced, else 0
void   timeBegin();           // start NTP sync (call once WiFi is connected)
void   mqttInit();           // queues + flash store (setup, before tasks)
void   mqttBegin();           // start the client (call once WiFi is connected)
void   mqttLoop();            // call every loop()
bool   mqttConnected();
void   mqttPublish(const String& sub, const String& payload, int qos, bool retain);
void   eventPush(const char* type, uint32_t ts = 0);   // thread-safe
void   sessionSubmit(const SessionOut& s);              // thread-safe
void   sessionCheckpointSave(const SessionOut& s);      // running session -> flash (sensor task)
void   sessionCheckpointClear();
bool   sleepSnapshot(NightReport& r);                   // Sleep.ino: report of the running session
void   settingsLoad();
// Provision.ino — WiFi portal (APMODE scan-and-pick network list), local OTA page, factory reset
int    wifiNetCount(); String wifiNetSsid(int i);  String wifiNetPass(int i);
bool   wifiConnectAny(uint32_t perNetworkTimeoutMs); // tries every saved network in turn
void   handleWifiPage();      void handleWifiSave();
void   handleUpdatePage();    void handleUpdateDone();  void handleUpdateUpload();
void   handleFactoryReset();
// Ota.ino — OTA pushed by the server over MQTT
void   otaOffer(const char* json);   // <p>/<d>/ota message arrived
void   otaLoop();                    // runs a pending OTA when no session is active
void   otaBootReport();              // after connect: report success/failed of the last OTA
