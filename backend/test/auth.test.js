// Step 2: auth and my account (docs/API.md §1–§2).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { db, Client, phone, registered, insertDevice } = require('./helpers');

const run = promisify(execFile);
const JWT_SECRET = process.env.TEST_JWT_SECRET || 'dev-only-jwt-secret-change-me';

after(() => db.end());

test('register sets httpOnly cookies and returns the user', async () => {
  const c = new Client();
  const p = phone();
  const r = await c.post('/auth/register', { fullName: 'Priya Shah', phone: p, country: 'in', password: 'sleepwell24' });
  assert.equal(r.status, 201);
  assert.deepEqual(
    { kind: r.body.user.kind, country: r.body.user.country, role: r.body.user.role, permissions: r.body.user.permissions },
    { kind: 'customer', country: 'IN', role: null, permissions: [] });
  const at = c.cookies.get('argus_at');
  const rt = c.cookies.get('argus_rt');
  assert.ok(at.attrs.httponly && rt.attrs.httponly, 'both cookies httpOnly');
  assert.equal(at.attrs.samesite, 'Lax');
  assert.equal(rt.path, '/api/v1/auth');
  const me = await c.get('/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.phone, p);
});

test('register rejects a taken phone and bad input', async () => {
  const { phone: p } = await registered();
  const dup = await new Client().post('/auth/register', { fullName: 'X', phone: p, country: 'IN', password: 'sleepwell24' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'PHONE_TAKEN');
  const bad = await new Client().post('/auth/register', { fullName: 'X', phone: '9825012345', country: 'IN', password: 'sleepwell24' });
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.body.error.code, bad.body.error.field], ['VALIDATION', 'phone']);
  const short = await new Client().post('/auth/register', { fullName: 'X', phone: phone(), country: 'IN', password: 'short' });
  assert.equal(short.body.error.field, 'password');
});

test('writes without our Origin are refused (CSRF guard)', async () => {
  const none = await new Client().post('/auth/login', { phone: phone(), password: 'x' }, { origin: null });
  assert.equal(none.status, 403);
  assert.equal(none.body.error.code, 'BAD_ORIGIN');
  const evil = await new Client().post('/auth/login', { phone: phone(), password: 'x' }, { origin: 'https://evil.example' });
  assert.equal(evil.body.error.code, 'BAD_ORIGIN');
});

test('login: wrong password, then rate limit after 5 failures', async () => {
  const { phone: p, password } = await registered();
  const c = new Client();
  for (let i = 0; i < 5; i += 1) {
    const r = await c.post('/auth/login', { phone: p, password: 'wrong-password' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'BAD_CREDENTIALS');
  }
  const blocked = await c.post('/auth/login', { phone: p, password });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.error.retryAfterS > 0);
  assert.ok(blocked.headers.get('retry-after'));
});

test('login works and unknown phones get the same error', async () => {
  const { phone: p, password } = await registered();
  const c = new Client();
  const ok = await c.post('/auth/login', { phone: p, password });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.phone, p);
  const unknown = await new Client().post('/auth/login', { phone: phone(), password });
  assert.equal(unknown.body.error.code, 'BAD_CREDENTIALS');
});

