// Sample data for mock mode (same people and sensors as the approved mockup).
// Everything lives in memory: a page reload resets it, except who is logged in.

import type {
  AlertItem, AlertRule, DevicePerm, NightCard, NightDetail, SensorSettings, StaffPerm, AuditItem,
  FirmwareRelease, Rollout, CommandRow, PlatformSettings, GrantPerm,
} from '../types';

export const ALL_DEVICE_PERMS: DevicePerm[] = ['live.view', 'history.view', 'alerts.receive', 'settings.edit', 'sharing.manage'];
export const STAFF_PERMS: { code: StaffPerm; label: string }[] = [
  { code: 'devices.view', label: 'View devices' },
  { code: 'devices.command', label: 'Send device commands' },
  { code: 'devices.register', label: 'Register devices by USB' },
  { code: 'customers.view', label: 'View customers' },
  { code: 'customers.edit', label: 'Edit or disable customers' },
  { code: 'firmware.view', label: 'View firmware' },
  { code: 'firmware.upload', label: 'Upload firmware' },
  { code: 'firmware.rollout', label: 'Start OTA rollouts' },
  { code: 'team.manage', label: 'Manage team and roles' },
  { code: 'audit.view', label: 'View audit log' },
  { code: 'platform.settings', label: 'Change sleep rules' },
  { code: 'vendors.manage', label: 'Manage vendors' },
];
const ALL_STAFF = STAFF_PERMS.map((p) => p.code);

export interface MRole { id: number; name: string; isOwner: boolean; permissions: StaffPerm[] }
export interface MUser {
  id: string; fullName: string; phone: string; country: string; roleId: number | null;
  status: 'active' | 'disabled'; createdAt: string; lastActiveAt: string | null; password?: string;
}
export interface MDevice {
  id: string; serial: string; name: string | null; room: string | null; tz: string | null; place: string | null;
  ownerId: string | null; online: boolean; lastSeenAt: string | null; fw: string; chip: string; mac: string;
  hwModel: string; batch: string | null; manufacturedAt: string | null; registeredAt: string; registeredBy: string;
  ip: string | null; wifiSsid: string | null; rssi: number | null; uptimeS: number | null;
  sleepCutoff: string; autoUpdate: boolean; isDisabled: boolean; disabledReason: string | null;
  claimCode: string | null; sensor: SensorSettings;
  /** §15: a vendor device has vendorId set and no person owner */
  vendorId?: string | null; groupId?: string | null;
  base: { hr: number; br: number; bed: number; ss: number };
}
export interface MVendor { id: string; name: string; contactName: string | null; phone: string | null; email: string | null; status: 'active' | 'disabled'; createdAt: string }
export interface MVendorMember { vendorId: string; userId: string; role: 'owner' | 'staff'; joinedAt: string }
export interface MGroup { id: string; vendorId: string; name: string }
export interface MGrant {
  id: string; vendorId: string; deviceId: string; label: string; userId: string | null; permissions: GrantPerm[];
  startsAt: string; endsAt: string; inviteExpiresAt: string | null; endedAt: string | null; createdAt: string; createdBy: string;
}
export interface MShare { deviceId: string; userId: string; permissions: DevicePerm[] }
export interface MInvite {
  id: string; token: string; kind: 'device' | 'staff' | 'vendor' | 'grant'; deviceId?: string; roleId?: number; label: string;
  vendorId?: string; vendorRole?: 'owner' | 'staff'; grantId?: string;
  permissions?: DevicePerm[]; invitedBy: string; expiresAt: string; status: 'invite_sent' | 'accepted' | 'cancelled';
}

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();
const sensor = (v = 4): SensorSettings => ({ exitS: 300, liveS: 5, idleS: 60, struggle: true, unattended: false, unattMin: 30, version: v, appliedVersion: v, sync: 'applied' });

