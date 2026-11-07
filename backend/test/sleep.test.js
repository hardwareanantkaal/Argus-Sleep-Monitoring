// Step 6: sleep sessions in, nights and naps out (docs/API.md §4, §11 session).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, registered, insertDevice, mqttConnect, sleep } = require('./helpers');

const open = [];
after(async () => {
  for (const c of open) { try { c.end(true); } catch { /* closed */ } }
  await db.end();
});

// A sensor that listens for its session/ack. send(msg) resolves with the ack.
async function sensor(mac) {
  const c = await mqttConnect(mac);
  open.push(c);
  await c.subscribeAsync(`argus/${mac}/session/ack`, { qos: 1 });
  const acks = [];
  c.on('message', (t, p) => acks.push(JSON.parse(p.toString())));
  return {
    async send(msg) {
      const before = acks.length;
      await c.publishAsync(`argus/${mac}/session`, JSON.stringify(msg), { qos: 1 });
      for (let i = 0; i < 40 && acks.length === before; i += 1) await sleep(50);
      return acks[before];
    },
  };
}

const now = Math.floor(Date.now() / 1000);
const session = (extra = {}) => ({
  sid: 1, start: now - 8 * 3600, end: now - 3600, score: 82, sleep_min: 380, wake_min: 18, light_pct: 58, deep_pct: 34,
  oob_min: 9, exits: 1, turns: 14, big_mv_pct: 6, small_mv_pct: 21, apnea: 0, hr_avg: 61, hr_min: 52, hr_max: 78,
  br_avg: 14, br_min: 11, br_max: 19, struggles: 0, hyp: 'AALLLDDDLLDDDLLALL', fw: '1.0.0', ...extra,
});

test('a session is stored once and always acked (re-sends too)', async () => {
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  await db.query("UPDATE devices SET timezone = 'America/New_York' WHERE id = $1", [d.id]);
  const s = await sensor(d.mac);
  assert.deepEqual(await s.send(session({ sid: 128 })), { sid: 128 });
  assert.deepEqual(await s.send(session({ sid: 128 })), { sid: 128 }, 'duplicate still acked');
  const { rows } = await db.query('SELECT sid, timezone, score, hr_min, hyp, raw FROM sleep_sessions WHERE device_id = $1', [d.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].sid, rows[0].timezone, rows[0].score, rows[0].hr_min, rows[0].hyp],
    [128, 'America/New_York', 82, 52, 'AALLLDDDLLDDDLLALL']);
  assert.equal(rows[0].raw.sid, 128, 'raw message kept');
});

test('a broken session is rejected but still acked, with the reason', async () => {
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  const s = await sensor(d.mac);
  const a = await s.send(session({ sid: 5, hyp: 'LLRR' }));
  assert.deepEqual([a.sid, a.ok], [5, 0]);
  assert.match(a.err, /hyp/);
  assert.equal((await db.query('SELECT 1 FROM sleep_sessions WHERE device_id = $1', [d.id])).rowCount, 0);
  const ev = await db.query("SELECT severity, message FROM device_events WHERE device_id = $1 AND type = 'session_received'", [d.id]);
  assert.equal(ev.rows[0].severity, 'warning');
});

test('out-of-range numbers are stored as NULL, the session is kept', async () => {
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  const s = await sensor(d.mac);
  assert.deepEqual(await s.send(session({ sid: 9, score: 150, hr_max: 999 })), { sid: 9 });
  const { rows: [r] } = await db.query('SELECT score, hr_max, hr_avg FROM sleep_sessions WHERE device_id = $1', [d.id]);
  assert.deepEqual(r, { score: null, hr_max: null, hr_avg: 61 });
});

test('an unclaimed sensor gets an ack but nothing is stored', async () => {
  const d = await insertDevice();
  const s = await sensor(d.mac);
  assert.deepEqual(await s.send(session({ sid: 3 })), { sid: 3 });
  assert.equal((await db.query('SELECT 1 FROM sleep_sessions WHERE device_id = $1', [d.id])).rowCount, 0);
  const { rows: [ev] } = await db.query(`SELECT severity, message FROM device_events WHERE device_id = $1 AND type = 'session_received'`, [d.id]);
  assert.equal(ev.severity, 'warning');
  assert.match(ev.message, /session dropped: sensor is not in use/);
});

