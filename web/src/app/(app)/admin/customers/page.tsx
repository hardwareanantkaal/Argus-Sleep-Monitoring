'use client';

// Admin: customers (API.md 7.1) with search, country filter and device time-zone filter.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDebounced } from '@/components/admin';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { qs } from '@/lib/api';
import { ago, COUNTRIES, countryName, day, prettyPhone, TIMEZONES } from '@/lib/format';
import type { CustomerRow, List } from '@/lib/types';

export default function CustomersPage() {
  return <RequireStaff perm="customers.view"><Inner /></RequireStaff>;
}

function Inner() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('all');
  const [tz, setTz] = useState('all');
  const [status, setStatus] = useState('all');
  const dq = useDebounced(q);
  const r = useApi<List<CustomerRow>>(`/admin/customers${qs({ q: dq, country, tz, status, limit: 50 })}`);
  return (
    <div className="wrap">
      <Head title="Customers" sub={r.data ? `${r.data.total ?? r.data.items.length} matching` : undefined} />
      <div className="card">
        <div className="toolbar">
          <input className="inp" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select className="inp" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
            <option value="all">All countries</option>{COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.name}</option>)}
          </select>
          <select className="inp" value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Device time zone">
            <option value="all">All time zones</option>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}
          </select>
          <select className="inp" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="all">Any status</option><option value="active">Active</option><option value="disabled">Disabled</option>
          </select>
        </div>
        <Async q={r}>{(d) => (
          <div className="tbl"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Country</th><th>Device time zones</th><th>Devices</th><th>Family</th><th>Joined</th><th>Last active</th><th>Status</th></tr></thead>
            <tbody>
              {d.items.map((c) => (
                <tr key={c.id} className="click" onClick={() => router.push(`/admin/customers/${c.id}`)}>
                  <td><b>{c.fullName}</b></td><td className="mono">{prettyPhone(c.phone)}</td><td>{countryName(c.country)}</td>
                  <td className="mono">{c.deviceTimeZones.join(', ') || <span className="muted">—</span>}</td>
                  <td className="num">{c.deviceCount}</td><td className="num">{c.familyCount}</td>
                  <td className="muted">{day(c.createdAt)}</td><td className="muted">{ago(c.lastActiveAt)}</td>
                  <td>{c.status === 'active' ? <span className="pill ok">Active</span> : <span className="pill bad">Disabled</span>}</td>
                </tr>
              ))}
              {!d.items.length && <tr><td colSpan={9} className="muted">No customers match.</td></tr>}
            </tbody>
          </table></div>
        )}</Async>
      </div>
    </div>
  );
}