export const db = {
  roles: [
    { id: 1, name: 'Owner', isOwner: true, permissions: [...ALL_STAFF] },
    { id: 2, name: 'Developer', isOwner: false, permissions: ALL_STAFF.filter((p) => p !== 'team.manage') },
    { id: 3, name: 'Manufacturing', isOwner: false, permissions: ['devices.view', 'devices.register', 'firmware.view'] },
    { id: 4, name: 'Support', isOwner: false, permissions: ['devices.view', 'devices.command', 'customers.view', 'audit.view'] },
  ] as MRole[],
  users: [
    { id: 'u-priya', fullName: 'Priya Shah', phone: '+919825012345', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(32), lastActiveAt: ago(5) },
    { id: 'u-rohan', fullName: 'Rohan Shah', phone: '+971503182264', country: 'AE', roleId: null, status: 'active', createdAt: daysAgo(30), lastActiveAt: ago(300) },
    { id: 'u-anita', fullName: 'Anita Shah', phone: '+14155550142', country: 'US', roleId: null, status: 'active', createdAt: daysAgo(29), lastActiveAt: ago(900) },
    { id: 'u-arjun', fullName: 'Arjun Mehta', phone: '+919924577810', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(26), lastActiveAt: ago(60) },
    { id: 'u-fatima', fullName: 'Fatima Shaikh', phone: '+971504127781', country: 'AE', roleId: null, status: 'active', createdAt: daysAgo(25), lastActiveAt: ago(1500) },
    { id: 'u-neha', fullName: 'Neha Iyer', phone: '+919004031122', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(22), lastActiveAt: ago(4300) },
    { id: 'u-sunrise', fullName: 'Kavita Nair', phone: '+917948902200', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(14), lastActiveAt: ago(20) },
    { id: 'u-meera', fullName: 'Meera Joshi', phone: '+919825077301', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(12), lastActiveAt: ago(40) },
    { id: 'u-ramesh', fullName: 'Ramesh Kumar', phone: '+919811044520', country: 'IN', roleId: null, status: 'active', createdAt: daysAgo(3), lastActiveAt: ago(90) },
    { id: 'u-vikram', fullName: 'Vikram Rao', phone: '+447700900461', country: 'GB', roleId: null, status: 'disabled', createdAt: daysAgo(6), lastActiveAt: ago(8640) },
    { id: 'u-devam', fullName: 'Devam Gandhi', phone: '+919898011223', country: 'IN', roleId: 1, status: 'active', createdAt: daysAgo(40), lastActiveAt: ago(1) },
    { id: 'u-aarav', fullName: 'Aarav Desai', phone: '+919979022014', country: 'IN', roleId: 2, status: 'active', createdAt: daysAgo(38), lastActiveAt: ago(60) },
    { id: 'u-kiran', fullName: 'Kiran Patel', phone: '+919723044871', country: 'IN', roleId: 3, status: 'active', createdAt: daysAgo(38), lastActiveAt: ago(200) },
    { id: 'u-sneha', fullName: 'Sneha Trivedi', phone: '+919512080345', country: 'IN', roleId: 4, status: 'active', createdAt: daysAgo(20), lastActiveAt: ago(1500) },
  ] as MUser[],
  devices: [] as MDevice[],
  shares: [] as MShare[],
  invites: [] as MInvite[],
  alerts: [] as AlertItem[],
  rules: {} as Record<string, AlertRule[]>,
  firmware: [
    { id: 'fw-3', version: '1.4.3-beta', channel: 'beta', chipModel: 'ESP32-S3', fileSize: 1300234, sha256: '9f2c4e…a71e', notes: 'Faster presence detection; fixes Wi-Fi reconnect loop', uploadedBy: 'Aarav Desai', createdAt: daysAgo(2), deviceCount: 18 },
    { id: 'fw-2', version: '1.4.2', channel: 'stable', chipModel: 'ESP32-S3', fileSize: 1268776, sha256: '4b8d11…02c3', notes: 'Session upload retry', uploadedBy: 'Aarav Desai', createdAt: daysAgo(14), deviceCount: 402 },
    { id: 'fw-1', version: '1.3.9', channel: 'stable', chipModel: 'ESP32-S3', fileSize: 1237354, sha256: 'e1a0f7…9bd4', notes: 'First production build', uploadedBy: 'Devam Gandhi', createdAt: daysAgo(36), deviceCount: 18 },
  ] as FirmwareRelease[],
  rollouts: [
    { id: 'r-7', version: '1.4.3-beta', target: '5% (20 devices)', createdBy: 'Aarav Desai', createdAt: daysAgo(2), status: 'running', counts: { done: 12, downloading: 5, waiting: 1, failed: 1, deferred: 1 } },
    { id: 'r-6', version: '1.4.2', target: 'All devices (418)', createdBy: 'Devam Gandhi', createdAt: daysAgo(13), status: 'finished', counts: { done: 402, downloading: 0, waiting: 14, failed: 2 } },
  ] as Rollout[],
  commands: {} as Record<string, CommandRow[]>,
  logs: {} as Record<string, { id: string; createdAt: string; content: string }[]>,
  audit: [] as AuditItem[],
  platform: { mergeGapMin: 30, minSessionMin: 25, defaultSleepCutoff: '12:00' } as PlatformSettings,
  // API.md 2.5/2.6 per user. Alerts are in-app only in v1; mutedDeviceIds = "Show me alerts from" switched off.
  vendors: [] as MVendor[],
  vendorMembers: [] as MVendorMember[],
  groups: [] as MGroup[],
  grants: [] as MGrant[],
  prefs: {} as Record<string, { quietEnabled: boolean; quietFrom: string; quietTo: string; mutedDeviceIds: string[] }>,
};

