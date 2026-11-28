// Argus Sleep Monitoring · Provision.ino — WiFi setup portal (APMODE), OTA firmware update,
// factory reset.
//
// APMODE network list: instead of one hardcoded SSID/password, Argus keeps
// up to APMODE_MAX_NETS saved networks in NVS. wifiConnectAny() tries each
// saved network (strongest signal first) before falling back to the AP setup
// hotspot. The /wifi page — reachable while connected OR while in the setup
// hotspot at http://192.168.4.1/wifi — SCANS for nearby WiFi and shows a
// dropdown to pick from, so you never have to type an SSID by hand. Saving
// adds/updates that network in the list; it does not erase the others.
#include "types.h"
#include "config.h"
#include <Preferences.h>
#include <Update.h>

static Preferences pv;

// ---------------- saved network list (NVS: namespace "argus", keys wN_ssid/wN_pass) ----------------

int wifiNetCount() {
  pv.begin("argus", true);
  int n = pv.getInt("wnCount", -1);
  pv.end();
  if (n >= 0) return min(n, APMODE_MAX_NETS);

  // migrate an old single-network save (or compile-time default) into slot 0
  pv.begin("argus", true);
  String s = pv.getString("wssid", "");
  pv.end();
  return s.length() ? 1 : 0;
}

String wifiNetSsid(int i) {
  pv.begin("argus", true);
  String s;
  if (i == 0 && !pv.isKey("w0_ssid")) s = pv.getString("wssid", "");  // migrate legacy key
  else                                s = pv.getString(("w" + String(i) + "_ssid").c_str(), "");
  pv.end();
  return s;
}
String wifiNetPass(int i) {
  pv.begin("argus", true);
  String s;
  if (i == 0 && !pv.isKey("w0_ssid")) s = pv.getString("wpass", "");  // migrate legacy key
  else                                s = pv.getString(("w" + String(i) + "_pass").c_str(), "");
  pv.end();
  return s;
}

// backward-compat helpers used by argus.ino's first-attempt log line
String getWifiSsid() { return wifiNetCount() ? wifiNetSsid(0) : String(""); }
String getWifiPass() { return wifiNetCount() ? wifiNetPass(0) : String(""); }

// add (or update, if the SSID is already saved) one network, most-recent-first
static void wifiNetSave(const String& ssid, const String& pass) {
  if (!ssid.length()) return;
  int n = wifiNetCount();
  String ss[APMODE_MAX_NETS], pp[APMODE_MAX_NETS];
  int keep = 0;
  ss[keep] = ssid; pp[keep] = pass; keep++;             // new/updated network goes first
  for (int i = 0; i < n && keep < APMODE_MAX_NETS; i++) {
    String os = wifiNetSsid(i);
    if (os == ssid) continue;                           // replaced above
    ss[keep] = os; pp[keep] = wifiNetPass(i); keep++;
  }
  pv.begin("argus", false);
  pv.remove("wssid"); pv.remove("wpass");                // drop legacy single-net keys
  for (int i = 0; i < APMODE_MAX_NETS; i++) {
    if (i < keep) { pv.putString(("w" + String(i) + "_ssid").c_str(), ss[i]);
                    pv.putString(("w" + String(i) + "_pass").c_str(), pp[i]); }
    else          { pv.remove(("w" + String(i) + "_ssid").c_str());
                    pv.remove(("w" + String(i) + "_pass").c_str()); }
  }
  pv.putInt("wnCount", keep);
  pv.end();
  LOG.printf("[WiFi] saved \"%s\" (%d network%s stored)\n", ssid.c_str(), keep, keep==1?"":"s");
}

static void wifiNetForget(const String& ssid) {
  int n = wifiNetCount();
  String ss[APMODE_MAX_NETS], pp[APMODE_MAX_NETS];
  int keep = 0;
  for (int i = 0; i < n; i++) {
    String os = wifiNetSsid(i);
    if (os == ssid) continue;
    ss[keep] = os; pp[keep] = wifiNetPass(i); keep++;
  }
  pv.begin("argus", false);
  for (int i = 0; i < APMODE_MAX_NETS; i++) {
    if (i < keep) { pv.putString(("w" + String(i) + "_ssid").c_str(), ss[i]);
                    pv.putString(("w" + String(i) + "_pass").c_str(), pp[i]); }
    else          { pv.remove(("w" + String(i) + "_ssid").c_str());
                    pv.remove(("w" + String(i) + "_pass").c_str()); }
  }
  pv.putInt("wnCount", keep);
  pv.end();
}

