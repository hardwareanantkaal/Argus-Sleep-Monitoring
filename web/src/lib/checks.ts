// Bench checks for the manufacturing station (docs/API.md §9b, docs/MANUFACTURING.md §2).
// Fed with the board's serial output, line by line. Matches what firmware/sleeplamp prints
// (sleeplamp.ino setup() and printTelemetry(), Sensor.ino "[RADAR] link up"), and the serial
// contract for the fall detector firmware (docs/MANUFACTURING.md §2a):
//   ===== Argus Fall Detection v0.1.0 booting (partition app0) =====
//   [Argus] deviceId: 348518a10f22
//   [RADAR] link up                      (first good IWR6843 frame after the cfg was sent)
//   [FALL] radar:OK presence:1 tracks:1 preset:MED heap:182344 mqtt:connected   (every 5 s)
// No browser APIs, so it can be tested with plain Node (web/test/checks.test.mts).

export type Product = 'sleep' | 'fall';
export type CheckId = 'boot' | 'product' | 'version' | 'mac' | 'heap' | 'radar' | 'presence';
export interface CheckDef { id: CheckId; label: string; hint: string }
const PRODUCT_NAME: Record<Product, string> = { sleep: 'Sleep Monitoring', fall: 'Fall Detection' };
/** The tests for one product, in the order they are shown and saved. */
export function checksFor(product: Product): CheckDef[] {
  const fall = product === 'fall';
  return [
    { id: 'boot', label: 'Boots', hint: 'Banner line within 10 s' },
    { id: 'product', label: 'Firmware type', hint: `Banner says “${PRODUCT_NAME[product]}”` },
    { id: 'version', label: 'Firmware version', hint: 'Same as the flashed release' },
    { id: 'mac', label: 'Device ID', hint: 'Same MAC as read over USB' },
    { id: 'heap', label: 'Free memory', hint: 'At least 40 000 bytes' },
    { id: 'radar', label: 'Radar link', hint: fall ? 'IWR6843 sends frames within 60 s' : 'C1001 answers within 60 s' },
    { id: 'presence', label: 'Presence', hint: fall ? 'Walk in front of the radar, within 30 s' : 'Sit or wave in front, within 30 s' },
  ];
}
/** Sleep monitor tests (kept for older callers). */
export const CHECKS = checksFor('sleep');

export const LIMITS = { bootS: 10, macS: 15, heapS: 25, radarS: 60, presenceS: 30, minHeap: 40000 };

const RE = {
  banner: /=====\s.*?\bv(\S+)\s+booting/,
  devId: /\[Argus\]\s*deviceId:\s*([0-9a-fA-F:]{12,17})/,
  radarUp: /\[RADAR\]\s*link up/,
  telem: /radar:(OK|DOWN)\s+presence:(\d+)/,
  vitals: /HR:(\d+)\s*bpm\s+resp:(\d+)/,
  heap: /heap:(\d+)/,
  mqtt: /mqtt:(\w+)/,
  tracks: /tracks:(\d+)/,
  preset: /preset:(LOW|MED|HIGH)\b/,
  fallBanner: /Fall Detection/i,
  crash: /Guru Meditation|Backtrace:|abort\(\) was called|Brownout detector/i,
};

export type CheckState = 'wait' | 'run' | 'ok' | 'bad' | 'skip';
export interface CheckStatus { ok: boolean | null; state: CheckState; value: string; ms?: number }
export interface LiveVals { radar?: string; pr?: number; hr?: number; br?: number; heap?: number; mqtt?: string; tracks?: number; preset?: string }
export interface CheckResult { id: CheckId; ok: boolean | null; value?: string; ms?: number }

/** expect.version: the release the board should run. `from` says where it comes from: 'flashed' (flashed on
 *  this screen) or 'selected' (not flashed here: compared with the release chosen on the Flash tab).
 *  null: nothing to compare with, so the version read from the banner is only shown. */
