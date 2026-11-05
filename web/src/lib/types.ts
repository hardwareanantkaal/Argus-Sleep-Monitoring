// Shapes from docs/API.md v1.0. Keep these in step with the contract.

export type DevicePerm = 'live.view' | 'history.view' | 'alerts.receive' | 'settings.edit' | 'sharing.manage';
export type StaffPerm =
  | 'devices.view' | 'devices.command' | 'devices.register'
  | 'customers.view' | 'customers.edit'
  | 'firmware.view' | 'firmware.upload' | 'firmware.rollout'
  | 'team.manage' | 'audit.view' | 'platform.settings' | 'vendors.manage';

export interface User {
  id: string;
  fullName: string;
  phone: string;
  country: string; // ISO-2
  kind: 'customer' | 'admin';
  role: { id: number; name: string } | null;
  permissions: StaffPerm[];
  createdAt: string;
  /** §15.6: the vendor team this user is on (one at most) */
  vendor?: VendorRef | null;
}

export type VendorRole = 'owner' | 'staff';
export interface VendorRef { id: string; name: string; role: VendorRole }

export interface LiveValues {
  pr: number; bed: number; ss: number; hr: number; br: number;
  bs?: number; mv?: number; mr?: number; dist?: number; rssi?: number; at: string;
  /* API.md §11a (firmware 2.0.0+), live only. sess/cmp/ngt are present only while a session runs. */
  up?: number; fw?: string; seq?: number; radar?: number;
  sess?: LiveSess; cmp?: LiveCmp; ngt?: LiveNgt;
}
/** current session: st 0 deep / 1 light / 2 awake / 3 none; start = Unix UTC seconds; durations in minutes */
export interface LiveSess { st: number; start: number; bed: number; slp: number; dp: number; lt: number; aw: number; on: number; wk: number; tn: number; sc: number }
/** Sensor composite: dis 0–3, abn 0 none / 1 normal / 2 abnormal, rat 0–3, lg/mn = % */
export interface LiveCmp { dis: number; abn: number; rat: number; resp: number; hr: number; apn: number; turn: number; lg: number; mn: number }
/** Sensor night statistics: sh/dp = light/deep %, slp/oob minutes */
export interface LiveNgt { sc: number; slp: number; wk: number; sh: number; dp: number; oob: number; ex: number; tn: number; resp: number; hr: number; apn: number }

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
  /** §15: how I can see this device; vendor/group set on vendor devices, accessEndsAt for grant holders */
  access?: DeviceAccess;
  vendor?: { id: string; name: string } | null;
  group?: { id: string; name: string } | null;
  accessEndsAt?: string | null;
  /** §15 v2.1, vendor team only: in stock (no data) or in use by the vendor. Sold devices are records, see VendorDevices. */
  stage?: VendorStage;
  stockedAt?: string | null;
  /** never a nap-only day (API.md §4); fields typed nullable only so the UI stays defensive */
  lastNight?: { sleepDate: string; score: number | null; totalSleepMin: number | null } | null;
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

// A date with only naps has NO main sleep (owner, 4 Nov; API.md §4): hasMainSleep false,
// every main-sleep field null, sessionCount 0, naps still filled. Left out of averages and lastNight.
export interface NightCard {
  sleepDate: string;
  hasMainSleep: boolean;
  start: string | null;
  end: string | null;
  score: number | null;
  totalSleepMin: number | null;
  inBedMin: number | null;
  stageMin: StageMin | null;
  sessionCount: number;
  naps: { start: string; end: string }[];
}

