'use client';

// Bits shared by the vendor screens (API.md §15): grant status pill, local date/time ↔ ISO with offset,
// v2 stock tiles, stage pill and the customers list (vendor side and admin vendor detail).

import Link from 'next/link';
import { day, prettyPhone } from '@/lib/format';
import type { GrantPerm, GrantStatus, VendorCustomer, VendorStage, VendorSummary } from '@/lib/types';

/** v2: total / in stock / sold / customers */
export function StockTiles({ s }: { s: VendorSummary }) {
  return (
    <div className="tiles">
      <div className="card tile"><span className="label">All sensors</span><div className="v">{s.total}</div><span className="xs muted">{s.online} online now</span></div>
      <div className="card tile"><span className="label">In stock</span><div className="v" style={{ color: 'var(--accent)' }}>{s.stock}</div><span className="xs muted">Not sold or not in use</span></div>
      <div className="card tile"><span className="label">Sold</span><div className="v" style={{ color: 'var(--ok)' }}>{s.sold}</div><span className="xs muted">Owned by a customer</span></div>
      <div className="card tile"><span className="label">Customers</span><div className="v">{s.customers}</div><span className="xs muted">Bought one or more</span></div>
    </div>
  );
}

export function StagePill({ stage }: { stage?: VendorStage }) {
  return stage === 'sold' ? <span className="pill ok">Sold</span> : <span className="pill acc">In stock</span>;
}

/** Customers with the devices each one bought. deviceHref: where a device row links to (null = no link). */
export function CustomerList({ items, deviceHref }: { items: VendorCustomer[]; deviceHref: (id: string) => string | null }) {
  if (!items.length) return <p className="small muted">No customers yet. When a customer scans the sticker of a sensor in your stock, they appear here.</p>;
  return (
    <div className="tbl"><table>
      <thead><tr><th>Customer</th><th>Phone</th><th>Country</th><th>Sensors bought</th><th>First bought</th></tr></thead>
      <tbody>{items.map((c) => (
        <tr key={c.id}>
          <td><b>{c.fullName}</b></td>
          <td className="mono">{prettyPhone(c.phone)}</td>
          <td>{c.country}</td>
          <td>{c.devices.map((d) => {
            const href = deviceHref(d.id);
            const label = <><span className="mono">{d.serial}</span>{d.name ? ` · ${d.name}` : ''} <span className={`pill ${d.online ? 'ok' : ''}`}><span className="dot" />{d.online ? 'Online' : 'Offline'}</span></>;
            return <div key={d.id} className="small" style={{ padding: '2px 0' }}>{href ? <Link href={href}>{label}</Link> : label} <span className="xs muted">· {day(d.claimedAt)}</span></div>;
          })}</td>
          <td className="muted">{day(c.firstClaimedAt)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

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
