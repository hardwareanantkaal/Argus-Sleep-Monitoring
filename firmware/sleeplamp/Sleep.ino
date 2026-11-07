// Argus Sleep Monitoring · Sleep.ino — on-device sleep-staging engine.
// STAGING: SleepLamp movement engine + (v2.1) radar eSleepState votes, an
// asleep-HR baseline, deep-block caps/refractory and a deep-share budget. The only
// additions are read-only bookkeeping for the MQTT session summary (Unix
// start/end, out-of-bed minutes, bed exits); none of it feeds back into the
// staging decisions. The bed-exit timeout comes from the server setting exit_s.
//
// WHY THIS EXISTS: the C1001's internal staging needs 15-20+ minutes of
// in-bed data before it reports anything (sleepState stays "None"), and its
// nightly-statistics frame arrives only once per completed night — useless
// for naps, and corrupt frames used to flood the history with junk numbers.
// This engine stages every minute from movement + vitals, works from minute
// one, and builds the night report itself so it can also be generated on
// demand from the dashboard.
//
// Runs entirely inside sensorTask (single thread): sleepFeed() is called once
// per radar poll (~0.4 s) and finalises one staging epoch per minute.
//
// Staging rules (epoch = 1 minute):
//   session starts : present + in bed
//   asleep (light) : ONSET_QUIET_EP consecutive quiet minutes (back-dated)
//   deep           : DEEP_AFTER_EP very-quiet minutes AND heart rate below
//                    the awake-in-bed baseline (skipped if no HR lock)
//   awakening      : sustained movement while asleep
//   turnover       : brief movement spike while asleep (stays asleep)
//   session ends   : out of bed/zone for g_set.exit_s (default 5 min)
#include "types.h"
#include "config.h"
#include <time.h>

// ---- per-epoch accumulators ----
static uint32_t epStart = 0;
static int  nSamp=0, sumRange=0, bursts=0, presCnt=0, bedCnt=0;
static long sumHR=0;  static int nHR=0;
static long sumBR=0;  static int nBR=0;
static int  ssVote[4]={0,0,0,0};          // radar's own eSleepState this epoch: 0 deep 1 light 2 awake 3 none

// ---- session state ----
static bool sOn=false;
static int  stage=3;                       // 0 deep, 1 light, 2 awake, 3 none
static int  bedMin=0, deepMin=0, lightMin=0, awakeMin=0;
static int  quietRun=0, vQuietRun=0, oobRun=0, onset=-1, wakes=0, turns=0;
static int  hrBase=0;                      // awake-in-bed heart-rate baseline
static long sesHR=0;  static int sesHRn=0; // averaged over asleep minutes only
static long sesBR=0;  static int sesBRn=0;
static uint32_t startTs=0;                 // Unix UTC at bed entry (0 = NTP not synced yet)
static int  oobMin=0, exits=0;             // minutes out of bed / number of bed exits
static uint32_t startMs=0;                 // millis() at bed entry
static int  hrSleep=0;                     // asleep (light) heart-rate baseline, slow EMA
static int  hrSleepN=0;                    // light minutes that fed hrSleep
static int  deepRun=0;                     // length of the current deep block
static int  lightSinceDeep=0;              // light minutes since the last deep block ended
static int  sleepRun=0;                    // asleep minutes since the latest onset
// diagnostics only (sent in the session message, never used for staging):
// how much the radar's movement range really was while the person lay in bed
static long mrSum=0; static int mrN=0, mrMin=100, mrQuiet=0, mrVQuiet=0, bedOff=0;

// 45% efficiency + 25% deep share (target 25%) + 15% duration (target 7 h)
// + 15% few awakenings. Clamped 1..99 so a junk-free score is always plausible.
static int scoreOf(int bed, int sleep, int deep, int wk) {
  if (bed <= 0 || sleep <= 0) return sleep > 0 ? 1 : 0;
  int eff   = sleep * 100 / bed;
  int deepP = deep * 100 / sleep;
  int sc = (45*eff + 25*min(100, deepP*4) + 15*min(100, sleep*100/420)
            + 15*max(0, 100 - 12*wk)) / 100;
  return constrain(sc, 1, 99);
}

