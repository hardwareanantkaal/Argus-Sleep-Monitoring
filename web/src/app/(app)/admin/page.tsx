'use client';

// Admin dashboard (API.md 8.1). Any staff member; recent audit only with audit.view.

import Link from 'next/link';
import { BarChart } from '@/components/charts';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { ago, pad } from '@/lib/format';
import type { Dashboard } from '@/lib/types';

export default function DashboardPage() {
  return <RequireStaff><Inner /></RequireStaff>;
}

function Inner() {
  const { can } = useAuth();
  const q = useApi<Dashboard>('/admin/dashboard');
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="wrap">
      <Head title="Dashboard" sub={today} />
      <Async q={q}>{(d) => {
        const c = d.counts;
        const claimed = c.online + c.offline || 1;
        const maxOn = Math.max(10, ...d.onlineHourly.map((h) => h.online));
        const top = Math.ceil((maxOn * 1.15) / 100) * 100 || 10;
        const fwTotal = d.fwVersions.reduce((a, f) => a + f.count, 0) || 1;
        return <>
          <div className="tiles">
            <div className="card tile"><span className="label">Registered devices</span><div className="v">{c.registered}</div><span className="xs muted">+{c.registeredThisWeek} this week</span></div>
            <div className="card tile"><span className="label">Online now</span><div className="v" style={{ color: 'var(--ok)' }}>{c.online}</div><span className="xs muted">{Math.round((c.online / claimed) * 100)}% · {c.offline} offline, {c.unclaimed} not claimed{c.disabled ? `, ${c.disabled} disabled` : ''}</span></div>
            <div className="card tile"><span className="label">Customers</span><div className="v">{c.customers}</div><span className="xs muted">+{c.customersThisWeek} this week</span></div>
            <div className="card tile"><span className="label">OTA rollouts</span><div className="v">{c.rolloutsRunning}<small>running</small></div>{can('firmware.view') && <Link className="xs" href="/admin/firmware">See rollouts</Link>}</div>
          </div>
          <div className="g21">
            <div className="card">
              <div className="ch"><div className="t"><h2>Devices online, last 24 h</h2><span className="xs muted">Hourly, now is the darkest bar</span></div></div>
              <div className="chartbox">
                <BarChart vals={d.onlineHourly.map((h) => h.online)} labels={d.onlineHourly.map((h, i) => (i % 3 === 0 ? `${pad(new Date(h.hour).getHours())}:00` : ''))}
                  maxV={top} ticks={[0, 1, 2, 3, 4].map((k) => Math.round((top / 4) * k))} fmt={(v) => String(v)} col="var(--ok)" hi={d.onlineHourly.length - 1} />
              </div>
            </div>
            <div className="card">
              <h2 style={{ marginBottom: 14 }}>Firmware in the field</h2>
              <div className="stagelist">
                {d.fwVersions.map((f) => (
                  <div className="r" key={f.version} style={{ gridTemplateColumns: '88px minmax(0,1fr) 40px' }}>
                    <span className="mono small">{f.version}</span>
                    <div className="track"><i style={{ width: `${(f.count / fwTotal) * 100}%`, background: 'var(--accent)' }} /></div>
                    <b className="num" style={{ textAlign: 'right' }}>{f.count}</b>
                  </div>
                ))}
              </div>
              {(can('devices.register') || can('firmware.rollout')) && <>
                <div className="divider" style={{ marginBlock: 16 }} />
                <div className="stack" style={{ gap: 8 }}>
                  {can('devices.register') && <Link className="btn ghost" href="/admin/register"><Icon name="usb" /> Register a device</Link>}
                  {can('firmware.rollout') && <Link className="btn ghost" href="/admin/firmware"><Icon name="upload" /> Start a rollout</Link>}
                </div>
              </>}
            </div>
          </div>
          {d.recentAudit && (
            <div className="card">
              <div className="ch"><h2>Recent activity</h2><Link className="small" href="/admin/audit">Open audit log</Link></div>
              {d.recentAudit.map((a) => (
                <div key={a.id} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                    <span className="small"><b>{a.actorName}</b> <span className="mono muted">{a.action}</span> {a.targetLabel}</span>
                    <span className="xs muted">{a.detail}</span>
                  </div>
                  <span className="xs muted" style={{ whiteSpace: 'nowrap' }}>{ago(a.at)}</span>
                </div>
              ))}
            </div>
          )}
        </>;
      }}</Async>
    </div>
  );
}
