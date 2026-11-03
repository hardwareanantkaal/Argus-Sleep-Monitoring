// Shapes from docs/API.md v1.0. Keep these in step with the contract.

export type DevicePerm = 'live.view' | 'history.view' | 'alerts.receive' | 'settings.edit' | 'sharing.manage';
export type StaffPerm =
  | 'devices.view' | 'devices.command' | 'devices.register'
  | 'customers.view' | 'customers.edit'
  | 'firmware.view' | 'firmware.upload' | 'firmware.rollout'
  | 'team.manage' | 'audit.view' | 'platform.settings';

export interface User {
  id: string;
  fullName: string;
  phone: string;
  country: string; // ISO-2
  kind: 'customer' | 'admin';
  role: { id: number; name: string } | null;
  permissions: StaffPerm[];
  createdAt: string;
}

export interface LiveValues {
  pr: number; bed: number; ss: number; hr: number; br: number;
  bs?: number; mv?: number; mr?: number; dist?: number; rssi?: number; at: string;
}

export interface DeviceCard {
  id: string;
  serial: string;
  name: string;
  room: string | null;
  tz: string;
  place: string | null;
  isOwner: boolean;
  sharedBy: { fullName: string } | null;
  myPermissions: DevicePerm[];
  status: { online: boolean; lastSeenAt: string | null };
  live?: LiveValues | null;
  lastNight?: { sleepDate: string; score: number; totalSleepMin: number } | null;
}

export interface SensorSettings {
  exitS: number; liveS: number; idleS: number; struggle: boolean; unattended: boolean; unattMin: number;
  version: number; appliedVersion: number; sync: 'applied' | 'sending' | 'queued_offline';
}

export interface DeviceDetail extends DeviceCard {
  sleepCutoff: string;
  autoUpdate: boolean;
  hwModel: string;
  connection?: { fw: string; rssi: number | null; wifiSsid: string | null; uptimeS: number | null };
  sensorSync?: { version: number; appliedVersion: number; sync: SensorSettings['sync'] };
}

export interface StageMin { deep: number; light: number; awake: number; outOfBed: number }

export interface NightCard {
  sleepDate: string;
  start: string;
  end: string;
  score: number;
  totalSleepMin: number;
  inBedMin: number;
  stageMin: StageMin;
  sessionCount: number;
  naps: { start: string; end: string }[];
}

export interface NightDetail extends NightCard {
  efficiencyPct: number;
  wakeUps: number;
  exits: number;
  oobMin: number;
  sessions: { start: string; end: string }[];
  epochS: number;
  hyp: string;
  hr: { avg: number; min: number; max: number };
  br: { avg: number; min: number; max: number };
  turns: number; bigMvPct: number; smallMvPct: number; apnea: number; struggles: number;
  naps: { start: string; end: string; totalSleepMin?: number; hyp?: string }[];
}

export interface NightsResponse {
  device: { tz: string; place: string | null };
  nights: NightCard[];
  averages: { nights: number; totalSleepMin: number; score: number; hrAvg: number; wakeUps: number };
}

export interface Share { userId: string; fullName: string; phone: string; permissions: DevicePerm[]; status: 'joined' }
// Invites are link-only (owner decision 3 Nov): a label for the inviter's list, no phone.
// The link itself is shown only once, in the create response (only its hash is stored).
export interface Invite { id: string; label: string; permissions: DevicePerm[]; status: 'invite_sent'; expiresAt: string }
export interface InviteCreated { invite?: Invite; inviteUrl: string; expiresAt: string }
export interface SharesResponse { owner: { fullName: string; phone: string }; shares: Share[]; invites: Invite[] }

export interface InvitePreview {
  kind: 'device' | 'staff';
  inviterName: string;
  deviceName?: string;
  place?: string | null;
  roleName?: string;
  permissions?: (DevicePerm | StaffPerm)[];
  expiresAt: string;
  status?: 'invite_sent' | 'accepted' | 'cancelled' | 'expired';
}