// ---- grouping into nights (fixed data, Asia/Kolkata = UTC+5:30) --------
async function addSession(deviceId, startIso, endIso, extra = {}) {
  const e = { score: null, sleep_min: null, hr_avg: null, hr_min: null, hr_max: null, hyp: '', oob_min: null, epoch_s: 300, ...extra };
  await db.query(
    `INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, score, sleep_min, hr_avg, hr_min, hr_max,
       hyp, oob_min, epoch_s, raw)
     VALUES ($1, 0, $2, $3, 'Asia/Kolkata', $4, $5, $6, $7, $8, $9, $10, $11, '{}')`,
    [deviceId, startIso, endIso, e.score, e.sleep_min, e.hr_avg, e.hr_min, e.hr_max, e.hyp, e.oob_min, e.epoch_s]);
}

async function nightsFixture() {
  const owner = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await db.query("UPDATE devices SET timezone = 'Asia/Kolkata', place = 'Surat' WHERE id = $1", [d.id]);
  // Night of 10 Oct: A 22:40–02:10 IST, gap 20 min, B 02:30–06:30 IST  -> merged
  await addSession(d.id, '2026-10-10T17:10Z', '2026-10-10T20:40Z',
    { score: 80, sleep_min: 170, hr_avg: 60, hr_min: 50, hr_max: 75, hyp: 'AA' + 'L'.repeat(20) + 'D'.repeat(20) });
  await addSession(d.id, '2026-10-10T21:00Z', '2026-10-11T01:00Z',
    { score: 70, sleep_min: 200, hr_avg: 54, hr_min: 47, hr_max: 70, hyp: 'L'.repeat(20) + 'AAAA' + 'D'.repeat(20) + 'LLLL' });
  await addSession(d.id, '2026-10-11T02:30Z', '2026-10-11T02:45Z');           // 08:00–08:15 IST, 15 min: hidden
  await addSession(d.id, '2026-10-10T09:30Z', '2026-10-10T10:20Z', { sleep_min: 40, hyp: 'L'.repeat(10) }); // 15:00 IST nap
  // Night of 12 Oct: C 23:00–05:00 IST, gap 40 min (>= 30), D 05:40–07:00 IST -> D is a nap
  await addSession(d.id, '2026-10-12T17:30Z', '2026-10-12T23:30Z', { sleep_min: 330 });
  await addSession(d.id, '2026-10-13T00:10Z', '2026-10-13T01:30Z', { sleep_min: 70 });
  // 14 Oct: only a 15:00–15:40 IST nap (40 min) -> no main sleep that date
  await addSession(d.id, '2026-10-14T09:30Z', '2026-10-14T10:10Z', { score: 99, sleep_min: 35 });
  return { owner, d };
}

test('nights: merge < 30 min, hide < 25 min, noon cut-off, main sleep vs naps', async () => {
  const { owner, d } = await nightsFixture();
  const r = await owner.c.get(`/devices/${d.id}/nights?from=2026-10-10&to=2026-10-12`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.device, { tz: 'Asia/Kolkata', place: 'Surat' });
  assert.deepEqual(r.body.nights.map((n) => [n.sleepDate, n.sessionCount, n.naps.length]),
    [['2026-10-12', 1, 1], ['2026-10-10', 2, 1]], 'newest first; 11 Oct has only a hidden session');

  const n10 = r.body.nights[1];
  assert.equal(n10.start, '2026-10-10T17:10:00.000Z');
  assert.equal(n10.end, '2026-10-11T01:00:00.000Z');
  assert.equal(n10.inBedMin, 450);          // 210 + 240
  assert.equal(n10.totalSleepMin, 370);     // 170 + 200
  assert.equal(n10.score, 75);              // (80*210 + 70*240) / 450 = 74.7
  assert.deepEqual(n10.stageMin, { deep: 200, light: 220, awake: 30, outOfBed: 20 }); // gap = 4 x 5-min 'O'
  assert.deepEqual(n10.naps, [{ start: '2026-10-10T09:30:00.000Z', end: '2026-10-10T10:20:00.000Z' }]);
  assert.equal(r.body.averages.nights, 2);
});

test('night detail: joined hypnogram, wake-ups, efficiency, weighted HR', async () => {
  const { owner, d } = await nightsFixture();
  const n = (await owner.c.get(`/devices/${d.id}/nights/2026-10-10`)).body;
  assert.equal(n.hyp.length, 42 + 4 + 48, 'session A + 4 gap letters + session B');
  assert.equal(n.hyp.slice(42, 46), 'OOOO');
  assert.equal(n.wakeUps, 1, 'the AA before first sleep does not count');
  assert.equal(n.efficiencyPct, 79);        // 370 / 470 min from start to end
  assert.equal(n.oobMin, 20);               // the gap
  assert.deepEqual(n.hr, { avg: 57, min: 47, max: 75 }); // (60*210 + 54*240) / 450 = 56.8
  assert.deepEqual(n.sessions.length, 2);
  assert.equal(n.naps[0].totalSleepMin, 40);
  assert.equal((await owner.c.get(`/devices/${d.id}/nights/2026-10-11`)).status, 404);
});