export interface NightDetail extends NightCard {
  efficiencyPct: number | null;
  wakeUps: number | null;
  exits: number | null;
  oobMin: number | null;
  sessions: { start: string; end: string }[] | null;
  epochS: number;
  hyp: string | null;
  hr: { avg: number; min: number; max: number } | null;
  br: { avg: number; min: number; max: number } | null;
  turns: number | null; bigMvPct: number | null; smallMvPct: number | null; apnea: number | null; struggles: number | null;
  naps: { start: string; end: string; totalSleepMin?: number; hyp?: string }[];
}
/** A night that has a main sleep: the main-sleep fields are present. */
export type MainNight<T extends NightCard = NightDetail> = T & { hasMainSleep: true; start: string; end: string; score: number; totalSleepMin: number; inBedMin: number; stageMin: StageMin };
export const isMain = <T extends NightCard>(n: T): n is MainNight<T> => n.hasMainSleep && n.start != null && n.stageMin != null;

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
  kind: 'device' | 'staff' | 'vendor' | 'grant';
  label?: string;
  vendorName?: string;
  vendorRole?: VendorRole;
  startsAt?: string;
  endsAt?: string;
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
  vendor?: { id: string; name: string } | null;
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
  /** 8.3: the current code can be printed again (GET /admin/devices/:id/sticker) */
  stickerAvailable?: boolean;
  sensorSettings: SensorSettings | null;
}
export type CommandType = 'reboot' | 'config_mode' | 'ota_check' | 'logs' | 'recalibrate';
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
  counts: { done: number; downloading: number; waiting: number; failed: number; /** waiting: sleep session active */ deferred?: number };
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

/* ---- vendors (API.md §15) ---- */
export type DeviceAccess = 'owner' | 'share' | 'vendor' | 'grant';
export interface Vendor {
  id: string; name: string; contactName: string | null; phone: string | null; email: string | null;
  status: 'active' | 'disabled'; deviceCount: number; memberCount: number; groupCount: number; createdAt: string;
  /** v2: not sold yet / sold / distinct customers */
  stockCount?: number; inUseCount?: number; soldCount?: number; customerCount?: number;
}
export interface VendorCreated { vendor: Vendor; inviteUrl: string; expiresAt: string }
export type VendorStage = 'stock' | 'in_use' | 'sold';
export interface VendorSummary { total: number; stock: number; inUse: number; sold: number; customers: number; online: number }
/** A sold device as the vendor sees it: a record only, no access (v2.1) */
export interface SoldRecord { id: string; serial: string; soldAt: string; customer: { id: string; fullName: string; phone: string; country: string } }
export interface VendorDevices { items: DeviceCard[]; sold: SoldRecord[] }
export interface VendorCustomer {
  id: string; fullName: string; phone: string; country: string; firstClaimedAt: string;
  /** name / online / fw / lastSeenAt: admin only */
  devices: { id: string; serial: string; claimedAt: string; name?: string; online?: boolean; fw?: string | null; lastSeenAt?: string | null }[];
}
export interface VendorInvite { id: string; label: string; role: VendorRole; expiresAt: string }
export interface VendorDetail extends Vendor {
  members: { userId: string; fullName: string; phone: string; role: VendorRole }[];
  invites: VendorInvite[];
  groups: { id: string; name: string }[];
  summary?: VendorSummary;
  customers?: VendorCustomer[];
  devices: { id: string; serial: string; name: string; groupId: string | null; online: boolean; fw: string | null; lastSeenAt: string | null; activeGrants: number;
    stage?: VendorStage; customer?: { id: string; fullName: string } | null; stockedAt?: string | null; soldAt?: string | null }[];
}
/** API 3.2: what claiming this sticker will do */
export interface ClaimCheck {
  serial: string; hwModel: string; registeredAt: string;
  stage?: 'factory' | 'vendor_stock'; result?: 'stock' | 'owner'; soldBy?: { id: string; name: string } | null;
}
export interface VendorGroup { id: string; name: string; deviceCount: number }
export interface VendorTeam {
  members: { userId: string; fullName: string; phone: string; role: VendorRole; joinedAt: string }[];
  invites: VendorInvite[];
}
export type GrantPerm = 'live.view' | 'history.view' | 'alerts.receive' | 'settings.edit';
export type GrantStatus = 'invite_sent' | 'invite_expired' | 'scheduled' | 'active' | 'expired' | 'ended';
export interface Grant {
  id: string; device: { id: string; serial: string; name: string }; label: string;
  user: { id: string; fullName: string; phone: string } | null;
  permissions: GrantPerm[]; startsAt: string; endsAt: string; status: GrantStatus;
  inviteExpiresAt: string | null; endedAt: string | null; createdAt: string;
}
export interface GrantCreated { grant: Grant; inviteUrl: string; expiresAt: string }
