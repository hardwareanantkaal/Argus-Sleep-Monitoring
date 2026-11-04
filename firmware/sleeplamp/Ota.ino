// Argus Sleep Monitoring · Ota.ino — OTA pushed by our own server over MQTT.
//
// Contract (docs/API.md §9 + §11):
//   server -> <p>/<d>/ota        {"rid":7,"ver":"1.4.3","url":"https://<domain>/fw/12.bin?t=..",
//                                 "sha256":"<64 hex>","size":1240000}
//   device -> <p>/<d>/ota/status {"rid":7,"s":"downloading"|"success"|"failed","err":".."}
//
// Flow: offer -> wait until no sleep session runs -> download + SHA-256 while
// writing -> verify -> save rid/ver in NVS -> reboot -> the new firmware
// reports success (or failed) once it reconnects to MQTT.
//
// Safety:
//   - never updates while a sleep session is running (would lose the night);
//     the server's install window keeps OTAs in the daytime too
//   - SHA-256 and size are checked BEFORE the boot slot is switched. The
//     sha256 arrives over the (TLS) MQTT link, so the HTTPS download itself
//     doesn't need certificate pinning to be safe.
//   - partition scheme must stay the same between releases ("Minimal SPIFFS")
#include "types.h"
#include "config.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "mbedtls/sha256.h"

static OtaJob job;

static void otaStatus(long rid, const char* s, const String& err = "") {
  JsonDocument d;
  d["rid"] = rid; d["s"] = s;
  if (err.length()) d["err"] = err;
  String out; serializeJson(d, out);
  mqttPublish("ota/status", out, 1, false);
}

static bool otaFail(long rid, const String& why) {
  LOG.printf("[OTA] FAILED: %s\n", why.c_str());
  otaStatus(rid, "failed", why);
  return false;
}

void otaOffer(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) { LOG.println("[OTA] bad offer JSON"); return; }
  OtaJob j;
  j.rid  = d["rid"] | 0L;
  j.ver  = (const char*)(d["ver"] | "");
  j.url  = (const char*)(d["url"] | "");
  j.sha  = (const char*)(d["sha256"] | "");
  j.size = d["size"] | 0;
  if (!j.rid || !j.url.length() || !j.ver.length()) { LOG.println("[OTA] incomplete offer"); return; }
  if (j.ver == FW_VERSION) {
    LOG.println("[OTA] offered version already running");
    otaStatus(j.rid, "success");
    return;
  }
  j.pending = true;
  job = j;
  LOG.printf("[OTA] offer rid %ld: v%s -> v%s, %d bytes\n", j.rid, FW_VERSION, j.ver.c_str(), j.size);
}

// download, hash, flash. Only returns on failure (success reboots).
static bool otaDownloadAndFlash(const OtaJob& j) {
  otaStatus(j.rid, "downloading");

  WiFiClientSecure client; client.setInsecure();   // integrity = SHA-256 from MQTT, see top
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(15000);
  if (!http.begin(client, j.url)) return otaFail(j.rid, "http.begin failed");

  int code = http.GET();
  if (code != 200) { http.end(); return otaFail(j.rid, String("firmware download HTTP ") + code); }

  int len = http.getSize();
  if (len <= 0) len = j.size;
  if (len <= 0) { http.end(); return otaFail(j.rid, "unknown firmware size"); }
  if (j.size > 0 && len != j.size) {
    http.end(); return otaFail(j.rid, String("size mismatch ") + len + " != " + j.size);
  }

  if (!Update.begin(len, U_FLASH)) {                   // also rejects images bigger than the OTA slot
    http.end(); return otaFail(j.rid, String("Update.begin: ") + Update.errorString());
  }

  mbedtls_sha256_context sctx;
  mbedtls_sha256_init(&sctx);
  mbedtls_sha256_starts(&sctx, 0);                     // 0 = SHA-256 (not 224)

  WiFiClient* s = http.getStreamPtr();
  static uint8_t buf[2048];
  size_t done = 0;
  uint32_t tLast = millis();
  int lastPct = -1;
  while (done < (size_t)len) {
    size_t avail = s->available();
    if (avail) {
      size_t want = (size_t)len - done;
      if (want > sizeof(buf)) want = sizeof(buf);
      if (avail < want) want = avail;
      int n = s->readBytes(buf, want);
      if (n <= 0) continue;
      if (Update.write(buf, n) != (size_t)n) break;
      mbedtls_sha256_update(&sctx, buf, n);
      done += n;
      tLast = millis();
      int pct = (int)(done * 100 / len);
      if (pct / 10 != lastPct / 10) { lastPct = pct; LOG.printf("[OTA] %d%%\n", pct); }
    } else if (!http.connected() || millis() - tLast > OTA_STALL_MS) {
      break;
    } else {
      delay(1);
    }
  }
  http.end();

  uint8_t digest[32];
  mbedtls_sha256_finish(&sctx, digest);
  mbedtls_sha256_free(&sctx);

  if (done != (size_t)len) {
    Update.abort();
    return otaFail(j.rid, String("incomplete ") + done + "/" + len);
  }

  if (j.sha.length() == 64) {
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
    if (!j.sha.equalsIgnoreCase(hex)) {
      Update.abort();                                  // boot slot NOT switched
      return otaFail(j.rid, "SHA-256 mismatch");
    }
    LOG.println("[OTA] SHA-256 OK");
  } else {
    Update.abort();
    return otaFail(j.rid, "missing sha256");
  }

  if (!Update.end(true)) return otaFail(j.rid, String("Update.end: ") + Update.errorString());

  // remember what we expect to boot as; the new firmware reports the result
  Preferences p; p.begin("ota", false);
  p.putLong("rid", j.rid);
  p.putString("ver", j.ver);
  p.end();
  LOG.println("[OTA] flashed OK — rebooting");
  delay(500);
  ESP.restart();
  return true;
}

// call from loop(): runs the pending job once no sleep session is active
void otaLoop() {
  if (!job.pending || !mqttConnected()) return;
  bool sessionActive;
  xSemaphoreTake(mux, portMAX_DELAY); sessionActive = live.active; xSemaphoreGive(mux);
  static uint32_t tNote = 0;
  if (sessionActive) {
    if (millis() - tNote > 600000UL) { tNote = millis(); LOG.println("[OTA] sleep session running — deferred"); }
    return;
  }
  OtaJob j = job;
  job.pending = false;
  otaDownloadAndFlash(j);   // blocks during download; reboots on success
}

// call once after the first MQTT connection: confirms/denies the last OTA
void otaBootReport() {
  Preferences p; p.begin("ota", false);
  long   rid = p.getLong("rid", 0);
  String ver = p.getString("ver", "");
  if (rid) { p.remove("rid"); p.remove("ver"); }
  p.end();
  if (!rid) return;

  if (ver == FW_VERSION) {
    LOG.printf("[OTA] now running v%s — success\n", FW_VERSION);
    otaStatus(rid, "success");
  } else {
    LOG.printf("[OTA] expected v%s but running v%s\n", ver.c_str(), FW_VERSION);
    otaStatus(rid, "failed", String("booted ") + FW_VERSION + ", expected " + ver);
  }
}