// Try every saved network, strongest nearby signal first. Returns true if
// connected. Leaves WiFi in STA mode either way (caller decides AP fallback).
bool wifiConnectAny(uint32_t perNetworkTimeoutMs) {
  int n = wifiNetCount();
  if (n == 0) return false;

  // scan once so we can order attempts by RSSI (skip nets that aren't even
  // visible right now to save time)
  int found = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    String ssid = wifiNetSsid(i), pass = wifiNetPass(i);
    if (!ssid.length()) continue;
    bool visible = false;
    for (int j = 0; j < found; j++) if (WiFi.SSID(j) == ssid) { visible = true; break; }
    if (found > 0 && !visible) continue;   // scan succeeded and this SSID isn't around

    LOG.printf("[WiFi] trying saved network \"%s\"...\n", ssid.c_str());
    WiFi.begin(ssid.c_str(), pass.c_str());
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < perNetworkTimeoutMs) { delay(300); LOG.print('.'); }
    LOG.println();
    if (WiFi.status() == WL_CONNECTED) {
      LOG.printf("[WiFi] connected to \"%s\", IP: %s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
      WiFi.scanDelete();
      return true;
    }
    // DEBUG: numeric wl_status_t so you can tell WHY it failed —
    // 0 WL_IDLE_STATUS, 1 WL_NO_SSID_AVAIL, 3 WL_CONNECTED, 4 WL_CONNECT_FAILED,
    // 5 WL_CONNECTION_LOST, 6 WL_DISCONNECTED
    LOG.printf("[WiFi] \"%s\" failed — WiFi.status()=%d\n", ssid.c_str(), (int)WiFi.status());
    WiFi.disconnect(true);
  }
  WiFi.scanDelete();
  return false;
}

// ---------------- /wifi setup page: live scan + dropdown ----------------

static const char* HEAD =
  "<!DOCTYPE html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
  "<title>Argus Setup</title>"
  "<style>"
  "*{box-sizing:border-box}"
  "body{background:#0a0e16;color:#e7ebf3;font:15px/1.6 -apple-system,system-ui,Roboto,sans-serif;"
  "margin:0;padding:28px 18px 60px;display:flex;justify-content:center}"
  ".wrap{width:100%;max-width:420px}"
  ".brand{font-size:12px;letter-spacing:.06em;color:#7c84f2;text-transform:uppercase;font-weight:700;margin-bottom:6px}"
  "h2{font-weight:700;font-size:22px;margin:0 0 6px}"
  ".m{color:#828ea6;font-size:13.5px;line-height:1.55;margin:0 0 20px}"
  ".card{background:#10161f;border:1px solid #212a3b;border-radius:16px;padding:20px;margin-bottom:16px}"
  "label{display:block;font-size:12.5px;color:#9aa4b8;font-weight:600;margin:0 0 6px;text-transform:uppercase;letter-spacing:.03em}"
  "select,input:not([type=file]){width:100%;padding:13px 14px;margin-bottom:16px;border-radius:11px;"
  "border:1px solid #253046;background:#0d1320;color:#e7ebf3;font-size:15px;appearance:none}"
  "select:focus,input:focus{outline:none;border-color:#7c84f2}"
  "input[type=file]{width:100%;margin-bottom:16px;padding:14px;border-radius:11px;"
  "border:1px dashed #253046;background:#0d1320;color:#9aa4b8;font-size:14px}"
  "button{width:100%;padding:14px;border-radius:11px;border:0;font-size:15.5px;font-weight:700;cursor:pointer;"
  "background:linear-gradient(135deg,#7c84f2,#9b6ff2);color:#0b0f18}"
  "button:active{opacity:.85}"
  "button.sec{background:#161d2b;color:#e7ebf3;border:1px solid #253046;font-weight:600}"
  ".net{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #1a2130}"
  ".net:last-child{border-bottom:0}"
  ".net span{font-size:14px}"
  ".net form{margin:0}"
  ".net button{width:auto;padding:8px 14px;margin:0;font-size:12.5px}"
  ".links{display:flex;gap:18px;flex-wrap:wrap;margin-top:22px;padding-top:4px}"
  "a{color:#7c84f2;text-decoration:none;font-size:13.5px;font-weight:600}"
  "a:active{opacity:.7}"
  ".note{background:#161d2b;border:1px solid #253046;border-radius:12px;padding:14px 16px;"
  "font-size:13px;color:#9aa4b8;line-height:1.6;margin-top:18px}"
  "</style>";

