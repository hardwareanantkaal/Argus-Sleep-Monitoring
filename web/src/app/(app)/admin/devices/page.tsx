'use client';

// Admin: devices list (API.md 8.2) with search, status filter and live online/offline (admin:devices).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AdminStatusPill, useAdminSocket, useDebounced } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { qs } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AdminDeviceRow, List } from '@/lib/types';

export default function AdminDevicesPage() {
  return <RequireStaff perm="devices.view"><Inner /></RequireStaff>;
}

function Inner() {
  const { can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('all');
  const dq = useDebounced(q);
  const r = useApi<List<AdminDeviceRow>>(`/admin/devices${qs({ q: dq, status: st, limit: 50 })}`);
  useAdminSocket(['devices'], {
    'device:status': (m: { deviceId: string; online: boolean; lastSeenAt: string | null }) =>
      r.setData((x) => x && { ...x, items: x.items.map((d) => (d.id === m.deviceId ? { ...d, online: m.online, lastSeenAt: m.lastSeenAt } : d)) }),
  });

  return (
    <div className="wrap">
      <Head title="Devices" sub={r.data ? `${r.data.total ?? r.data.items.length} matching` : undefined}
        actions={can('devices.register') && <Link className="btn" href="/admin/register"><Icon name="usb" /> Register by USB</Link>} />
      <div className="card">
        <div className="toolbar">
          <input className="inp" placeholder="Search serial, MAC, name or owner" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select className="inp" value={st} onChange={(e) => setSt(e.target.value)} aria-label="Status">
            <option value="all">All statuses</option><option value="online">Online</option><option value="offline">Offline</option>
            <option value="unclaimed">Not claimed</option><option value="disabled">Disabled</option>
          </select>
        </div>
        <Async q={r}>{(d) => (
          <div className="tbl"><table>
            <thead><tr><th>Serial</th><th>Name</th><th>Owner</th><th>Status</th><th>Time zone</th><th>Firmware</th><th>Chip</th><th>Last seen</th></tr></thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={x.id} className="click" onClick={() => router.push(`/admin/devices/${x.id}`)}>
                  <td className="mono"><Link href={`/admin/devices/${x.id}`} style={{ color: 'inherit' }}>{x.serial}</Link></td>
                  <td>{x.name || <span className="muted">—</span>}</td>
                  <td>{x.owner?.fullName || (x.vendor ? <>{x.vendor.name} <span className="pill acc">Vendor</span></> : <span className="muted">—</span>)}</td>
                  <td><AdminStatusPill d={x} /></td>
                  <td className="mono">{x.tz || '—'}</td>
                  <td className="mono">{x.fw || '—'}</td>
                  <td className="mono">{x.chip}</td>
                  <td className="muted">{x.online ? 'Now' : ago(x.lastSeenAt)}</td>
                </tr>
              ))}
              {!d.items.length && <tr><td colSpan={8} className="muted">No devices match.</td></tr>}
            </tbody>
          </table></div>
        )}</Async>
      </div>
    </div>
  );
}