function dev(i: string, o: Partial<MDevice>): MDevice {
  return {
    id: `d-${i}`, serial: `ARG-24A${i}`, name: null, room: null, tz: null, place: null, ownerId: null, online: false, lastSeenAt: null,
    fw: '1.4.2', chip: 'ESP32-S3', mac: '', hwModel: 'ARG-S1 rev B', batch: 'B-2026-10-A', manufacturedAt: '2026-10-01',
    registeredAt: daysAgo(30), registeredBy: 'Kiran Patel', ip: null, wifiSsid: null, rssi: null, uptimeS: null,
    sleepCutoff: '12:00', autoUpdate: true, isDisabled: false, disabledReason: null, claimCode: null, sensor: sensor(),
    base: { hr: 62, br: 14, bed: 1, ss: 1 }, ...o,
  };
}
db.devices = [
  dev('0012', { name: "Mom's bedroom", room: 'Master bedroom', tz: 'Asia/Kolkata', place: 'Surat', ownerId: 'u-priya', online: true, lastSeenAt: ago(0), mac: '34:85:18:A1:0F:22', ip: '192.168.1.41', wifiSsid: 'Shah_Home_5G', rssi: -57, uptimeS: 533000, base: { hr: 61, br: 14, bed: 1, ss: 1 } }),
  dev('0013', { name: "Dad's room", room: 'Second bedroom', tz: 'Asia/Kolkata', place: 'Surat', ownerId: 'u-priya', online: true, lastSeenAt: ago(0), mac: '34:85:18:A1:0F:5E', ip: '192.168.1.42', wifiSsid: 'Shah_Home_5G', rssi: -63, uptimeS: 533000, base: { hr: 57, br: 12, bed: 1, ss: 0 } }),
  dev('0019', { name: 'Guest room', room: 'Guest room', tz: 'Asia/Kolkata', place: 'Surat', ownerId: 'u-priya', online: false, lastSeenAt: daysAgo(2), fw: '1.3.9', mac: '34:85:18:A1:11:07', wifiSsid: 'Shah_Home_5G', sensor: { ...sensor(3), version: 4, sync: 'queued_offline' } }),
  dev('0021', { name: 'Bedroom', room: 'Bedroom', tz: 'Asia/Kolkata', place: 'Mumbai', ownerId: 'u-arjun', online: true, lastSeenAt: ago(0), mac: '34:85:18:A1:13:9C', ip: '10.0.0.18', rssi: -61, uptimeS: 212000, base: { hr: 66, br: 15, bed: 1, ss: 1 } }),
  dev('0022', { name: 'Nani', room: 'Ground floor', tz: 'Asia/Dubai', place: null, ownerId: 'u-fatima', online: true, lastSeenAt: ago(0), fw: '1.4.3-beta', mac: '34:85:18:A1:13:A4', ip: '192.168.0.77', rssi: -70, uptimeS: 39700, base: { hr: 72, br: 17, bed: 0, ss: 2 } }),
  dev('0026', { name: 'Main bedroom', room: 'Bedroom', tz: 'Asia/Kolkata', place: 'Chennai', ownerId: 'u-neha', online: false, lastSeenAt: ago(300), mac: '34:85:18:A1:15:30' }),
  dev('0027', { name: 'Kids room', room: 'Bedroom 2', tz: 'Asia/Kolkata', place: 'Chennai', ownerId: 'u-neha', online: true, lastSeenAt: ago(0), mac: '34:85:18:A1:15:3B', rssi: -55, uptimeS: 371000, base: { hr: 79, br: 19, bed: 1, ss: 1 } }),
  dev('0030', { name: 'Room 4', room: 'Ward B', tz: 'Asia/Kolkata', place: 'Ahmedabad', ownerId: null, vendorId: 'v-sunrise', groupId: 'g-wardb', online: true, lastSeenAt: ago(0), fw: '1.4.3-beta', mac: '34:85:18:A1:17:F1', rssi: -66, uptimeS: 781000, base: { hr: 64, br: 13, bed: 1, ss: 0 } }),
  dev('0033', { name: 'Room 7', room: 'Ward C', tz: 'Asia/Kolkata', place: 'Ahmedabad', vendorId: 'v-sunrise', groupId: 'g-wardc', online: true, lastSeenAt: ago(0), mac: '34:85:18:A1:17:F9', rssi: -59, uptimeS: 402000, base: { hr: 70, br: 15, bed: 1, ss: 1 } }),
  dev('0034', { name: 'Room 9', room: null, tz: 'Asia/Kolkata', place: 'Ahmedabad', vendorId: 'v-sunrise', online: false, lastSeenAt: ago(180), mac: '34:85:18:A1:17:FE' }),
  dev('0031', { mac: '34:85:18:A1:18:02', registeredAt: ago(30 * 60), claimCode: 'K7P29XQM4HTR' }),
  dev('0032', { mac: '34:85:18:A1:18:0D', registeredAt: ago(29 * 60), claimCode: 'W3RT8MNB6KQZ' }),
];
db.shares = [
  { deviceId: 'd-0012', userId: 'u-rohan', permissions: ['live.view', 'history.view', 'alerts.receive'] },
  { deviceId: 'd-0012', userId: 'u-anita', permissions: ['live.view', 'history.view', 'alerts.receive', 'settings.edit'] },
  { deviceId: 'd-0013', userId: 'u-rohan', permissions: ['live.view', 'history.view', 'alerts.receive'] },
];
db.invites = [
  { id: 'inv-1', token: 'demo-family', kind: 'device', deviceId: 'd-0012', label: 'Dr. Mehul Joshi', permissions: ['history.view'], invitedBy: 'u-priya', expiresAt: new Date(now + 5 * 86400000).toISOString(), status: 'invite_sent' },
  { id: 'inv-2', token: 'demo-staff', kind: 'staff', roleId: 4, label: 'Meet Shah', invitedBy: 'u-devam', expiresAt: new Date(now + 6 * 86400000).toISOString(), status: 'invite_sent' },
];
db.vendors = [
  { id: 'v-sunrise', name: 'Sunrise Care Home', contactName: 'Dr. Kavita Nair', phone: '+917948902200', email: 'admin@sunrisecare.example', status: 'active', createdAt: daysAgo(14) },
  { id: 'v-city', name: 'City Hospital', contactName: 'Mr. Sanjay Rao', phone: '+912266001100', email: null, status: 'active', createdAt: daysAgo(2) },
];
db.vendorMembers = [
  { vendorId: 'v-sunrise', userId: 'u-sunrise', role: 'owner', joinedAt: daysAgo(14) },
  { vendorId: 'v-sunrise', userId: 'u-meera', role: 'staff', joinedAt: daysAgo(12) },
];
db.groups = [
  { id: 'g-wardb', vendorId: 'v-sunrise', name: 'Ward B' },
  { id: 'g-wardc', vendorId: 'v-sunrise', name: 'Ward C' },
];
db.grants = [
  { id: 'gr-1', vendorId: 'v-sunrise', deviceId: 'd-0030', label: 'Ramesh (son)', userId: 'u-ramesh', permissions: ['live.view', 'history.view', 'alerts.receive'],
    startsAt: daysAgo(2), endsAt: new Date(now + 3 * 86400000).toISOString(), inviteExpiresAt: null, endedAt: null, createdAt: daysAgo(2.1), createdBy: 'u-sunrise' },
  { id: 'gr-2', vendorId: 'v-sunrise', deviceId: 'd-0033', label: 'Mrs. Gupta (daughter)', userId: null, permissions: ['live.view', 'history.view', 'alerts.receive'],
    startsAt: ago(60), endsAt: new Date(now + 5 * 86400000).toISOString(), inviteExpiresAt: new Date(now + 5 * 86400000).toISOString(), endedAt: null, createdAt: ago(70), createdBy: 'u-meera' },
];
db.invites.push(
  { id: 'inv-3', token: 'demo-vendor', kind: 'vendor', vendorId: 'v-sunrise', vendorRole: 'staff', label: 'Nurse Pooja', invitedBy: 'u-sunrise', expiresAt: new Date(now + 6 * 86400000).toISOString(), status: 'invite_sent' },
  { id: 'inv-4', token: 'demo-grant', kind: 'grant', vendorId: 'v-sunrise', grantId: 'gr-2', deviceId: 'd-0033', label: 'Mrs. Gupta (daughter)', invitedBy: 'u-meera', expiresAt: new Date(now + 5 * 86400000).toISOString(), status: 'invite_sent' },
);
db.alerts = [
  { id: 'al-4', deviceId: 'd-0013', deviceName: "Dad's room", type: 'out_of_bed', severity: 'warning', title: 'Out of bed for 14 min', detail: 'Rule: out of bed more than 10 min between 23:00 and 06:00', value: 14, startedAt: ago(330), endedAt: ago(316) },
  { id: 'al-3', deviceId: 'd-0012', deviceName: "Mom's bedroom", type: 'breath_low', severity: 'critical', title: 'Breathing rate low: 7 /min', detail: 'Rule: breath rate below 8 /min for 30 s', value: 7, startedAt: ago(415), endedAt: ago(413) },
  { id: 'al-2', deviceId: 'd-0019', deviceName: 'Guest room', type: 'device_offline', severity: 'warning', title: 'Sensor offline', detail: 'No data for more than 15 min. Check power and Wi-Fi.', value: null, startedAt: daysAgo(2), endedAt: null },
  { id: 'al-1', deviceId: 'd-0012', deviceName: "Mom's bedroom", type: 'hr_out_of_range', severity: 'critical', title: 'Heart rate high: 112 bpm', detail: 'Rule: heart rate above 110 bpm for 60 s', value: 112, startedAt: daysAgo(2.2), endedAt: daysAgo(2.19) },
];
export const defaultRules = (): AlertRule[] => [
  { type: 'breath_low', enabled: true, low: 8, high: null, durationS: 30, windowFrom: null, windowTo: null },
  { type: 'hr_out_of_range', enabled: true, low: 45, high: 110, durationS: 60, windowFrom: null, windowTo: null },
  { type: 'out_of_bed', enabled: true, low: null, high: null, durationS: 600, windowFrom: '23:00', windowTo: '06:00' },
  { type: 'no_movement', enabled: false, low: null, high: null, durationS: 10800, windowFrom: null, windowTo: null },
  { type: 'device_offline', enabled: true, low: null, high: null, durationS: 900, windowFrom: null, windowTo: null },
];
db.commands['d-0012'] = [
  { id: 'c-2', type: 'ota_check', requestedBy: 'Aarav Desai', status: 'done', error: null, createdAt: daysAgo(13), sentAt: daysAgo(13), ackedAt: daysAgo(13) },
  { id: 'c-1', type: 'logs', requestedBy: 'Sneha Trivedi', status: 'done', error: null, createdAt: daysAgo(16), sentAt: daysAgo(16), ackedAt: daysAgo(16) },
];
db.logs['d-0012'] = [{ id: 'lg-1', createdAt: daysAgo(16), content: '[06:41:02] I wifi: connected, rssi=-57\n[06:41:02] I mqtt: connected to broker\n[06:41:03] I radar: Sensor init ok, mode=sleep\n[06:42:10] I radar: presence=1 hr=61 br=14\n[06:50:00] I session: sid=128 queued, sent, acked\n[07:05:13] W wifi: rssi dropped to -78\n[07:05:19] I wifi: rssi back to -58' }];
db.audit = [
  { id: 'a-10', at: ago(60), actorName: 'Devam Gandhi', action: 'team.role.update', targetType: 'role', targetLabel: 'Manufacturing', detail: 'Turned on firmware.view' },
  { id: 'a-9', at: ago(29 * 60), actorName: 'Kiran Patel', action: 'device.register', targetType: 'device', targetLabel: 'ARG-24A0032', detail: 'MAC 34:85:18:A1:18:0D · ESP32-S3' },
  { id: 'a-8', at: ago(30 * 60), actorName: 'Kiran Patel', action: 'device.register', targetType: 'device', targetLabel: 'ARG-24A0031', detail: 'MAC 34:85:18:A1:18:02 · ESP32-S3' },
  { id: 'a-7', at: ago(40 * 60), actorName: 'Priya Shah', action: 'share.invite', targetType: 'device', targetLabel: 'ARG-24A0012', detail: 'Invite link for Dr. Mehul Joshi (history only)' },
  { id: 'a-6', at: ago(45 * 60), actorName: 'Sneha Trivedi', action: 'device.command.reboot', targetType: 'device', targetLabel: 'ARG-24A0022', detail: 'Sent · acked in 2.1 s' },
  { id: 'a-5', at: daysAgo(1.4), actorName: 'Arjun Mehta', action: 'device.claim', targetType: 'device', targetLabel: 'ARG-24A0021', detail: 'Claimed by QR scan' },
  { id: 'a-4', at: daysAgo(2), actorName: 'Aarav Desai', action: 'ota.rollout.start', targetType: 'release', targetLabel: '1.4.3-beta', detail: '5% canary, 20 devices' },
  { id: 'a-3', at: daysAgo(2.01), actorName: 'Aarav Desai', action: 'firmware.upload', targetType: 'release', targetLabel: '1.4.3-beta', detail: '1.24 MB · sha256 9f2c…a71e' },
  { id: 'a-2', at: daysAgo(3), actorName: 'Devam Gandhi', action: 'customer.disable', targetType: 'user', targetLabel: 'Vikram Rao', detail: 'Reason: duplicate account' },
  { id: 'a-1', at: daysAgo(4), actorName: 'Devam Gandhi', action: 'team.invite', targetType: 'user', targetLabel: 'Sneha Trivedi', detail: 'Role: Support' },
];