test('no cookie = NOT_LOGGED_IN; expired access token = TOKEN_EXPIRED', async () => {
  const anon = await new Client().get('/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'NOT_LOGGED_IN');
  const { user } = await registered();
  const expired = jwt.sign({ sub: user.id, tv: 0, sid: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
    JWT_SECRET, { audience: 'access' });
  const c = new Client();
  c.cookies.set('argus_at', { value: expired, path: '/', attrs: {} });
  const r = await c.get('/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'TOKEN_EXPIRED');
});

test('refresh rotates the token; a quick double-use fails without ending other sessions', async () => {
  const { c } = await registered();
  const oldRt = c.cookies.get('argus_rt').value;
  const r = await c.post('/auth/refresh');
  assert.equal(r.status, 204);
  assert.notEqual(c.cookies.get('argus_rt').value, oldRt);
  assert.equal((await c.get('/me')).status, 200);

  const tab2 = new Client();
  tab2.cookies.set('argus_rt', { value: oldRt, path: '/api/v1/auth', attrs: {} });
  const race = await tab2.post('/auth/refresh');
  assert.equal(race.status, 401);
  assert.equal(race.body.error.code, 'REFRESH_INVALID');
  assert.equal((await c.get('/me')).status, 200, 'first tab still logged in');
});

test('re-using an old refresh token later ends every session (theft detection)', async () => {
  const { c, user } = await registered();
  const oldRt = c.cookies.get('argus_rt').value;
  assert.equal((await c.post('/auth/refresh')).status, 204);
  await db.query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NOT NULL", [user.id]);
  const thief = new Client();
  thief.cookies.set('argus_rt', { value: oldRt, path: '/api/v1/auth', attrs: {} });
  assert.equal((await thief.post('/auth/refresh')).status, 401);
  assert.equal((await c.get('/me')).status, 401, 'real user logged out too');
  assert.equal((await c.post('/auth/refresh')).status, 401, 'their new refresh token was deleted');
});

test('logout ends this session only; logout-all ends all', async () => {
  const { phone: p, password, c } = await registered();
  const other = new Client();
  await other.post('/auth/login', { phone: p, password });

  assert.equal((await c.post('/auth/logout')).status, 204);
  assert.equal(c.cookies.size, 0, 'cookies cleared');
  assert.equal((await c.get('/me')).status, 401);
  assert.equal((await other.get('/me')).status, 200, 'other session unaffected');

  const third = new Client();
  await third.post('/auth/login', { phone: p, password });
  assert.equal((await third.post('/auth/logout-all')).status, 204);
  assert.equal((await other.get('/me')).status, 401);
  assert.equal((await other.post('/auth/refresh')).status, 401);
});

test('PATCH /me updates name and country, not phone', async () => {
  const { c } = await registered();
  const r = await c.patch('/me', { fullName: 'Rohan Shah', country: 'ae' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.fullName, r.body.country], ['Rohan Shah', 'AE']);
  const ph = await c.patch('/me', { phone: '+15555550100' });
  assert.equal(ph.status, 400);
});

test('change password keeps this session, ends the others', async () => {
  const { phone: p, password, c } = await registered();
  const other = new Client();
  await other.post('/auth/login', { phone: p, password });
  const wrong = await c.post('/me/password', { currentPassword: 'nope-nope', newPassword: 'newpassword1' });
  assert.equal(wrong.body.error.code, 'BAD_CREDENTIALS');
  assert.equal((await c.post('/me/password', { currentPassword: password, newPassword: 'newpassword1' })).status, 204);
  assert.equal((await c.get('/me')).status, 200);
  assert.equal((await other.get('/me')).status, 401);
  assert.equal((await new Client().post('/auth/login', { phone: p, password: 'newpassword1' })).status, 200);
});

test('password reset link works once', async () => {
  const { phone: p, user } = await registered();
  const { rows: [u] } = await db.query('SELECT token_version FROM users WHERE id = $1', [user.id]);
  const token = jwt.sign({ sub: user.id, tv: u.token_version }, JWT_SECRET, { audience: 'pwreset', expiresIn: 600 });
  const anon = new Client();
  assert.equal((await anon.post('/auth/password/reset', { token, newPassword: 'resetpass99' })).status, 204);
  const again = await anon.post('/auth/password/reset', { token, newPassword: 'another999' });
  assert.equal(again.body.error.code, 'RESET_TOKEN_INVALID');
  assert.equal((await new Client().post('/auth/login', { phone: p, password: 'resetpass99' })).status, 200);
});

test('a disabled user is blocked at once', async () => {
  const { phone: p, password, c, user } = await registered();
  await db.query("UPDATE users SET is_disabled = true, disabled_at = now(), disabled_reason = 'test' WHERE id = $1", [user.id]);
  const me = await c.get('/me');
  assert.equal(me.status, 403);
  assert.equal(me.body.error.code, 'USER_DISABLED');
  assert.equal((await new Client().post('/auth/login', { phone: p, password })).body.error.code, 'USER_DISABLED');
});

test('alert prefs: quiet hours and per-device mutes (in-app only)', async () => {
  const { c, user } = await registered();
  assert.deepEqual((await c.get('/me/notification-prefs')).body,
    { quietEnabled: false, quietFrom: null, quietTo: null, mutedDeviceIds: [] });
  assert.equal((await c.patch('/me/notification-prefs', { quietEnabled: true })).status, 400);
  assert.equal((await c.patch('/me/notification-prefs', { smsEnabled: true })).status, 400, 'no SMS switch any more');
  const ok = await c.patch('/me/notification-prefs', { quietEnabled: true, quietFrom: '22:00', quietTo: '07:00' });
  assert.deepEqual([ok.status, ok.body.quietFrom, ok.body.quietTo], [200, '22:00', '07:00']);

  const mine = await insertDevice({ ownerId: user.id });
  const notMine = await insertDevice();
  const denied = await c.patch('/me/notification-prefs', { mutedDeviceIds: [notMine.id] });
  assert.equal(denied.status, 404, 'cannot mute a device you cannot see');
  const muted = await c.patch('/me/notification-prefs', { mutedDeviceIds: [mine.id, mine.id] });
  assert.deepEqual([muted.status, muted.body.mutedDeviceIds, muted.body.quietEnabled], [200, [mine.id], true]);
  const cleared = await c.patch('/me/notification-prefs', { mutedDeviceIds: [] });
  assert.deepEqual(cleared.body.mutedDeviceIds, []);
});

test('push subscriptions answer 501 in v1 (alerts are in-app only)', async () => {
  const { c, user } = await registered();
  const sub = { endpoint: `https://push.example/${user.id}`, keys: { p256dh: 'k', auth: 'a' } };
  const add = await c.post('/me/push-subscriptions', { subscription: sub, platform: 'web' });
  assert.deepEqual([add.status, add.body.error.code], [501, 'NOT_ENABLED']);
  assert.equal((await c.del('/me/push-subscriptions', { endpoint: sub.endpoint })).status, 501);
  assert.equal((await db.query('SELECT 1 FROM push_tokens WHERE user_id = $1', [user.id])).rowCount, 0);
});

test('delete account releases owned devices and their sleep history', async () => {
  const { c, user, phone: p, password } = await registered();
  const mac = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  const { rows: [d] } = await db.query(
    `INSERT INTO devices (serial_no, mac, mqtt_username, chip_model, hw_model, owner_id, claimed_at, name)
     VALUES ($1, $2, $3, 'ESP32-S3', 'ARG-S1', $4, now(), 'Bedroom') RETURNING id`,
    [`ARG-T${mac.slice(3).join('').toUpperCase().slice(0, 6)}`, mac.join(':'), mac.join(''), user.id]);
  await db.query('INSERT INTO device_settings (device_id) VALUES ($1)', [d.id]);
  await db.query(`INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, raw)
                  VALUES ($1, 1, now() - interval '8 hours', now(), 'Asia/Kolkata', '{}')`, [d.id]);

  assert.equal((await c.del('/me', { password: 'wrong-pass' })).body.error.code, 'BAD_CREDENTIALS');
  assert.equal((await c.del('/me', { password })).status, 204);

  const { rows: [dev] } = await db.query('SELECT owner_id, claim_code_hash, name FROM devices WHERE id = $1', [d.id]);
  assert.deepEqual(dev, { owner_id: null, claim_code_hash: null, name: null });
  assert.equal((await db.query('SELECT 1 FROM sleep_sessions WHERE device_id = $1', [d.id])).rowCount, 0);
  assert.equal((await new Client().post('/auth/login', { phone: p, password })).status, 401);
  // the phone number is free again
  assert.equal((await new Client().post('/auth/register',
    { fullName: 'New', phone: p, country: 'IN', password: 'sleepwell24' })).status, 201);
});

test('create-admin makes an Owner with all 11 staff permissions', async () => {
  const p = phone();
  await run('node', [path.join(__dirname, '../scripts/create-admin.js'), '--name', 'Test Owner', '--phone', p, '--country', 'IN'],
    { env: { ...process.env, ARGUS_ADMIN_PASSWORD: 'ownerpass123' } });
  const r = await new Client().post('/auth/login', { phone: p, password: 'ownerpass123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.kind, 'admin');
  assert.equal(r.body.user.role.name, 'Owner');
  assert.equal(r.body.user.permissions.length, 11);
});

test('SMS OTP routes answer 501 NOT_ENABLED', async () => {
  const r = await new Client().post('/auth/otp/send', { phone: phone(), purpose: 'verify_phone' });
  assert.equal(r.status, 501);
  assert.equal(r.body.error.code, 'NOT_ENABLED');
});
