// Bench checks for the manufacturing station, fed with real sleeplamp serial lines.
// Run: node --experimental-strip-types --test test/checks.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker } from '../src/lib/checks.ts';

const BOOT = [
  '===== Argus Sleep Monitoring v2.4.0 booting (partition app0) =====',
  '[Argus] deviceId: 348518a10f22',
  '[RADAR] link up, sleep mode active',
  'radar:OK  presence:0  bed:out  radarState:ok  motion:none  range:0',
  'SLEEP[engine] onset:0m  wakes:0  turns:0  liveScore:0   mqtt:down  heap:182344',
];

test('a good board passes every check once presence is seen', () => {
  const c = createChecker({ version: '2.4.0', mac: '34:85:18:A1:0F:22' });
  BOOT.forEach((l, i) => c.feed(l, 1 + i));
  assert.equal(c.ck.boot.state, 'ok');
  assert.equal(c.ck.version.state, 'ok');
  assert.equal(c.ck.mac.state, 'ok');
  assert.equal(c.ck.heap.state, 'ok');
  assert.equal(c.ck.radar.state, 'ok');
  assert.equal(c.allPassed(), false);
  c.startPresence(10);
  c.feed('radar:OK  presence:1  bed:in  radarState:ok  motion:some  range:80', 14);
  assert.equal(c.allPassed(), true);
  assert.deepEqual(c.toList().map((x) => x.ok), [true, true, true, true, true, true]);
});

test('wrong version, wrong MAC, low heap and crash fail; time limits apply', () => {
  const c = createChecker({ version: '2.4.1', mac: 'aa:bb:cc:dd:ee:ff' });
  BOOT.slice(0, 2).forEach((l) => c.feed(l, 1));
  c.feed('mqtt:down  heap:12000', 3);
  assert.equal(c.ck.version.state, 'bad');
  assert.equal(c.ck.mac.state, 'bad');
  assert.equal(c.ck.heap.state, 'bad');
  c.tick(61);
  assert.equal(c.ck.radar.state, 'bad');
  c.feed('Guru Meditation Error: Core  1 panic\'ed', 62);
  assert.equal(c.ck.boot.state, 'bad');
  assert.equal(c.firstFailed(), 'boot');
});

test('test only (not flashed) skips the version check; presence can be skipped', () => {
  const c = createChecker({ version: null, mac: '348518a10f22' });
  BOOT.forEach((l, i) => c.feed(l, i));
  c.skipPresence();
  assert.equal(c.ck.version.state, 'skip');
  assert.equal(c.allPassed(), true);
  const c2 = createChecker({ version: null, mac: '348518a10f22' });
  c2.tick(11);
  assert.equal(c2.ck.boot.state, 'bad');
});