test('admin sleep rules and the device cut-off change the grouping', async () => {
  const { owner, d } = await nightsFixture();
  const before = (await db.query('SELECT merge_gap_min FROM app_settings')).rows[0].merge_gap_min;
  try {
    await db.query('UPDATE app_settings SET merge_gap_min = 45');
    const n12 = (await owner.c.get(`/devices/${d.id}/nights/2026-10-12`)).body;
    assert.deepEqual([n12.sessionCount, n12.naps.length], [2, 0], 'a 40-min gap now merges');
  } finally {
    await db.query('UPDATE app_settings SET merge_gap_min = $1', [before]);
  }
  await db.query("UPDATE devices SET sleep_cutoff = '18:00' WHERE id = $1", [d.id]);
  const r = await owner.c.get(`/devices/${d.id}/nights?from=2026-10-09&to=2026-10-10`);
  assert.deepEqual(r.body.nights.map((n) => n.sleepDate), ['2026-10-10', '2026-10-09'],
    'with an 18:00 cut-off the 15:00 nap belongs to 9 Oct');
});

test('history needs history.view; the device card shows last night', async () => {
  const owner = await registered();
  const fam = await registered();
  const stranger = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await db.query('INSERT INTO device_shares (device_id, user_id) VALUES ($1, $2)', [d.id, fam.user.id]);
  await db.query("INSERT INTO device_share_permissions VALUES ($1, $2, 'live.view')", [d.id, fam.user.id]);
  await db.query(
    `INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, score, sleep_min, raw)
     VALUES ($1, 1, now() - interval '9 hours', now() - interval '1 hour', 'Asia/Kolkata', 81, 420, '{}')`, [d.id]);
  assert.equal((await fam.c.get(`/devices/${d.id}/nights`)).status, 403);
  assert.equal((await stranger.c.get(`/devices/${d.id}/nights`)).status, 404);
  const card = (await owner.c.get('/devices')).body.items.find((x) => x.id === d.id);
  assert.deepEqual([card.lastNight.score, card.lastNight.totalSleepMin], [81, 420]);
  const famCard = (await fam.c.get('/devices')).body.items.find((x) => x.id === d.id);
  assert.equal(famCard.lastNight, null, 'no history.view, no last night');
  const r = await owner.c.get(`/devices/${d.id}/nights?days=3`);
  assert.equal(r.body.nights.length, 1);
  assert.equal((await owner.c.get(`/devices/${d.id}/nights?from=2026-02-30`)).status, 400);
});

test('a date with only naps has no main sleep (owner decision 4 Nov)', async () => {
  const { owner, d } = await nightsFixture();
  const r = await owner.c.get(`/devices/${d.id}/nights?from=2026-10-10&to=2026-10-14`);
  const n14 = r.body.nights.find((n) => n.sleepDate === '2026-10-14');
  assert.deepEqual([n14.hasMainSleep, n14.score, n14.totalSleepMin, n14.sessionCount, n14.naps.length], [false, null, null, 0, 1]);
  assert.deepEqual(r.body.nights.filter((n) => n.hasMainSleep).map((n) => n.sleepDate), ['2026-10-12', '2026-10-10']);
  assert.equal(r.body.averages.nights, 2, 'the nap-only date is not averaged');
  assert.notEqual(r.body.averages.score, 99);
  const det = (await owner.c.get(`/devices/${d.id}/nights/2026-10-14`)).body;
  assert.deepEqual([det.hasMainSleep, det.hyp, det.naps[0].totalSleepMin], [false, null, 35]);
});

test('last night on the card skips a nap-only day', async () => {
  const owner = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await db.query(
    `INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, score, sleep_min, raw)
     VALUES ($1, 1, now() - interval '2 hours', now() - interval '1 hour', 'Asia/Kolkata', 90, 50, '{}')`, [d.id]);
  const card = (await owner.c.get('/devices')).body.items.find((x) => x.id === d.id);
  assert.equal(card.lastNight, null, 'a 1-hour nap is not "last night"');
});