export function createChecker(expect: { version: string | null; mac: string; from?: 'flashed' | 'selected'; product?: Product }) {
  const product: Product = expect.product || 'sleep';
  const CHECKS = checksFor(product);
  const macId = (expect.mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const ck = Object.fromEntries(CHECKS.map((c) => [c.id, { ok: null, state: 'wait', value: '' }])) as Record<CheckId, CheckStatus>;
  ck.boot.state = 'run';
  ck.radar.state = 'run';
  Object.assign(ck.version, { state: 'run', value: 'reading…' });
  const versionHint = !expect.version ? 'Version the board reports'
    : expect.from === 'selected' ? `Same as ${expect.version} (selected release)` : `Same as the flashed release (${expect.version})`;
  const vals: LiveVals = {};
  let presenceAt: number | null = null;

  const done = (s: CheckState) => s === 'ok' || s === 'bad' || s === 'skip';
  const set = (id: CheckId, ok: boolean, value: string, t?: number) => {
    if (done(ck[id].state)) return;
    Object.assign(ck[id], { ok, state: ok ? 'ok' : 'bad', value, ms: t != null ? Math.round(t * 1000) : undefined });
  };

  return {
    product,
    list: CHECKS,
    ck,
    vals,
    versionHint,
    /** One serial line; t = seconds since the board was reset. */
    feed(line: string, t: number) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(RE.banner))) {
        set('boot', true, `${t.toFixed(1)} s`, t);
        // Sleep firmware on a fall detector board (or the other way round) fails the board.
        const got: Product = RE.fallBanner.test(line) ? 'fall' : 'sleep';
        set('product', got === product, got === product ? PRODUCT_NAME[got] : `${PRODUCT_NAME[got]} firmware, not ${PRODUCT_NAME[product]}`, t);
        if (expect.version && m[1] === expect.version) set('version', true, `v${m[1]}`, t);
        // Flashed here and another version boots: fail. Not flashed here: only a warning, the board may run an older build.
        else if (expect.version && expect.from !== 'selected') set('version', false, `v${m[1]}, expected v${expect.version}`, t);
        else if (expect.version && ck.version.state === 'run') Object.assign(ck.version, { ok: null, state: 'skip', value: `v${m[1]} (not ${expect.version})` });
        else if (ck.version.state === 'run') Object.assign(ck.version, { ok: null, state: 'skip', value: `v${m[1]}` });
        if (ck.mac.state === 'wait') ck.mac.state = 'run';
      }
      if ((m = line.match(RE.devId))) {
        const got = m[1].replace(/:/g, '').toLowerCase();
        set('mac', got === macId, got, t);
      }
      if (RE.radarUp.test(line)) set('radar', true, `${Math.round(t)} s`, t);
      if ((m = line.match(RE.telem))) {
        vals.radar = m[1];
        vals.pr = Number(m[2]);
        if (m[1] === 'OK') set('radar', true, `${Math.round(t)} s`, t);
        if (presenceAt != null && vals.pr === 1) set('presence', true, `seen after ${Math.round(t - presenceAt)} s`, t);
      }
      if ((m = line.match(RE.vitals))) { vals.hr = Number(m[1]); vals.br = Number(m[2]); }
      if ((m = line.match(RE.heap))) {
        vals.heap = Number(m[1]);
        set('heap', vals.heap >= LIMITS.minHeap, `${vals.heap.toLocaleString('en-US')} B`, t);
      }
      if ((m = line.match(RE.mqtt))) vals.mqtt = m[1];
      if ((m = line.match(RE.tracks))) vals.tracks = Number(m[1]);
      if ((m = line.match(RE.preset))) vals.preset = m[1];
      // A crash, even after a good boot, fails the board.
      if (RE.crash.test(line)) Object.assign(ck.boot, { ok: false, state: 'bad', value: 'crashed' });
    },
    /** Call a few times a second: applies the time limits. */
    tick(t: number) {
      if (ck.boot.state === 'run' && t > LIMITS.bootS) set('boot', false, `no banner in ${LIMITS.bootS} s`, t);
      if (ck.version.state === 'run' && t > LIMITS.bootS) set('version', false, 'no banner', t);
      if (ck.product.state === 'wait' && t > LIMITS.bootS) set('product', false, 'no banner', t);
      if ((ck.mac.state === 'wait' || ck.mac.state === 'run') && t > LIMITS.macS) set('mac', false, 'no deviceId line', t);
      if (ck.heap.state === 'wait' && t > LIMITS.heapS) set('heap', false, 'no telemetry line', t);
      if (ck.radar.state === 'run' && t > LIMITS.radarS) set('radar', false, `no answer in ${LIMITS.radarS} s`, t);
      if (ck.presence.state === 'run' && presenceAt != null && t - presenceAt > LIMITS.presenceS) set('presence', false, `nothing in ${LIMITS.presenceS} s`, t);
    },
    startPresence(t: number) {
      presenceAt = t;
      Object.assign(ck.presence, { ok: null, state: 'run', value: 'sit in front now' });
      if (vals.pr === 1) set('presence', true, 'seen at once', t);
    },
    skipPresence() { Object.assign(ck.presence, { ok: null, state: 'skip', value: 'skipped by operator' }); },
    allPassed: () => CHECKS.every((c) => ck[c.id].state === 'ok' || ck[c.id].state === 'skip'),
    firstFailed: (): CheckId | null => CHECKS.find((c) => ck[c.id].state === 'bad')?.id || null,
    /** The list saved with the run (API 9.27). */
    toList: (): CheckResult[] => CHECKS.map((c) => ({
      id: c.id,
      ok: ck[c.id].state === 'ok' ? true : ck[c.id].state === 'bad' ? false : null,
      ...(ck[c.id].value ? { value: String(ck[c.id].value).slice(0, 200) } : {}),
      ...(ck[c.id].ms != null ? { ms: ck[c.id].ms } : {}),
    })),
  };
}
export type Checker = ReturnType<typeof createChecker>;
