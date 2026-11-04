// In-browser stand-in for the backend, following docs/API.md v1.0 paths, shapes and error codes.
// Used for every area that isn't switched to "live" in config.ts.

import { ApiError } from '../api';
import type {
  AdminDeviceDetail, AdminDeviceRow, CommandRow, CustomerDetail, CustomerRow, DeviceCard, DeviceDetail, DevicePerm,
  InvitePreview, StaffPerm, User,
} from '../types';
import { ALL_DEVICE_PERMS, STAFF_PERMS, db, defaultRules, nightCard, nightsFor, type MDevice, type MUser } from './data';

const SESSION_KEY = 'argus-mock-user';
const nowIso = () => new Date().toISOString();
const rid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (status: number, code: string, message: string, field?: string): never => { throw new ApiError(status, code, message, field); };
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => Array.from({ length: 12 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const cleanCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^ARG1/, '');
const origin = () => (typeof location !== 'undefined' ? location.origin : 'https://app.example');

function sessionUser(): MUser | null {
  let id: string | null = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch { /* storage blocked */ }
  return db.users.find((u) => u.id === id) || null;
}
function setSession(id: string | null) {
  try { if (id) localStorage.setItem(SESSION_KEY, id); else localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
function me(): MUser {
  const u = sessionUser();
  if (!u) fail(401, 'NOT_LOGGED_IN', 'Please log in');
  if (u!.status === 'disabled') fail(403, 'USER_DISABLED', 'This account is disabled. Contact support.');
  return u!;
}
function staffPerms(u: MUser): StaffPerm[] { return u.roleId ? db.roles.find((r) => r.id === u.roleId)?.permissions || [] : []; }
function needStaff(u: MUser, p?: StaffPerm) {
  if (!u.roleId) fail(403, 'FORBIDDEN', 'Staff only');
  if (p && !staffPerms(u).includes(p)) fail(403, 'FORBIDDEN', `Your role needs ${p}`);
}
function userObj(u: MUser): User {
  const role = u.roleId ? db.roles.find((r) => r.id === u.roleId)! : null;
  return { id: u.id, fullName: u.fullName, phone: u.phone, country: u.country, kind: role ? 'admin' : 'customer',
    role: role ? { id: role.id, name: role.name } : null, permissions: staffPerms(u), createdAt: u.createdAt };
}
function audit(u: MUser, action: string, targetType: string, targetLabel: string, detail = '') {
  db.audit.unshift({ id: rid('a'), at: nowIso(), actorName: u.fullName, action, targetType, targetLabel, detail });
}

/* ---- device access ---- */
function permsOn(u: MUser, d: MDevice): DevicePerm[] {
  if (d.ownerId === u.id) return [...ALL_DEVICE_PERMS];
  return db.shares.find((s) => s.deviceId === d.id && s.userId === u.id)?.permissions || [];
}
function device(u: MUser, id: string, need?: DevicePerm | 'any' | 'owner'): MDevice {
  const d = db.devices.find((x) => x.id === id);
  const p = d ? permsOn(u, d) : [];
  // "No access looks like not found" (API.md §0)
  if (!d || !p.length) fail(404, 'NOT_FOUND', 'Device not found');
  if (need === 'owner' && d!.ownerId !== u.id) fail(404, 'NOT_FOUND', 'Device not found');
  if (need && need !== 'any' && need !== 'owner' && !p.includes(need)) fail(403, 'FORBIDDEN', `You need “${need}” on this device`);
  return d!;
}
export function liveSnapshot(d: MDevice) {
  if (!d.online) return null;
  return { pr: d.base.bed ? 1 : 0, bed: d.base.bed, ss: d.base.ss, hr: d.base.hr, br: d.base.br, at: nowIso() };
}
function card(u: MUser, d: MDevice): DeviceCard {
  const p = permsOn(u, d);
  const owner = db.users.find((x) => x.id === d.ownerId);
  // lastNight is never a nap-only day (API.md §4)
  const n = p.includes('history.view') ? nightsFor(d.id, d.tz!).find((x) => x.hasMainSleep) : null;
  return {
    id: d.id, serial: d.serial, name: d.name || d.serial, room: d.room, tz: d.tz!, place: d.place,
    isOwner: d.ownerId === u.id, sharedBy: d.ownerId === u.id ? null : { fullName: owner?.fullName || '' },
    myPermissions: p, status: { online: d.online, lastSeenAt: d.lastSeenAt },
    live: p.includes('live.view') ? liveSnapshot(d) : undefined,
    lastNight: n ? { sleepDate: n.sleepDate, score: n.score!, totalSleepMin: n.totalSleepMin! } : undefined,
  };
}
function detail(u: MUser, d: MDevice): DeviceDetail {
  const c = card(u, d);
  const edit = c.myPermissions.includes('settings.edit');
  return { ...c, sleepCutoff: d.sleepCutoff, autoUpdate: d.autoUpdate, hwModel: d.hwModel,
    connection: edit ? { fw: d.fw, rssi: d.rssi, wifiSsid: d.wifiSsid, uptimeS: d.uptimeS } : undefined,
    sensorSync: edit ? { version: d.sensor.version, appliedVersion: d.sensor.appliedVersion, sync: d.sensor.sync } : undefined };
}
function validTz(tz: string) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

/* ---- admin helpers ---- */
function adminRow(d: MDevice): AdminDeviceRow {
  const o = db.users.find((x) => x.id === d.ownerId);
  return { id: d.id, serial: d.serial, name: d.name, owner: o ? { id: o.id, fullName: o.fullName } : null, online: d.online,
    tz: d.tz, fw: d.fw, chip: d.chip, lastSeenAt: d.lastSeenAt, createdAt: d.registeredAt };
}
function custRow(u: MUser): CustomerRow {
  const ds = db.devices.filter((d) => d.ownerId === u.id);
  return { id: u.id, fullName: u.fullName, phone: u.phone, country: u.country, deviceTimeZones: [...new Set(ds.map((d) => d.tz!).filter(Boolean))],
    deviceCount: ds.length, familyCount: new Set(db.shares.filter((s) => ds.some((d) => d.id === s.deviceId)).map((s) => s.userId)).size,
    createdAt: u.createdAt, lastActiveAt: u.lastActiveAt, status: u.status };
}
function fakeSticker(serial: string, code: string) {
  return { qrPayload: `ARG1:${code}`, qrPngBase64: null, stickerHtml: null, serial, claimCode: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` };
}

type Handler = (m: RegExpMatchArray, body: any, q: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, re: string, h: Handler) => routes.push([method, new RegExp(`^${re}$`), h]);

/* ---------- 1. auth ---------- */
on('POST', '/auth/register', (_m, b) => {
  if (!b.fullName?.trim()) fail(400, 'VALIDATION', 'Enter your name', 'fullName');
  if (!/^\+[1-9]\d{6,14}$/.test(b.phone || '')) fail(400, 'VALIDATION', 'Enter a valid phone number', 'phone');
  if ((b.password || '').length < 8) fail(400, 'VALIDATION', 'Password must be at least 8 characters', 'password');
  if (db.users.some((u) => u.phone === b.phone)) fail(409, 'PHONE_TAKEN', 'An account with this phone number already exists. Log in instead.', 'phone');
  const u: MUser = { id: rid('u'), fullName: b.fullName.trim(), phone: b.phone, country: b.country || 'IN', roleId: null, status: 'active', createdAt: nowIso(), lastActiveAt: nowIso() };
  db.users.push(u); setSession(u.id);
  return { user: userObj(u) };
});
on('POST', '/auth/login', (_m, b) => {
  const u = db.users.find((x) => x.phone === b.phone);
  if (!u || (b.password || '').length < 8) fail(401, 'BAD_CREDENTIALS', 'Wrong phone number or password');
  if (u!.status === 'disabled') fail(403, 'USER_DISABLED', 'This account is disabled. Contact support.');
  setSession(u!.id);
  return { user: userObj(u!) };
});
on('POST', '/auth/refresh', () => { if (!sessionUser()) fail(401, 'REFRESH_INVALID', 'Please log in again'); return undefined; });
on('POST', '/auth/logout', () => { setSession(null); return undefined; });
on('POST', '/auth/logout-all', () => { setSession(null); return undefined; });
on('POST', '/auth/password/reset', (_m, b) => {
  if (!b.token || b.token === 'expired') fail(400, 'RESET_TOKEN_INVALID', 'This reset link has expired or was already used. Ask support for a new one.');
  if ((b.newPassword || '').length < 8) fail(400, 'VALIDATION', 'Password must be at least 8 characters', 'newPassword');
  setSession(null);
  return undefined;
});

/* ---------- 2. me ---------- */
on('GET', '/me', () => userObj(me()));
on('PATCH', '/me', (_m, b) => { const u = me(); if (b.fullName) u.fullName = b.fullName; if (b.country) u.country = b.country; return userObj(u); });
on('POST', '/me/password', (_m, b) => { me(); if ((b.currentPassword || '').length < 8) fail(401, 'BAD_CREDENTIALS', 'Current password is wrong', 'currentPassword'); if ((b.newPassword || '').length < 8) fail(400, 'VALIDATION', 'Password must be at least 8 characters', 'newPassword'); return undefined; });
on('DELETE', '/me', (_m, b) => { const u = me(); if ((b?.password || '').length < 8) fail(401, 'BAD_CREDENTIALS', 'Password is wrong', 'password'); u.status = 'disabled'; setSession(null); return undefined; });
// Notification prefs (API.md 2.5/2.6). In-app only: no push, no SMS.
const defaultPrefs = () => ({ quietEnabled: false, quietFrom: '22:00', quietTo: '07:00', mutedDeviceIds: [] as string[] });
on('GET', '/me/notification-prefs', () => { const u = me(); return db.prefs[u.id] || defaultPrefs(); });
on('PATCH', '/me/notification-prefs', (_m, b) => {
  const u = me(); const cur = db.prefs[u.id] || defaultPrefs();
  for (const k of ['quietFrom', 'quietTo'] as const) if (b[k] !== undefined && !/^\d{2}:\d{2}$/.test(b[k])) fail(400, 'VALIDATION', 'Use HH:mm', k);
  if (b.mutedDeviceIds !== undefined && !Array.isArray(b.mutedDeviceIds)) fail(400, 'VALIDATION', 'mutedDeviceIds must be a list', 'mutedDeviceIds');
  db.prefs[u.id] = { ...cur, ...b };
  return db.prefs[u.id];
});

/* ---------- 3. devices ---------- */
on('GET', '/devices', () => { const u = me(); return { items: db.devices.filter((d) => permsOn(u, d).length).map((d) => card(u, d)) }; });
function findByCode(b: { qr?: string; claimCode?: string; serial?: string }) {
  const code = cleanCode(b.qr || b.claimCode || '');
  const d = db.devices.find((x) => x.claimCode && x.claimCode === code);
  if (!d) {
    if (db.devices.some((x) => x.ownerId && b.serial && x.serial === b.serial.toUpperCase())) fail(409, 'ALREADY_CLAIMED', 'This sensor already has an owner. Ask them to share it with you.');
    fail(404, 'INVALID_CODE', 'That claim code is not valid. Check the sticker and try again.', 'claimCode');
  }
  if (b.serial && d!.serial !== b.serial.trim().toUpperCase()) fail(404, 'INVALID_CODE', 'The serial and code don’t match the same sensor.', 'serial');
  if (d!.isDisabled) fail(403, 'DEVICE_DISABLED', 'This sensor is disabled. Contact support.');
  return d!;
}
on('POST', '/devices/claim/check', (_m, b) => { me(); const d = findByCode(b); return { serial: d.serial, hwModel: d.hwModel, registeredAt: d.registeredAt }; });
on('POST', '/devices/claim', (_m, b) => {
  const u = me(); const d = findByCode(b);
  if (!b.name?.trim()) fail(400, 'VALIDATION', 'Give the sensor a name', 'name');
  if (!validTz(b.tz)) fail(422, 'INVALID_TIMEZONE', 'Pick a valid time zone', 'tz');
  Object.assign(d, { ownerId: u.id, claimCode: null, name: b.name.trim(), room: b.room || null, tz: b.tz, place: b.place || null, sleepCutoff: db.platform.defaultSleepCutoff });
  db.rules[d.id] = defaultRules();
  audit(u, 'device.claim', 'device', d.serial);
  return detail(u, d);
});
on('GET', '/devices/([^/]+)', (m) => { const u = me(); return detail(u, device(u, m[1], 'any')); });
on('PATCH', '/devices/([^/]+)', (m, b) => {
  const u = me(); const d = device(u, m[1], 'settings.edit');
  if (b.tz !== undefined && !validTz(b.tz)) fail(422, 'INVALID_TIMEZONE', 'Pick a valid time zone', 'tz');
  if (b.sleepCutoff !== undefined && !/^\d{2}:\d{2}$/.test(b.sleepCutoff)) fail(400, 'VALIDATION', 'Use HH:mm', 'sleepCutoff');
  for (const k of ['name', 'room', 'tz', 'place', 'sleepCutoff', 'autoUpdate'] as const) if (b[k] !== undefined) (d as any)[k] = b[k];
  audit(u, 'device.update', 'device', d.serial);
  return detail(u, d);
});
on('GET', '/devices/([^/]+)/sensor-settings', (m) => { const u = me(); return device(u, m[1], 'settings.edit').sensor; });
on('PATCH', '/devices/([^/]+)/sensor-settings', (m, b) => {
  const u = me(); const d = device(u, m[1], 'settings.edit');
  if (b.exitS !== undefined && (b.exitS < 30 || b.exitS > 3600)) fail(400, 'VALIDATION', 'Bed-exit timeout must be 30–3600 s', 'exitS');
  if (b.liveS !== undefined && (b.liveS < 1 || b.liveS > 60)) fail(400, 'VALIDATION', 'Live rate must be 1–60 s', 'liveS');
  if (b.idleS !== undefined && (b.idleS < 10 || b.idleS > 600)) fail(400, 'VALIDATION', 'Idle rate must be 10–600 s', 'idleS');
  const v = d.sensor.version + 1;
  d.sensor = { ...d.sensor, ...b, version: v, sync: d.online ? 'sending' : 'queued_offline' };
  if (d.online) setTimeout(() => { d.sensor.appliedVersion = v; d.sensor.sync = 'applied'; mockEmit('settings:sync', { deviceId: d.id, version: v, appliedVersion: v, sync: 'applied' }); }, 1500);
  audit(u, 'device.settings.update', 'device', d.serial);
  return { settings: d.sensor };
});
on('POST', '/devices/([^/]+)/wifi-setup', (m) => { const u = me(); const d = device(u, m[1], 'settings.edit'); return { commandId: rid('c'), status: d.online ? 'sent' : 'expired' }; });
// PROPOSED customer route (not in API.md yet): like wifi-setup, needs settings.edit; offline → expired.
on('POST', '/devices/([^/]+)/recalibrate', (m) => {
  const u = me(); const d = device(u, m[1], 'settings.edit');
  const commandId = rid('c');
  if (d.online) setTimeout(() => mockEmit('command:status', { commandId, deviceId: d.id, serial: d.serial, type: 'recalibrate', status: 'done', error: null }), 11000); // radar reset ~11 s
  audit(u, 'device.command.recalibrate', 'device', d.serial);
  return { commandId, status: d.online ? 'sent' : 'expired' };
});
on('DELETE', '/devices/([^/]+)', (m, b) => {
  const u = me(); const d = device(u, m[1], 'owner');
  if ((b?.confirmName || '').trim() !== d.name) fail(422, 'CONFIRM_MISMATCH', 'Type the device name exactly to confirm', 'confirmName');
  Object.assign(d, { ownerId: null, name: null, room: null });
  db.shares = db.shares.filter((s) => s.deviceId !== d.id);
  audit(u, 'device.unclaim', 'device', d.serial);
  return undefined;
});
on('DELETE', '/devices/([^/]+)/me', (m) => { const u = me(); const d = device(u, m[1], 'any'); db.shares = db.shares.filter((s) => !(s.deviceId === d.id && s.userId === u.id)); return undefined; });

/* ---------- 4. nights ---------- */
on('GET', '/devices/([^/]+)/nights', (m, _b, q) => {
  const u = me(); const d = device(u, m[1], 'history.view');
  const all = nightsFor(d.id, d.tz!).slice(0, Math.min(90, Number(q.get('days') || 14)));
  const main = all.filter((x) => x.hasMainSleep); // nap-only days are left out of averages
  const n = main.length || 1;
  return {
    device: { tz: d.tz, place: d.place }, nights: all.map(nightCard),
    averages: { nights: main.length, totalSleepMin: Math.round(main.reduce((a, x) => a + x.totalSleepMin!, 0) / n), score: Math.round(main.reduce((a, x) => a + x.score!, 0) / n),
      hrAvg: Math.round(main.reduce((a, x) => a + x.hr!.avg, 0) / n), wakeUps: Math.round((main.reduce((a, x) => a + x.wakeUps!, 0) / n) * 10) / 10 },
  };
});
on('GET', '/devices/([^/]+)/nights/(\\d{4}-\\d{2}-\\d{2})', (m) => {
  const u = me(); const d = device(u, m[1], 'history.view');
  const n = nightsFor(d.id, d.tz!).find((x) => x.sleepDate === m[2]);
  if (!n) fail(404, 'NOT_FOUND', 'No sleep recorded on that date'); // a nap-only date returns hasMainSleep: false
  return n;
});

/* ---------- 5. sharing ---------- */
on('GET', '/devices/([^/]+)/shares', (m) => {
  const u = me(); const d = device(u, m[1], 'sharing.manage');
  const owner = db.users.find((x) => x.id === d.ownerId)!;
  return {
    owner: { fullName: owner.fullName, phone: owner.phone },
    shares: db.shares.filter((s) => s.deviceId === d.id).map((s) => { const x = db.users.find((y) => y.id === s.userId)!; return { userId: x.id, fullName: x.fullName, phone: x.phone, permissions: s.permissions, status: 'joined' }; }),
    invites: db.invites.filter((i) => i.kind === 'device' && i.deviceId === d.id && i.status === 'invite_sent').map((i) => ({ id: i.id, label: i.label, permissions: i.permissions!, status: 'invite_sent', expiresAt: i.expiresAt })),
  };
});
on('POST', '/devices/([^/]+)/invites', (m, b) => {
  const u = me(); const d = device(u, m[1], 'sharing.manage');
  // Link-only invite: {label, permissions[]}. No phone (owner decision 3 Nov).
  if (!b.label?.trim()) fail(400, 'VALIDATION', 'Who is it for? Add a label for your list', 'label');
  const perms: DevicePerm[] = b.permissions || [];
  if (!perms.length || perms.some((p) => !ALL_DEVICE_PERMS.includes(p))) fail(422, 'BAD_PERMISSION', 'Pick at least one thing they can do');
  if (perms.includes('sharing.manage') && d.ownerId !== u.id) fail(422, 'BAD_PERMISSION', 'Only the owner can let others invite people');
  const token = Math.random().toString(36).slice(2, 14);
  const inv = { id: rid('inv'), token, kind: 'device' as const, deviceId: d.id, label: b.label.trim(), permissions: perms, invitedBy: u.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), status: 'invite_sent' as const };
  db.invites.push(inv);
  audit(u, 'share.invite', 'device', d.serial, `Invite link for ${inv.label}`);
  const inviteUrl = `${origin()}/invite/${token}`;
  return { invite: { id: inv.id, label: inv.label, permissions: perms, status: 'invite_sent', expiresAt: inv.expiresAt }, inviteUrl, expiresAt: inv.expiresAt };
});
on('DELETE', '/devices/([^/]+)/invites/([^/]+)', (m) => { const u = me(); device(u, m[1], 'sharing.manage'); const i = db.invites.find((x) => x.id === m[2]); if (i) i.status = 'cancelled'; return undefined; });
on('PATCH', '/devices/([^/]+)/shares/([^/]+)', (m, b) => {
  const u = me(); const d = device(u, m[1], 'sharing.manage');
  const s = db.shares.find((x) => x.deviceId === d.id && x.userId === m[2]);
  if (!s) fail(404, 'NOT_FOUND', 'Not found');
  if (!b.permissions?.length) fail(422, 'BAD_PERMISSION', 'Keep at least one permission, or remove the person instead');
  s!.permissions = b.permissions;
  return s;
});
on('DELETE', '/devices/([^/]+)/shares/([^/]+)', (m) => { const u = me(); const d = device(u, m[1], 'sharing.manage'); db.shares = db.shares.filter((x) => !(x.deviceId === d.id && x.userId === m[2])); return undefined; });
function inviteByToken(t: string) {
  const i = db.invites.find((x) => x.token === t);
  if (!i || i.status !== 'invite_sent' || new Date(i.expiresAt).getTime() < Date.now()) fail(404, 'INVITE_INVALID', 'This invite link has expired, was cancelled, or was already used. Ask for a new one.');
  return i!;
}
on('GET', '/invites/([^/]+)', (m): InvitePreview => {
  const i = inviteByToken(m[1]);
  const by = db.users.find((u) => u.id === i.invitedBy)!;
  const d = i.deviceId ? db.devices.find((x) => x.id === i.deviceId) : null;
  return { kind: i.kind, inviterName: by.fullName, deviceName: d?.name || undefined, place: d?.place ?? null, roleName: i.roleId ? db.roles.find((r) => r.id === i.roleId)!.name : undefined,
    permissions: i.kind === 'staff' ? db.roles.find((r) => r.id === i.roleId)?.permissions : i.permissions, expiresAt: i.expiresAt, status: i.status };
});
on('POST', '/invites/([^/]+)/accept', (m) => {
  const u = me(); const i = inviteByToken(m[1]);
  // Link-only: any logged-in account may accept; the phone is never compared (owner decision 3 Nov).
  if (i.kind === 'device') { const dv0 = db.devices.find((d) => d.id === i.deviceId)!; if (dv0.ownerId === u.id || db.shares.some((s) => s.deviceId === dv0.id && s.userId === u.id)) fail(409, 'ALREADY_SHARED', 'You already have access to this sensor'); }
  if (i.kind === 'staff' && u.roleId) fail(409, 'ALREADY_STAFF', 'You are already on the team. Ask an Owner to change your role instead.');
  i.status = 'accepted';
  if (i.kind === 'staff') { u.roleId = i.roleId!; return { role: db.roles.find((r) => r.id === i.roleId) }; }
  db.shares.push({ deviceId: i.deviceId!, userId: u.id, permissions: i.permissions! });
  return { device: card(u, db.devices.find((d) => d.id === i.deviceId)!) };
});

/* ---------- 6. alerts ---------- */
on('GET', '/alerts', (_m, _b, q) => {
  const u = me();
  const off = db.prefs[u.id]?.mutedDeviceIds || [];
  const ok = new Set(db.devices.filter((d) => permsOn(u, d).includes('alerts.receive') && !off.includes(d.id)).map((d) => d.id));
  const dev = q.get('deviceId');
  return { items: db.alerts.filter((a) => ok.has(a.deviceId) && (!dev || a.deviceId === dev)), nextCursor: null };
});
on('GET', '/devices/([^/]+)/alert-rules', (m) => {
  const u = me(); const d = device(u, m[1], 'any'); const p = permsOn(u, d);
  if (!p.includes('alerts.receive') && !p.includes('settings.edit')) fail(403, 'FORBIDDEN', 'No access');
  return { rules: db.rules[d.id] || (db.rules[d.id] = defaultRules()), canEdit: p.includes('settings.edit') };
});
on('PUT', '/devices/([^/]+)/alert-rules', (m, b) => {
  const u = me(); const d = device(u, m[1], 'settings.edit');
  for (const r of b.rules || []) if (r.low != null && r.high != null && r.low >= r.high) fail(422, 'BAD_RULE', 'The low limit must be below the high limit');
  db.rules[d.id] = b.rules;
  return { rules: b.rules, canEdit: true };
});

/* ---------- 7. admin customers ---------- */
const customers = () => db.users.filter((u) => !u.roleId);
on('GET', '/admin/customers', (_m, _b, q) => {
  needStaff(me(), 'customers.view');
  const term = (q.get('q') || '').toLowerCase().replace(/\s/g, '');
  const rows = customers().map(custRow).filter((c) => (!term || (c.fullName + c.phone).toLowerCase().replace(/\s/g, '').includes(term))
    && (!q.get('country') || c.country === q.get('country')) && (!q.get('tz') || c.deviceTimeZones.includes(q.get('tz')!)) && (!q.get('status') || c.status === q.get('status')));
  return { items: rows, total: rows.length, nextCursor: null };
});
on('GET', '/admin/customers/([^/]+)', (m): CustomerDetail => {
  needStaff(me(), 'customers.view');
  const c = customers().find((x) => x.id === m[1]); if (!c) fail(404, 'NOT_FOUND', 'Customer not found');
  const ds = db.devices.filter((d) => d.ownerId === c!.id);
  return { ...custRow(c!), devices: ds.map((d) => ({ id: d.id, serial: d.serial, name: d.name!, tz: d.tz!, online: d.online, fw: d.fw, lastSeenAt: d.lastSeenAt })),
    family: db.shares.filter((s) => ds.some((d) => d.id === s.deviceId)).map((s) => { const x = db.users.find((y) => y.id === s.userId)!; return { fullName: x.fullName, phone: x.phone, deviceName: ds.find((d) => d.id === s.deviceId)!.name! }; }) };
});
on('POST', '/admin/customers/([^/]+)/(disable|enable)', (m, b) => {
  const u = me(); needStaff(u, 'customers.edit');
  const c = customers().find((x) => x.id === m[1]); if (!c) fail(404, 'NOT_FOUND', 'Customer not found');
  if (m[2] === 'disable' && !b.reason?.trim()) fail(400, 'VALIDATION', 'Give a reason', 'reason');
  c!.status = m[2] === 'disable' ? 'disabled' : 'active';
  audit(u, `customer.${m[2]}`, 'user', c!.fullName, b.reason ? `Reason: ${b.reason}` : '');
  return undefined;
});
on('POST', '/admin/customers/([^/]+)/reset-link', (m) => {
  const u = me(); needStaff(u, 'customers.edit');
  const c = customers().find((x) => x.id === m[1]); if (!c) fail(404, 'NOT_FOUND', 'Customer not found');
  audit(u, 'customer.reset_link', 'user', c!.fullName);
  return { resetUrl: `${origin()}/reset/${Math.random().toString(36).slice(2, 14)}`, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString() }; // 24 h, single use
});
on('POST', '/admin/customers/([^/]+)/logout-all', () => { needStaff(me(), 'customers.edit'); return undefined; });

/* ---------- 8. admin devices ---------- */
on('GET', '/admin/dashboard', () => {
  const u = me(); needStaff(u);
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: new Date(Date.now() - (23 - i) * 3600000).toISOString(), online: [383, 381, 379, 378, 377, 377, 376, 378, 380, 384, 386, 388, 389, 390, 391, 390, 389, 390, 392, 393, 393, 391, 391, 391][i] }));
  return { counts: { registered: 438, online: 391, offline: 27, unclaimed: 20, disabled: 0, customers: 312, registeredThisWeek: 12, customersThisWeek: 9, rolloutsRunning: db.rollouts.filter((r) => r.status === 'running').length },
    onlineHourly: hourly, fwVersions: db.firmware.map((f) => ({ version: f.version, count: f.deviceCount })),
    recentAudit: staffPerms(u).includes('audit.view') ? db.audit.slice(0, 5) : undefined };
});
on('GET', '/admin/devices', (_m, _b, q) => {
  needStaff(me(), 'devices.view');
  const term = (q.get('q') || '').toLowerCase().replace(/[:\s-]/g, '');
  const st = q.get('status'); const from = q.get('registeredFrom');
  const rows = db.devices.filter((d) => {
    const owner = db.users.find((x) => x.id === d.ownerId);
    const hay = (d.serial + d.mac + (d.name || '') + (owner ? owner.fullName + owner.phone : '')).toLowerCase().replace(/[:\s-]/g, '');
    const sOk = !st || (st === 'online' && d.online) || (st === 'offline' && !d.online && !!d.ownerId) || (st === 'unclaimed' && !d.ownerId) || (st === 'disabled' && d.isDisabled);
    return (!term || hay.includes(term)) && sOk && (!q.get('tz') || d.tz === q.get('tz')) && (!from || d.registeredAt >= from);
  }).map(adminRow);
  return { items: rows, total: rows.length, nextCursor: null };
});
on('GET', '/admin/devices/([^/]+)', (m): AdminDeviceDetail => {
  needStaff(me(), 'devices.view');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  const o = db.users.find((x) => x.id === d!.ownerId);
  return { id: d!.id, serial: d!.serial, name: d!.name,
    hardware: { mac: d!.mac, chip: d!.chip, radar: 'DFRobot C1001', hwModel: d!.hwModel, batch: d!.batch, manufacturedAt: d!.manufacturedAt, fwAtRegister: '1.4.2', registeredAt: d!.registeredAt, registeredBy: d!.registeredBy },
    connection: { online: d!.online, lastSeenAt: d!.lastSeenAt, ip: d!.ip, wifiSsid: d!.wifiSsid, rssi: d!.rssi, uptimeS: d!.uptimeS, fw: d!.fw, radarOk: d!.online ? true : null },
    tz: d!.tz, place: d!.place, sleepCutoff: d!.sleepCutoff, isDisabled: d!.isDisabled, disabledReason: d!.disabledReason,
    owner: o ? { id: o.id, fullName: o.fullName, phone: o.phone } : null,
    shares: db.shares.filter((s) => s.deviceId === d!.id).map((s) => { const x = db.users.find((y) => y.id === s.userId)!; return { fullName: x.fullName, phone: x.phone }; }),
    claimCodeActive: !!d!.claimCode, sensorSettings: d!.ownerId ? d!.sensor : null };
});
on('POST', '/admin/devices', (_m, b) => {
  const u = me(); needStaff(u, 'devices.register');
  const mac = String(b.mac || '').toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) fail(400, 'VALIDATION', 'MAC must look like 34:85:18:A1:0F:22', 'mac');
  if (db.devices.some((d) => d.mac === mac)) fail(409, 'MAC_EXISTS', 'A device with this MAC is already registered');
  const n = Math.max(...db.devices.map((d) => parseInt(d.serial.slice(-4), 10))) + 1;
  const serial = `ARG-24A${String(n).padStart(4, '0')}`;
  const code = newCode();
  const d: MDevice = { ...db.devices[db.devices.length - 1], id: `d-${n}`, serial, mac, chip: b.chip, hwModel: b.hwModel, batch: b.batch || null, manufacturedAt: b.manufacturedAt || null,
    registeredAt: nowIso(), registeredBy: u.fullName, claimCode: code, ownerId: null, name: null, online: false, sensor: { ...db.devices[0].sensor } };
  db.devices.push(d);
  audit(u, 'device.register', 'device', serial, `MAC ${mac} · ${b.chip}`);
  return { device: { id: d.id }, ...fakeSticker(serial, code) };
});
on('PATCH', '/admin/devices/([^/]+)', (m, b) => {
  const u = me(); needStaff(u, 'devices.command');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  d!.isDisabled = !!b.isDisabled; d!.disabledReason = b.disabledReason || null; if (d!.isDisabled) d!.online = false;
  audit(u, d!.isDisabled ? 'device.disable' : 'device.enable', 'device', d!.serial, b.disabledReason || '');
  return adminRow(d!);
});
on('POST', '/admin/devices/([^/]+)/claim-code', (m) => {
  const u = me(); needStaff(u, 'devices.register');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  d!.claimCode = newCode();
  audit(u, 'device.claim_code', 'device', d!.serial, 'New claim code; the old one stopped working');
  return fakeSticker(d!.serial, d!.claimCode);
});
on('POST', '/admin/devices/([^/]+)/unclaim', (m, b) => {
  const u = me(); needStaff(u, 'customers.edit');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  if (!b.reason?.trim()) fail(400, 'VALIDATION', 'Give a reason', 'reason');
  Object.assign(d!, { ownerId: null, name: null, room: null }); db.shares = db.shares.filter((s) => s.deviceId !== d!.id);
  audit(u, 'device.unclaim', 'device', d!.serial, b.reason);
  return undefined;
});
on('POST', '/admin/devices/([^/]+)/commands', (m, b) => {
  const u = me(); needStaff(u, 'devices.command');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  const row: CommandRow = { id: rid('c'), type: b.type, requestedBy: u.fullName, status: d!.online ? 'sent' : (b.type === 'config_mode' || b.type === 'recalibrate' ? 'expired' : 'queued'), error: null, createdAt: nowIso(), sentAt: d!.online ? nowIso() : null, ackedAt: null };
  (db.commands[d!.id] ||= []).unshift(row);
  audit(u, `device.command.${b.type}`, 'device', d!.serial);
  if (d!.online) setTimeout(() => {
    row.status = 'done'; row.ackedAt = nowIso();
    if (b.type === 'logs') (db.logs[d!.id] ||= []).unshift({ id: rid('lg'), createdAt: nowIso(), content: `[${new Date().toTimeString().slice(0, 8)}] I logs: upload requested\n[..] I wifi: rssi=${d!.rssi}\n[..] I radar: C1001 ok, mode=sleep\n[..] I mqtt: connected, queue=0` });
    mockEmit('command:status', { commandId: row.id, deviceId: d!.id, serial: d!.serial, type: row.type, status: 'done', error: null });
  }, 2000);
  return { commandId: row.id, status: row.status };
});
on('GET', '/admin/devices/([^/]+)/commands', (m) => { needStaff(me(), 'devices.view'); return { items: db.commands[m[1]] || [], nextCursor: null }; });
on('GET', '/admin/devices/([^/]+)/logs', (m) => { needStaff(me(), 'devices.view'); return { items: (db.logs[m[1]] || []).slice(0, 5) }; });
on('GET', '/admin/devices/([^/]+)/events', (m) => {
  needStaff(me(), 'devices.view');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  const t = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const items = d!.ownerId ? [
    { id: 'e5', type: 'bed_in', detail: null, createdAt: t(500) },
    { id: 'e4', type: 'bed_out', detail: 'session sid=128', createdAt: t(900) },
    { id: 'e3', type: d!.online ? 'online' : 'offline', detail: null, createdAt: t(d!.online ? 1400 : 2880) },
    { id: 'e2', type: 'claimed', detail: `by ${db.users.find((u) => u.id === d!.ownerId)?.fullName}`, createdAt: t(40000) },
    { id: 'e1', type: 'registered', detail: `by ${d!.registeredBy}`, createdAt: d!.registeredAt },
  ] : [{ id: 'e1', type: 'registered', detail: `by ${d!.registeredBy}`, createdAt: d!.registeredAt }];
  return { items, nextCursor: null };
});
on('DELETE', '/admin/devices/([^/]+)', (m) => {
  const u = me(); needStaff(u, 'devices.register');
  const d = db.devices.find((x) => x.id === m[1]); if (!d) fail(404, 'NOT_FOUND', 'Device not found');
  if (d!.ownerId) fail(409, 'DEVICE_IN_USE', 'Only a device that was never claimed can be deleted');
  db.devices = db.devices.filter((x) => x !== d);
  audit(u, 'device.delete', 'device', d!.serial);
  return undefined;
});

/* ---------- 9. firmware, team, audit, sleep rules ---------- */
on('GET', '/admin/firmware', () => { needStaff(me(), 'firmware.view'); return { items: db.firmware }; });
on('POST', '/admin/firmware', (_m, b) => {
  const u = me(); needStaff(u, 'firmware.upload');
  const fd = b as FormData;
  const version = String(fd.get('version') || '').trim(); const file = fd.get('file') as File | null;
  if (!file || !file.size) fail(400, 'VALIDATION', 'Choose a .bin file', 'file');
  if (file!.size > 4 * 1024 * 1024) fail(400, 'VALIDATION', 'The file is larger than 4 MB', 'file');
  if (!version) fail(400, 'VALIDATION', 'Enter a version, e.g. 1.4.4', 'version');
  if (db.firmware.some((f) => f.version === version)) fail(409, 'VERSION_EXISTS', 'This version is already uploaded', 'version');
  const rel = { id: rid('fw'), version, channel: (fd.get('channel') as 'beta' | 'stable') || 'beta', chipModel: 'ESP32-S3', fileSize: file!.size, sha256: '(computed by server)', notes: String(fd.get('notes') || '') || null, uploadedBy: u.fullName, createdAt: nowIso(), deviceCount: 0 };
  db.firmware.unshift(rel);
  audit(u, 'firmware.upload', 'release', version);
  return rel;
});
on('PATCH', '/admin/firmware/([^/]+)', (m, b) => { needStaff(me(), 'firmware.upload'); const f = db.firmware.find((x) => x.id === m[1]); if (!f) fail(404, 'NOT_FOUND', 'Not found'); Object.assign(f!, b); return f; });
on('DELETE', '/admin/firmware/([^/]+)', (m) => { needStaff(me(), 'firmware.upload'); const f = db.firmware.find((x) => x.id === m[1]); if (db.rollouts.some((r) => r.version === f?.version && r.status === 'running')) fail(409, 'IN_USE', 'A running rollout uses this version'); db.firmware = db.firmware.filter((x) => x.id !== m[1]); return undefined; });
on('GET', '/admin/ota/rollouts', () => { needStaff(me(), 'firmware.view'); return { items: db.rollouts }; });
on('POST', '/admin/ota/rollouts', (_m, b) => {
  const u = me(); needStaff(u, 'firmware.rollout');
  const f = db.firmware.find((x) => x.id === b.releaseId); if (!f) fail(400, 'VALIDATION', 'Pick a version', 'releaseId');
  const n = b.target === 'all' ? 418 : b.target === 'percent' ? Math.max(1, Math.round((418 * (b.percent || 0)) / 100)) : b.target === 'serials' ? (b.serials || []).length : 40;
  const label = b.target === 'all' ? `All devices (${n})` : b.target === 'percent' ? `${b.percent}% (${n} devices)` : b.target === 'serials' ? `${n} chosen devices` : `Devices on ${b.fromVersion} (${n})`;
  const r = { id: rid('r'), version: f!.version, target: label, createdBy: u.fullName, createdAt: nowIso(), status: 'running' as const, counts: { done: 0, downloading: Math.min(3, n), waiting: Math.max(0, n - 3), failed: 0 } };
  db.rollouts.unshift(r);
  audit(u, 'ota.rollout.start', 'release', f!.version, label);
  return { rolloutId: r.id, devices: n };
});
on('POST', '/admin/ota/rollouts/([^/]+)/(pause|resume|cancel|retry)', (m) => {
  needStaff(me(), 'firmware.rollout'); const r = db.rollouts.find((x) => x.id === m[1]); if (!r) fail(404, 'NOT_FOUND', 'Not found');
  if (m[2] === 'pause') r!.status = 'paused'; if (m[2] === 'resume') r!.status = 'running'; if (m[2] === 'cancel') { r!.status = 'cancelled'; r!.counts.waiting = 0; }
  if (m[2] === 'retry') { r!.counts.downloading += r!.counts.failed; r!.counts.failed = 0; }
  return undefined;
});
on('GET', '/admin/team', () => {
  needStaff(me(), 'team.manage');
  return { members: db.users.filter((u) => u.roleId).map((u) => { const r = db.roles.find((x) => x.id === u.roleId)!; return { userId: u.id, fullName: u.fullName, phone: u.phone, role: { id: r.id, name: r.name }, lastActiveAt: u.lastActiveAt }; }),
    invites: db.invites.filter((i) => i.kind === 'staff' && i.status === 'invite_sent').map((i) => { const r = db.roles.find((x) => x.id === i.roleId)!; return { id: i.id, label: i.label, role: { id: r.id, name: r.name }, expiresAt: i.expiresAt }; }) };
});
on('POST', '/admin/team/invites', (_m, b) => {
  const u = me(); needStaff(u, 'team.manage');
  // Link-only: {label, roleId}. No phone (owner decision 3 Nov).
  if (!b.label?.trim()) fail(400, 'VALIDATION', 'Who is it for? Add a label for your list', 'label');
  const role = db.roles.find((r) => r.id === Number(b.roleId)); if (!role) fail(400, 'VALIDATION', 'Pick a role', 'roleId');
  if (role!.isOwner && !db.roles.find((r) => r.id === u.roleId)?.isOwner) fail(403, 'FORBIDDEN', 'Only an Owner can invite another Owner');
  const token = Math.random().toString(36).slice(2, 14);
  const inv = { id: rid('inv'), token, kind: 'staff' as const, roleId: role!.id, label: b.label.trim(), invitedBy: u.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), status: 'invite_sent' as const };
  db.invites.push(inv);
  audit(u, 'team.invite', 'user', inv.label, `Role: ${role!.name}`);
  const inviteUrl = `${origin()}/invite/${token}`;
  return { invite: { id: inv.id, label: inv.label, role: { id: role!.id, name: role!.name }, expiresAt: inv.expiresAt }, inviteUrl, expiresAt: inv.expiresAt };
});
on('DELETE', '/admin/team/invites/([^/]+)', (m) => { needStaff(me(), 'team.manage'); const i = db.invites.find((x) => x.id === m[1]); if (i) i.status = 'cancelled'; return undefined; });
on('PATCH', '/admin/team/([^/]+)', (m, b) => {
  const u = me(); needStaff(u, 'team.manage');
  if (m[1] === u.id) fail(422, 'OWN_ROLE', 'You can’t change your own role');
  const t = db.users.find((x) => x.id === m[1] && x.roleId); if (!t) fail(404, 'NOT_FOUND', 'Not found');
  const ownerRole = db.roles.find((r) => r.isOwner)!;
  if (t!.roleId === ownerRole.id && db.users.filter((x) => x.roleId === ownerRole.id).length === 1) fail(422, 'LAST_OWNER', 'The Owner role needs at least one member');
  t!.roleId = Number(b.roleId);
  audit(u, 'team.member.role', 'user', t!.fullName, `Role: ${db.roles.find((r) => r.id === t!.roleId)?.name}`);
  return undefined;
});
on('DELETE', '/admin/team/([^/]+)', (m) => { const u = me(); needStaff(u, 'team.manage'); if (m[1] === u.id) fail(422, 'OWN_ROLE', 'You can’t remove yourself'); const t = db.users.find((x) => x.id === m[1]); if (t) t.roleId = null; return undefined; });
on('GET', '/admin/roles', () => {
  needStaff(me(), 'team.manage');
  return { roles: db.roles.map((r) => ({ ...r, memberCount: db.users.filter((u) => u.roleId === r.id).length })), permissions: STAFF_PERMS.map((p) => ({ ...p, scope: 'staff' })) };
});
on('POST', '/admin/roles', (_m, b) => {
  const u = me(); needStaff(u, 'team.manage');
  if (!b.name?.trim()) fail(400, 'VALIDATION', 'Name the role', 'name');
  if (db.roles.some((r) => r.name.toLowerCase() === b.name.trim().toLowerCase())) fail(409, 'ROLE_EXISTS', 'A role with this name exists', 'name');
  const r = { id: Math.max(...db.roles.map((x) => x.id)) + 1, name: b.name.trim(), isOwner: false, permissions: b.permissions || [] };
  db.roles.push(r); audit(u, 'team.role.create', 'role', r.name);
  return { ...r, memberCount: 0 };
});
on('PATCH', '/admin/roles/([^/]+)', (m, b) => {
  const u = me(); needStaff(u, 'team.manage');
  const r = db.roles.find((x) => x.id === Number(m[1])); if (!r) fail(404, 'NOT_FOUND', 'Not found');
  if (r!.isOwner) fail(409, 'ROLE_LOCKED', 'The Owner role always has every permission');
  if (b.name) r!.name = b.name; if (b.permissions) r!.permissions = b.permissions;
  audit(u, 'team.role.update', 'role', r!.name);
  return { ...r, memberCount: db.users.filter((x) => x.roleId === r!.id).length };
});
on('DELETE', '/admin/roles/([^/]+)', (m) => { needStaff(me(), 'team.manage'); const id = Number(m[1]); if (db.users.some((u) => u.roleId === id)) fail(409, 'ROLE_IN_USE', 'Move its members to another role first'); db.roles = db.roles.filter((r) => r.id !== id); return undefined; });
on('GET', '/admin/audit', (_m, _b, q) => {
  needStaff(me(), 'audit.view');
  const term = (q.get('q') || '').toLowerCase(); const a = q.get('action');
  const from = q.get('from'), to = q.get('to'); // YYYY-MM-DD, inclusive
  return { items: db.audit.filter((x) => (!a || x.action.startsWith(a)) && (!term || `${x.actorName} ${x.action} ${x.targetLabel} ${x.detail}`.toLowerCase().includes(term))
    && (!from || x.at.slice(0, 10) >= from) && (!to || x.at.slice(0, 10) <= to)), nextCursor: null };
});
on('GET', '/admin/platform-settings', () => { needStaff(me(), 'platform.settings'); return db.platform; });
on('PATCH', '/admin/platform-settings', (_m, b) => {
  const u = me(); needStaff(u, 'platform.settings');
  if (b.mergeGapMin !== undefined && (b.mergeGapMin < 0 || b.mergeGapMin > 240)) fail(400, 'VALIDATION', 'Use 0–240 minutes', 'mergeGapMin');
  if (b.minSessionMin !== undefined && (b.minSessionMin < 0 || b.minSessionMin > 120)) fail(400, 'VALIDATION', 'Use 0–120 minutes', 'minSessionMin');
  Object.assign(db.platform, b); audit(u, 'platform.settings.update', 'settings', 'Sleep rules');
  return db.platform;
});

/* ---------- dispatcher ---------- */
export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  await delay(120 + Math.random() * 180);
  const [p, query] = path.split('?');
  const q = new URLSearchParams(query || '');
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = p.match(re);
    if (match) return structuredCloneSafe(h(match, body ?? {}, q)) as T;
  }
  throw new ApiError(404, 'NOT_FOUND', `Mock has no route for ${method} ${p}`);
}
function structuredCloneSafe<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/* ---------- fake Socket.IO events (used by socket.ts in mock mode) ---------- */
/** Advance running rollouts every few seconds and emit rollout:progress, like the real OTA bridge. */
let rolloutTimer: ReturnType<typeof setInterval> | null = null;
export function startMockRollouts() {
  if (rolloutTimer) return;
  rolloutTimer = setInterval(() => {
    for (const r of db.rollouts) {
      if (r.status !== 'running') continue;
      const c = r.counts;
      if (c.downloading > 0) { const n = Math.min(c.downloading, 1 + Math.floor(Math.random() * 2)); c.downloading -= n; if (Math.random() < 0.1) c.failed += 1; else c.done += n; }
      if (c.waiting > 0) { const n = Math.min(c.waiting, 1 + Math.floor(Math.random() * 2)); c.waiting -= n; c.downloading += n; }
      if (!c.waiting && !c.downloading) r.status = 'finished';
      mockEmit('rollout:progress', { rolloutId: r.id, counts: { ...c }, status: r.status });
    }
  }, 2500);
}

type Listener = (payload: any) => void;
const listeners: Record<string, Set<Listener>> = {};
export function mockOn(ev: string, fn: Listener) { (listeners[ev] ||= new Set()).add(fn); }
export function mockOff(ev: string, fn: Listener) { listeners[ev]?.delete(fn); }
export function mockEmit(ev: string, payload: unknown) { listeners[ev]?.forEach((fn) => fn(payload)); }
export function mockDevice(id: string) { return db.devices.find((d) => d.id === id); }

/** Mixed mode (auth live, other areas mock): give the mock the same person the real backend logged in. */
export function mockAdopt(u: User | null) {
  if (!u) { setSession(null); return; }
  let m = db.users.find((x) => x.id === u.id || x.phone === u.phone);
  if (!m) { m = { id: u.id, fullName: u.fullName, phone: u.phone, country: u.country, roleId: u.role?.id ?? null, status: 'active', createdAt: u.createdAt, lastActiveAt: nowIso() }; db.users.push(m); }
  setSession(m.id);
}