export type AlertType = 'breath_low' | 'hr_out_of_range' | 'out_of_bed' | 'no_movement' | 'device_offline';
export interface AlertItem {
  id: string; deviceId: string; deviceName: string; type: AlertType; severity: 'critical' | 'warning';
  title: string; detail: string; value: number | null; startedAt: string; endedAt: string | null;
}
export interface AlertRule {
  type: AlertType; enabled: boolean; low: number | null; high: number | null; durationS: number | null;
  windowFrom: string | null; windowTo: string | null;
}

export interface List<T> { items: T[]; nextCursor?: string | null; total?: number }

/* ---- admin ---- */
export interface Dashboard {
  counts: { registered: number; online: number; offline: number; unclaimed: number; disabled: number; customers: number;
    registeredThisWeek: number; customersThisWeek: number; rolloutsRunning: number };
  onlineHourly: { hour: string; online: number }[];
  fwVersions: { version: string; count: number }[];
  recentAudit?: AuditItem[];
}
export interface AdminDeviceRow {
  id: string; serial: string; name: string | null; owner: { id: string; fullName: string } | null;
  online: boolean; tz: string | null; fw: string | null; chip: string; lastSeenAt: string | null; createdAt: string;
}
export interface AdminDeviceDetail {
  id: string; serial: string; name: string | null;
  hardware: { mac: string; chip: string; radar: string; hwModel: string; batch: string | null; manufacturedAt: string | null;
    fwAtRegister: string | null; registeredAt: string; registeredBy: string };
  connection: { online: boolean; lastSeenAt: string | null; ip: string | null; wifiSsid: string | null; rssi: number | null;
    uptimeS: number | null; fw: string | null; radarOk: boolean | null };
  tz: string | null; place: string | null; sleepCutoff: string; isDisabled: boolean; disabledReason: string | null;
  owner: { id: string; fullName: string; phone: string } | null;
  shares: { fullName: string; phone: string }[];
  claimCodeActive: boolean;
  sensorSettings: SensorSettings | null;
}
export type CommandType = 'reboot' | 'config_mode' | 'ota_check' | 'logs';
export interface CommandRow {
  id: string; type: CommandType; requestedBy: string; status: 'queued' | 'sent' | 'acked' | 'done' | 'failed' | 'expired';
  error: string | null; createdAt: string; sentAt: string | null; ackedAt: string | null;
}
export interface DeviceEvent { id: string; type: string; detail: string | null; createdAt: string }
export interface RegisterResult {
  device: { id: string }; serial: string; claimCode: string; qrPayload: string; qrPngBase64: string | null; stickerHtml: string | null;
}
export interface CustomerRow {
  id: string; fullName: string; phone: string; country: string; deviceTimeZones: string[]; deviceCount: number;
  familyCount: number; createdAt: string; lastActiveAt: string | null; status: 'active' | 'disabled';
}
export interface CustomerDetail extends CustomerRow {
  devices: { id: string; serial: string; name: string; tz: string; online: boolean; fw: string | null; lastSeenAt: string | null }[];
  family: { fullName: string; phone: string; deviceName: string }[];
}
export interface FirmwareRelease {
  id: string; version: string; channel: 'stable' | 'beta'; chipModel: string; fileSize: number; sha256: string;
  notes: string | null; uploadedBy: string; createdAt: string; deviceCount: number;
}
export interface Rollout {
  id: string; version: string; target: string; createdBy: string; createdAt: string;
  status: 'running' | 'paused' | 'finished' | 'cancelled';
  counts: { done: number; downloading: number; waiting: number; failed: number };
}
export interface TeamResponse {
  members: { userId: string; fullName: string; phone: string; role: { id: number; name: string }; lastActiveAt: string | null }[];
  invites: { id: string; label: string; role: { id: number; name: string }; expiresAt: string }[];
}
export interface Role { id: number; name: string; isOwner: boolean; permissions: StaffPerm[]; memberCount: number }
export interface RolesResponse { roles: Role[]; permissions: { code: StaffPerm; label: string; scope: 'staff' }[] }
export interface AuditItem { id: string; at: string; actorName: string; action: string; targetType: string; targetLabel: string; detail: string }
export interface NotificationPrefs { quietEnabled: boolean; quietFrom: string; quietTo: string; mutedDeviceIds: string[] }
export interface PlatformSettings { mergeGapMin: number; minSessionMin: number; defaultSleepCutoff: string }
