// Sleep data: the ONLY health data that is stored (docs/DESIGN.md §5).
//
// 1. Ingest: the sensor publishes one summary per SESSION (bed in -> bed out)
//    on <p>/<d>/session (DEVICE-DATA.md §4). We store it and ALWAYS answer
//    on <p>/<d>/session/ack {"sid":N}, even for a duplicate, a rejected
//    message or an unclaimed sensor, so the sensor can clear its flash queue.
//
// 2. Nights: worked out when read (API.md §4), never stored:
//    hide short sessions -> merge sessions < merge gap apart -> date each
//    group by the device's cut-off in the session's own time zone -> the
//    longest group on a date is the main sleep, the others are naps.
//    Owner decision (4 Nov): a date with ONLY naps has NO main sleep. A group
//    counts as a main sleep only if it is at least app_settings.main_sleep_min
//    in bed (default 180, admin-editable on the Sleep rules screen).
const { DateTime } = require('luxon');
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');

// ---- 1. ingest ---------------------------------------------------------
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const numIn = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null);

// Returns {row} or {err}. Numbers outside the DB's ranges become NULL (the
// full message is kept in `raw`); a broken sid/start/end/hyp rejects it.
function validate(m) {
  if (!Number.isInteger(m.start) || !Number.isInteger(m.end)) return { err: 'start/end must be unix seconds' };
  if (m.end <= m.start) return { err: 'end must be after start' };
  if (m.end - m.start > 24 * 3600) return { err: 'session longer than 24 h' };
  if (m.start < 1_600_000_000 || m.end > Date.now() / 1000 + 3600) return { err: 'start/end out of range (clock not synced?)' };
  const hyp = m.hyp ?? '';
  if (typeof hyp !== 'string' || !/^[DLAO]*$/.test(hyp) || hyp.length > 1440) return { err: 'hyp must be D/L/A/O letters' };
  const epochS = m.epoch_s === undefined ? 300 : m.epoch_s;
  if (![60, 300].includes(epochS)) return { err: 'epoch_s must be 60 or 300' };
  const sleepMin = intIn(m.sleep_min, 0, 1440);
  const durMin = Math.round((m.end - m.start) / 60);
  return {
    row: {
      started_at: new Date(m.start * 1000), ended_at: new Date(m.end * 1000),
      score: intIn(m.score, 0, 100), sleep_min: sleepMin !== null && sleepMin <= durMin + 1 ? sleepMin : null,
      wake_min: intIn(m.wake_min, 0, 1440), light_pct: intIn(m.light_pct, 0, 100), deep_pct: intIn(m.deep_pct, 0, 100),
      oob_min: intIn(m.oob_min, 0, 1440), exits: intIn(m.exits, 0, 32767), turns: intIn(m.turns, 0, 32767),
      big_mv_pct: intIn(m.big_mv_pct, 0, 100), small_mv_pct: intIn(m.small_mv_pct, 0, 100),
      apnea: intIn(m.apnea, 0, 32767), struggles: intIn(m.struggles, 0, 32767),
      hr_avg: intIn(Math.round(m.hr_avg), 20, 250), hr_min: intIn(m.hr_min, 20, 250), hr_max: intIn(m.hr_max, 20, 250),
      br_avg: numIn(m.br_avg, 0, 60), br_min: numIn(m.br_min, 0, 60), br_max: numIn(m.br_max, 0, 60),
      epoch_s: epochS, hyp, fw_version: typeof m.fw === 'string' ? m.fw.slice(0, 40) : null,
    },
  };
}

const ack = (mac, body) => mqtt.publish(mac, 'session/ack', body, { qos: 1 })
  .catch((err) => log.warn({ err: err.message, mac }, 'session ack not sent'));

