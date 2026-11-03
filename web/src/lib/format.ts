// Formatting helpers. Sleep times are always shown in the DEVICE's time zone (API.md §0).

export const pad = (n: number) => String(n).padStart(2, '0');
export const dur = (min: number) => `${Math.floor(min / 60)}h ${pad(Math.round(min % 60))}m`;
export const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; }
};

/** "23:10" in the given zone */
export function timeIn(iso: string | null | undefined, tz: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
/** minutes since local midnight in the zone (for drawing time axes) */
export function minutesIn(iso: string, tz: string) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value);
}
/** "Mon 2 Nov" from a YYYY-MM-DD sleep date */
export function sleepDateLabel(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function dateTime(iso: string | null | undefined, tz?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
}
export function day(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function ago(iso: string | null | undefined) {
  if (!iso) return 'Never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
export const bytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
export const uptime = (s: number | null | undefined) => (s == null ? '—' : s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`);

/* ---- time-zone label: "Surat time", falling back to the zone (decision 3 Nov) ---- */
const TZ_NAME: Record<string, string> = {
  'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India', 'Asia/Dubai': 'UAE', 'Asia/Singapore': 'Singapore', 'Europe/London': 'UK',
  'America/New_York': 'New York', 'America/Los_Angeles': 'California', 'Australia/Sydney': 'Sydney',
};
export function placeName(tz: string, place: string | null | undefined) {
  return place || TZ_NAME[tz] || tz.split('/').pop()!.replace(/_/g, ' ');
}
/** the label is only shown when the viewer is in another zone */
export function sameZone(tz: string) {
  try {
    const now = new Date();
    const f = (z: string) => new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return f(tz) === f(browserTz());
  } catch { return true; }
}
export const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Riyadh', 'Asia/Qatar', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney'];

/* ---- countries (ISO-2), pre-filled from the phone code ---- */
export const COUNTRIES: { iso: string; name: string; code: string }[] = [
  { iso: 'IN', name: 'India', code: '+91' },
  { iso: 'AE', name: 'United Arab Emirates', code: '+971' },
  { iso: 'US', name: 'United States', code: '+1' },
  { iso: 'GB', name: 'United Kingdom', code: '+44' },
  { iso: 'SG', name: 'Singapore', code: '+65' },
  { iso: 'SA', name: 'Saudi Arabia', code: '+966' },
  { iso: 'QA', name: 'Qatar', code: '+974' },
  { iso: 'AU', name: 'Australia', code: '+61' },
  { iso: 'CA', name: 'Canada', code: '+1' },
  { iso: 'DE', name: 'Germany', code: '+49' },
];
export const countryName = (iso: string) => COUNTRIES.find((c) => c.iso === iso)?.name || iso;
/** "+91" + "98250 12345" → "+919825012345" */
export const toE164 = (code: string, local: string) => code + local.replace(/\D/g, '').replace(/^0+/, '');
export function prettyPhone(e164: string) {
  const c = [...COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((x) => e164.startsWith(x.code));
  if (!c) return e164;
  const rest = e164.slice(c.code.length);
  return `${c.code} ${rest.length === 10 ? rest.slice(0, 5) + ' ' + rest.slice(5) : rest}`;
}

export const STAGE_NAME: Record<number, string> = { 0: 'Deep', 1: 'Light', 2: 'Awake', 3: '—' };

/* ---- live value words (DEVICE-DATA §2) ---- */
export function presenceText(pr: number | undefined, bed: number | undefined) {
  if (bed === 1) return 'In bed';
  if (pr === 1) return 'In the room';
  return 'Room empty';
}
export const BREATH_STATE: Record<number, [string, 'ok' | 'warn' | '']> = { 1: ['Normal', 'ok'], 2: ['Fast', 'warn'], 3: ['Slow', 'warn'], 4: ['No reading', ''] };
export const moveText = (mr: number) => (mr < 10 ? 'Still' : mr < 35 ? 'Small movements' : 'Moving a lot');