static void resetSession() {
  sOn=false; stage=3; bedMin=deepMin=lightMin=awakeMin=0;
  quietRun=vQuietRun=oobRun=0; onset=-1; wakes=turns=0; hrBase=0;
  sesHR=sesBR=0; sesHRn=sesBRn=0; startTs=0; oobMin=exits=0; startMs=0;
  hrSleep=hrSleepN=0; deepRun=0; lightSinceDeep=DEEP_REFRACT_EP; sleepRun=0;
  mrSum=0; mrN=0; mrMin=100; mrQuiet=mrVQuiet=0; bedOff=0;
}

// dropTrail: minutes spent already-gone before the out-of-bed timeout fired
static void buildReport(NightReport& r, int dropTrail) {
  r.valid    = true;
  r.bedMin   = max(0, bedMin  - dropTrail);
  r.awakeMin = max(0, awakeMin- dropTrail);
  r.deepMin  = deepMin;  r.lightMin = lightMin;
  r.sleepMin = deepMin + lightMin;
  r.onsetMin = max(0, onset);
  r.wakes    = wakes;    r.turns = turns;
  r.avgHR    = sesHRn ? (int)(sesHR/sesHRn) : 0;
  r.avgBR    = sesBRn ? (int)(sesBR/sesBRn) : 0;
  r.apnea    = 0;                       // caller fills from radar if sane
  r.score    = scoreOf(r.bedMin, r.sleepMin, r.deepMin, r.wakes);
  r.oobMin   = max(0, oobMin - dropTrail);
  r.exits    = exits;
  r.mrAvg    = mrN ? (int)(mrSum / mrN) : 0;
  r.mrMin    = mrN ? mrMin : 0;
  r.quietPct = mrN ? mrQuiet  * 100 / mrN : 0;
  r.vQuietPct= mrN ? mrVQuiet * 100 / mrN : 0;
  r.bedOffPct= mrN ? bedOff   * 100 / mrN : 0;
  r.startTs  = startTs;
  r.startMs  = startMs;
  r.endMs    = millis() - (uint32_t)dropTrail * 60000UL;   // the moment they left
  uint32_t now = nowEpoch();
  r.endTs    = now ? now - (uint32_t)dropTrail * 60 : 0;
  // NTP synced only after bed entry: derive the start from the uptime clock
  if (!r.startTs && r.endTs && startMs)
    r.startTs = r.endTs - (r.endMs - startMs) / 1000;
}

// Report of the session still running, as if it ended now (minus any
// out-of-bed tail). Only with real clock time and when long enough to keep.
// Called from the sensor task (same thread as sleepFeed).
bool sleepSnapshot(NightReport& r) {
  if (!sOn || !nowEpoch()) return false;
  buildReport(r, oobRun);
  return r.startTs && r.endTs > r.startTs && r.bedMin >= max(1, g_set.min_sess);
}