async function onSession(mac, payload) {
  let m;
  try { m = JSON.parse(payload.toString()); } catch { m = null; }
  const sid = m && Number.isInteger(m.sid) && m.sid >= 0 ? m.sid : null;
  const dev = await db.one('SELECT id, owner_id, vendor_id, claim_stage, timezone FROM devices WHERE mqtt_username = $1', [mac]);
  if (!dev) return;
  if (sid === null) {
    // Can't be acked without a sid: record it so support can see the bug.
    await db.query(`INSERT INTO device_events (device_id, type, severity, message) VALUES ($1, 'session_received', 'warning', $2)`,
      [dev.id, 'session without a valid sid was dropped']);
    return;
  }
  if (dev.claim_stage !== 'owned' && dev.claim_stage !== 'vendor_use') {
    // Nobody uses this sensor (factory, or vendor stock, 009): drop it, but ack so the flash queue empties.
    // Log it, so a test sensor that was never claimed doesn't look like it "sent nothing".
    const len = m && Number.isInteger(m.start) && Number.isInteger(m.end) ? `${Math.round((m.end - m.start) / 60)} min ` : '';
    await db.query(`INSERT INTO device_events (device_id, type, severity, message, data) VALUES ($1, 'session_received', 'warning', $2, $3)`,
      [dev.id, `${len}session dropped: sensor is not in use by a customer (${dev.claim_stage})`, JSON.stringify({ sid })]);
    return ack(mac, { sid });
  }
  const v = validate(m);
  if (v.err) {
    await db.query(`INSERT INTO device_events (device_id, type, severity, message, data) VALUES ($1, 'session_received', 'warning', $2, $3)`,
      [dev.id, `session rejected: ${v.err}`, JSON.stringify({ sid })]);
    return ack(mac, { sid, ok: 0, err: v.err });
  }
  const r = v.row;
  const ins = await db.query(
    `INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, score, sleep_min, wake_min, light_pct,
       deep_pct, oob_min, exits, turns, big_mv_pct, small_mv_pct, apnea, struggles, hr_avg, hr_min, hr_max,
       br_avg, br_min, br_max, epoch_s, hyp, fw_version, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT (device_id, started_at) DO NOTHING`,
    [dev.id, sid, r.started_at, r.ended_at, dev.timezone, r.score, r.sleep_min, r.wake_min, r.light_pct, r.deep_pct,
      r.oob_min, r.exits, r.turns, r.big_mv_pct, r.small_mv_pct, r.apnea, r.struggles, r.hr_avg, r.hr_min, r.hr_max,
      r.br_avg, r.br_min, r.br_max, r.epoch_s, r.hyp, r.fw_version, JSON.stringify(m)]);
  if (ins.rowCount) {
    await db.query(`INSERT INTO device_events (device_id, type, message, data) VALUES ($1, 'session_received', $2, $3)`,
      [dev.id, `${Math.round((m.end - m.start) / 60)} min`, JSON.stringify({ sid })]);
  }
  return ack(mac, { sid });
}

function start() {
  mqtt.on('session', onSession);
}

// ---- 2. nights ---------------------------------------------------------
const minutes = (a, b) => (new Date(b) - new Date(a)) / 60000;

async function rules(deviceId) {
  return db.one(
    `SELECT a.merge_gap_min, a.min_session_min, a.main_sleep_min, d.sleep_cutoff, d.timezone, d.place
       FROM app_settings a, devices d WHERE a.id = 1 AND d.id = $1`, [deviceId]);
}

// Sleep date of a group: the local date of its start, minus one day when it
// started before the cut-off (23:00 2 Nov and 01:00 3 Nov both -> 2026-11-02).
function sleepDateOf(startedAt, tz, cutoff) {
  const local = DateTime.fromJSDate(new Date(startedAt), { zone: tz });
  const [ch, cm] = cutoff.split(':').map(Number);
  const beforeCutoff = local.hour * 60 + local.minute < ch * 60 + cm;
  return (beforeCutoff ? local.minus({ days: 1 }) : local).toISODate();
}

