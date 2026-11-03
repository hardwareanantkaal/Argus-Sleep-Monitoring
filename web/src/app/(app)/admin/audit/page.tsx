'use client';

// Audit log (API.md 9.19): read-only, newest first, search + action-type + date filters.

import { useEffect, useState } from 'react';
import { useDebounced } from '@/components/admin';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AuditItem, List } from '@/lib/types';

const ACTIONS: [string, string][] = [['all', 'All actions'], ['device', 'Devices'], ['ota', 'OTA'], ['firmware', 'Firmware'], ['share', 'Sharing'], ['customer', 'Customers'], ['team', 'Team'], ['platform', 'Sleep rules']];

export default function AuditPage() {
  return <RequireStaff perm="audit.view"><Inner /></RequireStaff>;
}

function Inner() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // other screens link here with ?q=<name>
  useEffect(() => { const v = new URLSearchParams(window.location.search).get('q'); if (v) setQ(v); }, []);
  const dq = useDebounced(q);
  const r = useApi<List<AuditItem>>(`/admin/audit${qs({ q: dq, action, from: from || undefined, to: to || undefined, limit: 100 })}`);
  return (
    <div className="wrap">
      <Head title="Audit log" sub="Every change by staff or customers, newest first. Entries cannot be edited." />
      <div className="card">
        <div className="toolbar">
          <input className="inp" placeholder="Search person, device, detail" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select className="inp" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action type">{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" style={{ flex: '0 1 160px' }} />
          <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" style={{ flex: '0 1 160px' }} />
        </div>
        <Async q={r}>{(d) => (
          <div className="tbl"><table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {d.items.map((a) => <tr key={a.id}><td className="muted">{dateTime(a.at)}</td><td>{a.actorName}</td><td className="mono">{a.action}</td><td className="mono">{a.targetLabel}</td><td className="muted" style={{ whiteSpace: 'normal', minWidth: 220 }}>{a.detail}</td></tr>)}
              {!d.items.length && <tr><td colSpan={5} className="muted">Nothing matches.</td></tr>}
            </tbody>
          </table></div>
        )}</Async>
      </div>
    </div>
  );
}