void sleepFeed(const SensorData& s, SleepLive& outLive,
               NightReport& outRep, bool& repReady) {
  repReady = false;
  uint32_t now = millis();
  uint32_t epLen = SLEEP_EPOCH_SEC * 1000UL;
  if (!epStart) epStart = now;

  // Radar outage / long stall: sleepFeed wasn't called for several epochs,
  // so the accumulators mix samples that are minutes apart. A staging
  // decision from that mush would be garbage — restart the epoch cleanly.
  if (now - epStart >= epLen * 3) {
    epStart = now; nSamp = 0; sumRange = 0; bursts = 0;
    presCnt = bedCnt = 0; sumHR = sumBR = 0; nHR = nBR = 0;
    memset(ssVote, 0, sizeof(ssVote));
  }

  nSamp++; sumRange += s.movingRange;
  if (s.movingRange >= BURST_RANGE) bursts++;
  if (s.presence) presCnt++;
  if (s.presence && s.inBed) bedCnt++;
  if (s.heartRate  > 0) { sumHR += s.heartRate;  nHR++; }
  if (s.breathRate > 0) { sumBR += s.breathRate; nBR++; }
  if (s.sleepState >= 0 && s.sleepState <= 3) ssVote[s.sleepState]++;

  // ---- epoch boundary: one staging decision per "minute" ----
  if (now - epStart >= epLen && nSamp >= 3) {
    int  meanRange = sumRange / nSamp;
    int  burstPct  = bursts * 100 / nSamp;   // % of samples spiking >= BURST_RANGE
    bool present   = presCnt * 2 > nSamp;
    bool inbed     = present && bedCnt * 2 > nSamp;
    int  epHR      = nHR ? (int)(sumHR/nHR) : 0;
    int  epBR      = nBR ? (int)(sumBR/nBR) : 0;
    // burst thresholds as a fraction of the epoch, so they hold at any
    // epoch length: 4% of a 60 s epoch ≈ 2.4 s of movement spikes.
    // the radar's own staging for this minute (majority vote, needs >50%)
    bool radarDeep  = ssVote[0] * 2 > nSamp;
    bool radarAwake = ssVote[2] * 2 > nSamp;
    bool radarSleep = (ssVote[0] + ssVote[1]) * 2 > nSamp;   // radar says light or deep
    // 2.4.0 FIX ("100% awake all night"): the C1001's in-bed flag drops to 0
    // while a still sleeper is plainly there (seen on the old dashboard:
    // "Out of bed" + still + 71 cm). Such a minute was neither "out of bed"
    // nor "quiet", so it counted as AWAKE and sleep could never begin.
    // A session has already confirmed the bed, so inside it presence is enough.
    bool lying     = sOn ? present : inbed;
    // quiet = little movement; OR the radar itself stages the minute as
    // sleep while there is no wake-level movement
    bool quiet     = lying && burstPct <= 4 &&
                     (meanRange <= QUIET_RANGE || (radarSleep && meanRange < WAKE_RANGE));
    bool vQuiet    = quiet && burstPct <= 1 && (meanRange <= 4 || (radarDeep && meanRange <= QUIET_RANGE));

    if (!sOn) {
      if (inbed) {                              // ---- session begins ----
        resetSession(); sOn = true; stage = 2;
        startTs = nowEpoch(); startMs = millis() - epLen;
        LOG.println(F("[SLEEP] session started (in bed)"));
      }
    } else {
      bedMin++;
      if (!present) {                           // out of bed / out of zone
        if (oobRun == 0) exits++;
        oobRun++; awakeMin++; oobMin++;
        if (stage == 0) lightSinceDeep = 0;
        stage = 2; quietRun = vQuietRun = 0; deepRun = 0; sleepRun = 0;
      } else {
        oobRun = 0;
        if (!inbed) bedOff++;                   // diagnostics: present but radar says "not in bed"
        {                                       // diagnostics: movement while lying in bed
          mrSum += meanRange; mrN++; mrMin = min(mrMin, meanRange);
          if (quiet) mrQuiet++;
          if (vQuiet) mrVQuiet++;
        }
        if (stage == 2 && epHR > 0)             // learn baseline while awake
          hrBase = hrBase ? (hrBase*3 + epHR)/4 : epHR;

        if (stage == 2) {                       // awake -> falling asleep?
          awakeMin++;
          quietRun = quiet ? quietRun + 1 : 0;
          if (quietRun >= ONSET_QUIET_EP) {
            stage = 1;                          // asleep — back-date onset
            awakeMin -= quietRun; lightMin += quietRun;
            if (onset < 0) onset = max(0, bedMin - quietRun);
            vQuietRun = vQuiet ? 1 : 0;
            sleepRun = quietRun; lightSinceDeep += quietRun;
            LOG.println(F("[SLEEP] fell asleep (light)"));
          }
        } else {                                // asleep
          // awakening = sustained movement (>=13% of the epoch ≈ 8 s), high
          // mean activity for the whole minute, or the radar itself says
          // "awake" while there is more than quiet-level movement
          bool moveWake = meanRange >= WAKE_RANGE || burstPct >= 13 ||
                          (radarAwake && !quiet);
          if (moveWake) {
            if (stage == 0) lightSinceDeep = 0;
            stage = 2; wakes++; awakeMin++; quietRun = vQuietRun = 0;
            deepRun = 0; sleepRun = 0;
            LOG.println(F("[SLEEP] awakening (movement)"));
          } else {
            if (burstPct >= 3) turns++;         // brief stir (~2 s), still asleep
            vQuietRun = vQuiet ? vQuietRun + 1 : 0;
            sleepRun++;
            int slept = deepMin + lightMin;
            int deepPct = slept > 0 ? deepMin * 100 / slept : 0;
            // HR evidence vs the ASLEEP baseline (light-sleep HR), falling
            // back to the awake-in-bed baseline until it is learned
            int base = hrSleepN >= 10 ? hrSleep : hrBase;
            bool hrLow = epHR > 0 && base > 0 && epHR <= base - max(2, base / 25);
            bool hrUnknown = epHR == 0 || base == 0;
            if (stage == 1) {
              lightMin++; lightSinceDeep++;
              if (epHR > 0) { hrSleep = hrSleep ? (hrSleep * 7 + epHR) / 8 : epHR; hrSleepN++; }
              // deep entry: a long very-quiet run, some light sleep first,
              // a gap since the last deep block, and physiological evidence.
              bool evidence;
              if (deepPct >= DEEP_HARD_PCT && slept >= 60) evidence = false;
              else if (deepPct >= DEEP_TARGET_PCT && slept >= 60)
                evidence = radarDeep && hrLow;              // over budget: need both
              else if (slept >= 300)                        // late night: deep is rare
                evidence = radarDeep && (hrLow || hrUnknown);
              else
                evidence = radarDeep || hrLow || (hrUnknown && vQuietRun >= DEEP_AFTER_EP * 2);
              if (vQuietRun >= DEEP_AFTER_EP && sleepRun >= DEEP_FIRST_LIGHT &&
                  lightSinceDeep >= DEEP_REFRACT_EP && evidence) {
                stage = 0; deepRun = 0;
                LOG.println(F("[SLEEP] deep"));
              }
            } else {                            // deep
              deepMin++; deepRun++;
              bool hrUp = epHR > 0 && base > 0 && epHR >= base;
              if (!vQuiet || hrUp || deepRun >= DEEP_MAX_BLOCK ||
                  (!radarDeep && ssVote[1] * 2 > nSamp && deepRun >= 10)) {
                stage = 1; lightSinceDeep = 0; deepRun = 0;
                LOG.println(F("[SLEEP] deep -> light"));
              }
            }
            if (epHR > 0) { sesHR += epHR; sesHRn++; }
            if (epBR > 0) { sesBR += epBR; sesBRn++; }
          }
        }
      }
      if (oobRun >= max(1, g_set.exit_s / SLEEP_EPOCH_SEC)) {               // ---- auto end ----
        // Keep every session that was long enough, EVEN with 0 minutes asleep:
        // a long "all awake" session is real data (and tells us the staging
        // missed the sleep). It used to be thrown away here, silently.
        if (bedMin - oobRun >= max(1, g_set.min_sess)) {
          buildReport(outRep, oobRun); repReady = true;
          if (deepMin + lightMin == 0) LOG.println(F("[SLEEP] session saved with no sleep detected"));
        } else LOG.printf("[SLEEP] session too short (%d min in bed), discarded\n", bedMin - oobRun);
        resetSession();
      }
    }
    epStart = now; nSamp = 0; sumRange = 0; bursts = 0;
    presCnt = bedCnt = 0; sumHR = sumBR = 0; nHR = nBR = 0;
    memset(ssVote, 0, sizeof(ssVote));
  }

  outLive.active  = sOn;     outLive.stage    = stage;
  outLive.bedMin  = bedMin;  outLive.deepMin  = deepMin;
  outLive.lightMin= lightMin;outLive.awakeMin = awakeMin;
  outLive.sleepMin= deepMin + lightMin;
  outLive.onsetMin= onset;   outLive.wakes    = wakes;  outLive.turns = turns;
  outLive.score   = scoreOf(bedMin, deepMin + lightMin, deepMin, wakes);
  outLive.start   = startTs;
}
