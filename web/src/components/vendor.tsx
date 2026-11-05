'use client';

// Bits shared by the vendor screens (API.md §15): grant status pill, local date/time ↔ ISO with offset.

import type { GrantPerm, GrantStatus } from '@/lib/types';

export const GRANT_PERMS: [GrantPerm, string][] = [
  ['live.view', 'See live values'],
  ['history.view', 'See sleep history'],
  ['alerts.receive', 'Get alerts'],
  ['settings.edit', 'Change device settings'],
];
export const DEFAULT_GRANT_PERMS: GrantPerm[] = ['live.view', 'history.view', 'alerts.receive'];

const STATUS: Record<GrantStatus, [string, string]> = {
  invite_sent: ['Link sent', 'acc'],
  invite_expired: ['Link expired', 'warn'],
  scheduled: ['Scheduled', 'acc'],
  active: ['Active', 'ok'],
  expired: ['Expired', ''],
  ended: ['Ended', 'bad'],
};
export function GrantStatusPill({ s }: { s: GrantStatus }) {
  const [l, c] = STATUS[s] || [s, ''];
  return <span className={`pill ${c}`}><span className="dot" />{l}</span>;
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** A Date as the value of <input type="datetime-local"> in the browser's local time. */
export function toLocalInput(d: Date | string) {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}T${p2(x.getHours())}:${p2(x.getMinutes())}`;
}
/** A datetime-local value (local time) as ISO 8601 with the local offset, e.g. 2026-11-05T21:30:00+05:30. */
export function localToIso(v: string) {
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${toLocalInput(d)}:00${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
/** Short local date + time, e.g. "5 Nov, 21:30". */
export function whenLocal(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