/* ---------------- nights ----------------
   Mirrors the server rules (API.md §4): sessions joined across short gaps, the gap counts as
   out of bed, the longest group is the main sleep, other groups are naps. */

function rng(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const TZ_OFFSET_MIN: Record<string, number> = { 'Asia/Kolkata': 330, 'Asia/Dubai': 240, 'Europe/London': 0 };

function genHyp(r: () => number, steps: number): string {
  const seg: string[] = [];
  const onset = 2 + Math.floor(r() * 4);
  for (let k = 0; k < onset; k++) seg.push('A');
  let c = 0;
  while (seg.length < steps) {
    const plan: [string, number][] = [['L', 4 + Math.floor(r() * 3)], ['D', Math.max(0, 8 - c * 2 + Math.floor(r() * 3))], ['L', 3 + c + Math.floor(r() * 3)]];
    if (r() < 0.45) plan.push(['A', 1 + Math.floor(r() * 2)]);
    if (r() < 0.1) plan.push(['O', 1 + Math.floor(r() * 2)]);
    for (const [s, n] of plan) for (let k = 0; k < n; k++) seg.push(s);
    c++;
  }
  seg.length = steps;
  seg[steps - 1] = 'A';
  return seg.join('');
}

const nightCache: Record<string, NightDetail[]> = {};
export function nightsFor(deviceId: string, tz: string): NightDetail[] {
  if (nightCache[deviceId]) return nightCache[deviceId];
  const off = TZ_OFFSET_MIN[tz] ?? 330;
  const localNow = new Date(now + off * 60000);
  const out: NightDetail[] = [];
  for (let i = 0; i < 14; i++) {
    const r = rng(hash(deviceId) + i * 977);
    const day = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() - 1 - i));
    const sleepDate = day.toISOString().slice(0, 10);
    const iso = (localMin: number) => new Date(day.getTime() + (localMin - off) * 60000).toISOString();
    if (i === 3) {
      // A nap-only day (e.g. a night away from home): no group reached 3 h in bed, so no main sleep.
      const s = 15 * 60 + 10, l = 45;
      out.push({ sleepDate, hasMainSleep: false, start: null, end: null, score: null, totalSleepMin: null, inBedMin: null, stageMin: null, sessionCount: 0,
        naps: [{ start: iso(s), end: iso(s + l), totalSleepMin: l - 10, hyp: genHyp(r, l / 5) }],
        efficiencyPct: null, wakeUps: null, exits: null, oobMin: null, sessions: null, epochS: 300, hyp: null, hr: null, br: null,
        turns: null, bigMvPct: null, smallMvPct: null, apnea: null, struggles: null });
      continue;
    }
    const bed = 22 * 60 + 40 + Math.floor(r() * 14) * 5;
    const len = 390 + Math.floor(r() * 18) * 5;
    let ses = [{ s: bed, e: bed + len }];
    if (i === 0 || r() < 0.3) {
      const cut = Math.round((len * (0.35 + r() * 0.3)) / 5) * 5;
      const gap = 10 + Math.floor(r() * 4) * 5;
      ses = [{ s: bed, e: bed + cut }, { s: bed + cut + gap, e: bed + len }];
    }
    const hyps = ses.map((s) => genHyp(r, Math.round((s.e - s.s) / 5)));
    let hyp = '';
    ses.forEach((s, k) => { if (k) hyp += 'O'.repeat(Math.round((s.s - ses[k - 1].e) / 5)); hyp += hyps[k]; });
    const cnt = { D: 0, L: 0, A: 0, O: 0 } as Record<string, number>;
    for (const ch of hyp) cnt[ch]++;
    const span = ses[ses.length - 1].e - bed;
    const inBed = ses.reduce((a, s) => a + s.e - s.s, 0);
    const total = (cnt.D + cnt.L) * 5;
    let wake = 0; let seenSleep = false;
    for (let k = 0; k < hyp.length; k++) { if (hyp[k] === 'D' || hyp[k] === 'L') seenSleep = true; else if (seenSleep && hyp[k] === 'A' && hyp[k - 1] !== 'A' && k < hyp.length - 1) wake++; }
    let exits = 0; for (let k = 1; k < hyp.length; k++) if (hyp[k] === 'O' && hyp[k - 1] !== 'O') exits++;
    const score = Math.max(42, Math.min(96, Math.round(28 + total / 9 + (cnt.D * 5) / 7 - wake * 4)));
    const hrAvg = 54 + Math.floor(r() * 9), brAvg = 12 + Math.floor(r() * 4);
    const naps: NightDetail['naps'] = [];
    if (i === 1 || r() < 0.25) {
      const s = 14 * 60 + Math.floor(r() * 12) * 10, l = 30 + Math.floor(r() * 5) * 10;
      naps.push({ start: iso(s), end: iso(s + l), totalSleepMin: l - 10, hyp: genHyp(r, l / 5) });
    }
    out.push({
      sleepDate, hasMainSleep: true, start: iso(bed), end: iso(bed + span), score, totalSleepMin: total, inBedMin: inBed,
      stageMin: { deep: cnt.D * 5, light: cnt.L * 5, awake: cnt.A * 5, outOfBed: cnt.O * 5 },
      sessionCount: ses.length, naps,
      efficiencyPct: Math.round((total / span) * 100), wakeUps: wake, exits, oobMin: cnt.O * 5,
      sessions: ses.map((s, k) => ({ id: `${sleepDate.replace(/-/g, "")}${k + 1}`, start: iso(s.s), end: iso(s.e) })), epochS: 300, hyp,
      hr: { avg: hrAvg, min: hrAvg - 6 - Math.floor(r() * 3), max: hrAvg + 14 + Math.floor(r() * 10) },
      br: { avg: brAvg, min: brAvg - 3, max: brAvg + 4 + Math.floor(r() * 3) },
      turns: 9 + Math.floor(r() * 18), bigMvPct: 3 + Math.floor(r() * 6), smallMvPct: 14 + Math.floor(r() * 12),
      apnea: r() < 0.2 ? 1 : 0, struggles: 0,
    });
  }
  return (nightCache[deviceId] = out);
}

/** A fixed sample night for the login artwork (same on server and client, so no hydration mismatch). */
export function sampleHyp(): string {
  const r = rng(42);
  return genHyp(r, 44) + 'OOO' + genHyp(r, 46);
}

export function nightCard(n: NightDetail): NightCard {
  const { sleepDate, hasMainSleep, start, end, score, totalSleepMin, inBedMin, stageMin, sessionCount, naps } = n;
  return { sleepDate, hasMainSleep, start, end, score, totalSleepMin, inBedMin, stageMin, sessionCount, naps: naps.map(({ start, end }) => ({ start, end })) };
}