// GET /wifi — scan nearby networks + list saved ones
void handleWifiPage() {
  LOG.println("[WiFi] scanning for setup page...");
  int found = WiFi.scanNetworks();

  String opts = "<option value=''>Choose a network&hellip;</option>";
  for (int i = 0; i < found; i++) {
    String s = WiFi.SSID(i);
    if (!s.length()) continue;
    bool dup = false;                              // dedupe repeated SSIDs (multiple APs)
    for (int j = 0; j < i; j++) if (WiFi.SSID(j) == s) { dup = true; break; }
    if (dup) continue;
    bool open = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    opts += "<option value='" + s + "'>" + s + "  (" + String(WiFi.RSSI(i)) + " dBm" + (open ? ", open" : "") + ")</option>";
  }

  String saved;
  int n = wifiNetCount();
  for (int i = 0; i < n; i++) {
    String s = wifiNetSsid(i);
    if (!s.length()) continue;
    saved += "<div class='net'><span>" + s + "</span>"
             "<form method='POST' action='/wifi'>"
             "<input type='hidden' name='forget' value='" + s + "'>"
             "<button class='sec'>Forget</button></form></div>";
  }

  server.send(200, "text/html", String(HEAD) +
    "<div class='wrap'>"
    "<div class='brand'>Argus Sleep Monitoring</div>"
    "<h2>WiFi Setup</h2>"
    "<p class='m'>Pick your network below, enter its password, and save. "
    "Argus stores up to " + String(APMODE_MAX_NETS) + " networks and tries each one on boot.</p>"

    "<div class='card'>"
    "<form method='POST' action='/wifi'>"
    "<label>Network</label>"
    "<select name='ssid' required>" + opts + "</select>"
    "<label>Password</label>"
    "<input name='pass' type='password' placeholder='Leave blank for an open network'>"
    "<button>Save &amp; Reboot</button>"
    "</form>"
    "</div>"

    + (saved.length() ?
      "<div class='card'><label style='margin-bottom:2px'>Saved networks</label>" + saved + "</div>"
      : "") +

    "<div class='links'>"
    "<a href='/wifi'>&#8635; Rescan</a>"
    "<a href='/update'>&#8593; Firmware update</a>"
    "</div>"

    "<div class='note'>Connected to <b>" + String(APMODE_SSID) + "</b> right now? Your phone will stay on "
    "this network while you're on this page — that's expected, not a fault. It switches back once you leave.</div>"
    "</div>");
}

// POST /wifi — save a new network (from the dropdown) or forget one
void handleWifiSave() {
  if (server.hasArg("forget") && server.arg("forget").length()) {
    wifiNetForget(server.arg("forget"));
    handleWifiPage();
    return;
  }
  if (!server.hasArg("ssid") || !server.arg("ssid").length()) { server.send(400, "text/plain", "choose a network"); return; }
  wifiNetSave(server.arg("ssid"), server.arg("pass"));
  server.send(200, "text/html", String(HEAD) +
    "<div class='wrap'>"
    "<div class='brand'>Argus Sleep Monitoring</div>"
    "<h2>Saved. Rebooting&hellip;</h2>"
    "<div class='card'><p class='m' style='margin:0'>Argus will join <b>" + server.arg("ssid") + "</b> and start sending "
    "sleep data to the server automatically. Check your Argus Sleep Monitoring "
    "website to view it once the device reconnects (usually under a minute).</p></div>"
    "</div>");
  delay(900); ESP.restart();
}

void handleUpdatePage() {
  server.send(200, "text/html", String(HEAD) +
    "<div class='wrap'>"
    "<div class='brand'>Argus Sleep Monitoring</div>"
    "<h2>Firmware Update</h2>"
    "<p class='m'>Upload a compiled .bin file. In Arduino IDE: Sketch &rarr; Export Compiled Binary.</p>"
    "<div class='card'>"
    "<form method='POST' action='/update' enctype='multipart/form-data'>"
    "<label>Firmware file</label>"
    "<input type='file' name='fw' accept='.bin' required>"
    "<button>Upload &amp; Flash</button>"
    "</form>"
    "</div>"
    "<div class='links'><a href='/wifi'>&larr; Back to WiFi setup</a></div>"
    "<div class='note'>Device restarts automatically once the upload finishes. Don't close this page or power off Argus mid-upload.</div>"
    "</div>");
}

void handleUpdateDone() {
  bool ok = !Update.hasError();
  server.send(200, "text/html", String(HEAD) +
    "<div class='wrap'>"
    "<div class='brand'>Argus Sleep Monitoring</div>"
    + (ok
      ? "<h2>Update successful</h2><div class='card'><p class='m' style='margin:0'>Rebooting now&hellip;</p></div>"
      : "<h2>Update failed</h2><div class='card'><p class='m' style='margin:0 0 14px'>Something went wrong during the flash. Please try again.</p>"
        "<a href='/update' style='display:block;text-align:center;background:#161d2b;border:1px solid #253046;"
        "border-radius:11px;padding:12px;font-weight:700'>Try again</a></div>")
    + "</div>");
  if (ok) { delay(900); ESP.restart(); }
}

void handleUpdateUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START)      { LOG.printf("[OTA] %s\n", up.filename.c_str()); Update.begin(UPDATE_SIZE_UNKNOWN); }
  else if (up.status == UPLOAD_FILE_WRITE) { Update.write(up.buf, up.currentSize); }
  else if (up.status == UPLOAD_FILE_END)   { Update.end(true); }
}

void handleFactoryReset() {
  if (!server.hasArg("confirm")) { server.send(200, "application/json", "{\"need\":\"confirm\"}"); return; }
  Preferences p; p.begin("argus", false); p.clear(); p.end();
  server.send(200, "text/html", String(HEAD) +
    "<div class='wrap'><div class='brand'>Argus Sleep Monitoring</div>"
    "<h2>Factory reset done</h2><div class='card'><p class='m' style='margin:0'>Rebooting&hellip;</p></div></div>");
  delay(900); ESP.restart();
}