// Sessions (sorted by start) -> groups of sessions less than gapMin apart.
function mergeGroups(sessions, gapMin) {
  const groups = [];
  for (const s of sessions) {
    const g = groups[groups.length - 1];
    if (g && minutes(g[g.length - 1].ended_at, s.started_at) < gapMin) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

// Average of field weighted by session length, skipping NULLs.
function weighted(group, field, digits = 0) {
  let sum = 0;
  let w = 0;
  for (const s of group) {
    if (s[field] == null) continue;
    const len = minutes(s.started_at, s.ended_at);
    sum += Number(s[field]) * len;
    w += len;
  }
  if (!w) return null;
  const f = 10 ** digits;
  return Math.round((sum / w) * f) / f;
}
const sumOf = (group, field) => (group.some((s) => s[field] != null)
  ? group.reduce((a, s) => a + (s[field] == null ? 0 : Number(s[field])), 0) : null);
const minOf = (group, field) => {
  const v = group.map((s) => s[field]).filter((x) => x != null).map(Number);
  return v.length ? Math.min(...v) : null;
};
const maxOf = (group, field) => {
  const v = group.map((s) => s[field]).filter((x) => x != null).map(Number);
  return v.length ? Math.max(...v) : null;
};

// ---- server-side sleep-architecture rules (14 Nov) --------------------
// The device stages minute by minute and can't see the whole night. Applied
// when a night is READ (the stored hyp is never changed, so this can be tuned
// or switched off and every past night follows):
//  1. Sleep onset = the first minute asleep that starts ONSET_MIN minutes of
//     settled sleep (at most ONSET_AWAKE awake minutes in that window, none
//     out of bed). Light or deep before it is "lying still but awake" -> Awake.
//  2. Deep blocks less than MERGE_GAP light minutes apart are one deep period.
//  3. Deep shorter than DEEP_MIN is noise -> Light.
//  4. One deep period per ~90 min sleep cycle (the longest), and after the
//     first LATE_MIN minutes of sleep only deep of LATE_DEEP_MIN or more.
//     Real nights have about 3-5 deep periods, mostly in the first half.
const ARCH = { ONSET_MIN: 30, ONSET_AWAKE: 2, MERGE_GAP: 8, DEEP_MIN: 5, CYCLE_MIN: 90, LATE_MIN: 270, LATE_DEEP_MIN: 15 };

function refineHyp(hyp, epochS) {
  const em = epochS / 60;
  const n = (min) => Math.max(1, Math.round(min / em));
  const a = [...(hyp || '')];
  const asleep = (c) => c === 'D' || c === 'L';
  // 1. sleep onset
  let onset = -1;
  const win = n(ARCH.ONSET_MIN);
  for (let i = 0; i < a.length && onset < 0; i++) {
    if (!asleep(a[i])) continue;
    const w = a.slice(i, i + win);
    const awake = w.filter((c) => c === 'A').length;
    // settled: enough window left (or the night ends asleep), few awake minutes, no bed exit
    if (!w.includes('O') && awake * em <= ARCH.ONSET_AWAKE && (w.length === win || i + w.length === a.length)) onset = i;
  }
  for (let i = 0; i < (onset < 0 ? a.length : onset); i++) if (asleep(a[i])) a[i] = 'A';
  if (onset < 0) return a.join('');
  const deepRuns = () => {
    const out = [];
    for (let i = 0; i < a.length;) {
      if (a[i] !== 'D') { i++; continue; }
      let j = i;
      while (j < a.length && a[j] === 'D') j++;
      out.push({ i, j });
      i = j;
    }
    return out;
  };
  // 2. merge deep blocks separated by a short stretch of light only
  let runs = deepRuns();
  for (let k = 1; k < runs.length; k++) {
    const gap = a.slice(runs[k - 1].j, runs[k].i);
    if (gap.length <= n(ARCH.MERGE_GAP) && gap.every((c) => c === 'L')) for (let x = runs[k - 1].j; x < runs[k].i; x++) a[x] = 'D';
  }
  // 3 + 4. noise, one deep period per cycle, late-night minimum
  runs = deepRuns();
  const toLight = (r) => { for (let x = r.i; x < r.j; x++) a[x] = 'L'; };
  const best = new Map();
  for (const r of runs) {
    const len = r.j - r.i;
    const late = r.i - onset >= n(ARCH.LATE_MIN);
    if (len < n(ARCH.DEEP_MIN) || (late && len < n(ARCH.LATE_DEEP_MIN))) { toLight(r); continue; }
    const c = Math.floor((r.i - onset) / n(ARCH.CYCLE_MIN));
    const b = best.get(c);
    if (!b) best.set(c, r);
    else if (len > b.j - b.i) { toLight(b); best.set(c, r); } else toLight(r);
  }
  return a.join('');
}

// One group -> the night fields of API.md §4 (calculation table).
function summarize(group) {
  // Firmware 2.4.0 sends 1-minute steps (epoch_s 60), older firmware 5-minute
  // steps. A night joining both uses the finer step; coarse letters are repeated.
  const epochS = Math.min(...group.map((s) => s.epoch_s || 300));
  const fit = (s) => (s.hyp || '').replace(/./g, (ch) => ch.repeat(Math.max(1, Math.round((s.epoch_s || 300) / epochS))));
  let hyp = '';
  let gapMin = 0;
  group.forEach((s, i) => {
    if (i > 0) {
      const gap = minutes(group[i - 1].ended_at, s.started_at);
      gapMin += gap;
      hyp += 'O'.repeat(Math.max(0, Math.round((gap * 60) / epochS)));
    }
    hyp += fit(s);
  });
  const asleepIn = (h) => [...h].filter((x) => x === 'D' || x === 'L').length;
  const rawAsleep = asleepIn(hyp);
  hyp = refineHyp(hyp, epochS);
  const count = (ch) => [...hyp].filter((x) => x === ch).length;
  const toMin = (n) => Math.round((n * epochS) / 60);
  const start = group[0].started_at;
  const end = group[group.length - 1].ended_at;
  // The device's own sleep minutes, minus what the onset rule turned into Awake
  const devSleep = sumOf(group, 'sleep_min');
  const totalSleepMin = devSleep != null
    ? Math.max(0, devSleep - toMin(rawAsleep - asleepIn(hyp))) : toMin(count('D') + count('L'));
  // wake-ups = runs of A after the first D/L
  const firstSleep = hyp.search(/[DL]/);
  const wakeUps = firstSleep < 0 ? 0 : (hyp.slice(firstSleep).match(/A+/g) || []).length;
  return {
    start, end,
    score: weighted(group, 'score'),
    totalSleepMin,
    inBedMin: Math.round(group.reduce((a, s) => a + minutes(s.started_at, s.ended_at), 0)),
    stageMin: { deep: toMin(count('D')), light: toMin(count('L')), awake: toMin(count('A')), outOfBed: toMin(count('O')) },
    sessionCount: group.length,
    efficiencyPct: Math.round((100 * totalSleepMin) / Math.max(1, minutes(start, end))),
    wakeUps,
    exits: sumOf(group, 'exits'),
    oobMin: Math.round((sumOf(group, 'oob_min') || 0) + gapMin),
    sessions: group.map((s) => ({ id: s.id, start: s.started_at, end: s.ended_at })),
    epochS, hyp,
    hr: { avg: weighted(group, 'hr_avg'), min: minOf(group, 'hr_min'), max: maxOf(group, 'hr_max') },
    br: { avg: weighted(group, 'br_avg', 1), min: minOf(group, 'br_min'), max: maxOf(group, 'br_max') },
    turns: sumOf(group, 'turns'),
    bigMvPct: weighted(group, 'big_mv_pct'),
    smallMvPct: weighted(group, 'small_mv_pct'),
    apnea: sumOf(group, 'apnea'),
    struggles: sumOf(group, 'struggles'),
  };
}

// All nights whose sleep date is in [fromDate, toDate] (YYYY-MM-DD), newest first.
// Each: {sleepDate, main: summary, naps: [summary]}.
async function nights(deviceId, fromDate, toDate) {
  const r = await rules(deviceId);
  const cutoff = r.sleep_cutoff.slice(0, 5);
  // Generous window in UTC: a sleep date can start up to ~1.5 days earlier
  // or later in UTC than its date, and a merged group can run up to 24 h+.
  const { rows } = await db.query(
    `SELECT * FROM sleep_sessions WHERE device_id = $1
        AND started_at >= ($2::date - interval '2 days') AND started_at < ($3::date + interval '3 days')
        AND ended_at - started_at >= make_interval(mins => $4)
      ORDER BY started_at`, [deviceId, fromDate, toDate, r.min_session_min]);
  const byDate = new Map();
  for (const g of mergeGroups(rows, r.merge_gap_min)) {
    const date = sleepDateOf(g[0].started_at, g[0].timezone || r.timezone, cutoff);
    if (date < fromDate || date > toDate) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(summarize(g));
  }
  const out = [];
  for (const [sleepDate, groups] of byDate) {
    groups.sort((a, b) => minutes(b.start, b.end) - minutes(a.start, a.end));
    const main = groups[0].inBedMin >= r.main_sleep_min ? groups[0] : null;
    const naps = (main ? groups.slice(1) : groups).sort((a, b) => new Date(a.start) - new Date(b.start));
    out.push({ sleepDate, main, naps });
  }
  return out.sort((a, b) => (a.sleepDate < b.sleepDate ? 1 : -1));
}

// A nap-only date: hasMainSleep false, every main-sleep field null, naps listed.
const EMPTY_MAIN = {
  start: null, end: null, score: null, totalSleepMin: null, inBedMin: null, stageMin: null, sessionCount: 0,
  efficiencyPct: null, wakeUps: null, exits: null, oobMin: null, sessions: [], epochS: null, hyp: null,
  hr: null, br: null, turns: null, bigMvPct: null, smallMvPct: null, apnea: null, struggles: null,
};

const nightCard = (n) => {
  const m = n.main || EMPTY_MAIN;
  return {
    sleepDate: n.sleepDate, hasMainSleep: !!n.main, start: m.start, end: m.end, score: m.score,
    totalSleepMin: m.totalSleepMin, inBedMin: m.inBedMin, stageMin: m.stageMin,
    sessionCount: m.sessionCount, naps: n.naps.map((x) => ({ start: x.start, end: x.end })),
  };
};

function nightDetail(n) {
  const { start, end, score, totalSleepMin, inBedMin, stageMin, sessionCount, ...rest } = n.main || EMPTY_MAIN;
  return {
    sleepDate: n.sleepDate, hasMainSleep: !!n.main, start, end, score, totalSleepMin, inBedMin, stageMin, sessionCount,
    naps: n.naps.map((x) => ({ start: x.start, end: x.end, totalSleepMin: x.totalSleepMin, hyp: x.hyp })),
    efficiencyPct: rest.efficiencyPct, wakeUps: rest.wakeUps, exits: rest.exits, oobMin: rest.oobMin,
    sessions: rest.sessions, epochS: rest.epochS, hyp: rest.hyp, hr: rest.hr, br: rest.br, turns: rest.turns,
    bigMvPct: rest.bigMvPct, smallMvPct: rest.smallMvPct, apnea: rest.apnea, struggles: rest.struggles,
  };
}

// Averages over main sleeps (the four tiles on Sleep history); nap-only
// dates don't count.
function averages(all) {
  const list = all.filter((n) => n.main);
  const avg = (f) => {
    const v = list.map(f).filter((x) => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const wake = list.map((n) => n.main.wakeUps);
  return {
    nights: list.length,
    totalSleepMin: avg((n) => n.main.totalSleepMin),
    score: avg((n) => n.main.score),
    hrAvg: avg((n) => n.main.hr.avg),
    wakeUps: wake.length ? Math.round((wake.reduce((a, b) => a + b, 0) / wake.length) * 10) / 10 : null,
  };
}

// Today's date where the sensor is (used for "last N days").
async function localToday(deviceId) {
  const r = await rules(deviceId);
  return DateTime.now().setZone(r.timezone).toISODate();
}

// For the device card: the most recent main sleep in the last 3 days, or null.
async function lastNight(deviceId) {
  const today = await localToday(deviceId);
  const from = DateTime.fromISO(today).minus({ days: 3 }).toISODate();
  const n = (await nights(deviceId, from, today)).find((x) => x.main);
  return n ? { sleepDate: n.sleepDate, score: n.main.score, totalSleepMin: n.main.totalSleepMin } : null;
}

module.exports = {
  start, onSession, validate, nights, nightCard, nightDetail, averages, localToday, lastNight, rules,
  _internal: { sleepDateOf, mergeGroups, summarize, refineHyp, ARCH },
};
