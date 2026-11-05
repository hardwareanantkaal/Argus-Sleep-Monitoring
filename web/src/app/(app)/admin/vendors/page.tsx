'use client';

// Admin: vendors (API.md 15.1). Hospitals, care homes or single people that own devices and give temporary access.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDebounced } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, PhoneInput, useApi } from '@/components/ui';
import { errText, post, qs } from '@/lib/api';
import { day, prettyPhone, toE164 } from '@/lib/format';
import type { Vendor } from '@/lib/types';

export default function VendorsPage() {
  return <RequireStaff perm="vendors.manage"><Inner /></RequireStaff>;
}

function Inner() {
  const router = useRouter();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(term);
  const q = useApi<{ items: Vendor[] }>(`/admin/vendors${qs({ q: dq.trim(), status })}`);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', contactName: '', code: '+91', local: '', email: '' });
  const [err, setErr] = useState('');

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!f.name.trim()) return setErr('Enter the vendor name');
    try {
      const v = await post<Vendor>('/admin/vendors', { name: f.name.trim(), contactName: f.contactName.trim() || undefined,
        phone: f.local.trim() ? toE164(f.code, f.local) : undefined, email: f.email.trim() || undefined });
      toast(`${v.name} created`);
      router.push(`/admin/vendors/${v.id}`);
    } catch (e2) { setErr(errText(e2)); }
  };

  return (
    <div className="wrap">
      <Head title="Vendors" sub="Organizations or people that own sensors and give temporary access to them."
        actions={<button className="btn" onClick={() => { setCreating(!creating); setErr(''); }}><Icon name="plus" /> New vendor</button>} />
      {creating && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>New vendor</h2>
          <form className="form" onSubmit={create}>
            <div className="fields2">
              <div className="field"><label htmlFor="nv-name">Name</label><input className="inp" id="nv-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sunrise Care Home" /></div>
              <div className="field"><label htmlFor="nv-contact">Contact person (optional)</label><input className="inp" id="nv-contact" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></div>
            </div>
            <div className="fields2">
              <div className="field"><label htmlFor="nv-phone">Phone (optional)</label><PhoneInput id="nv-phone" code={f.code} setCode={(code) => setF({ ...f, code })} local={f.local} setLocal={(local) => setF({ ...f, local })} /></div>
              <div className="field"><label htmlFor="nv-email">Email (optional)</label><input className="inp" id="nv-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            </div>
            <p className="hint">Next, create an “Invite vendor owner” link on the vendor page and send it to them.</p>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit">Create vendor</button><button className="btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
          </form>
        </div>
      )}
      <div className="row">
        <input className="inp" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, contact, phone, email" aria-label="Search vendors" style={{ maxWidth: 340 }} />
        <select className="inp" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>
          <option value="">All</option><option value="active">Active</option><option value="disabled">Disabled</option>
        </select>
      </div>
      <Async q={q}>{(r) => r.items.length ? (
        <div className="card"><div className="tbl"><table>
          <thead><tr><th>Name</th><th>Contact</th><th>Devices</th><th>Team</th><th>Groups</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>{r.items.map((v) => (
            <tr key={v.id} className="click" onClick={() => router.push(`/admin/vendors/${v.id}`)}>
              <td><b>{v.name}</b></td>
              <td>{v.contactName || '—'}<br /><span className="xs muted">{[v.phone && prettyPhone(v.phone), v.email].filter(Boolean).join(' · ')}</span></td>
              <td className="num">{v.deviceCount}</td><td className="num">{v.memberCount}</td><td className="num">{v.groupCount}</td>
              <td>{v.status === 'active' ? <span className="pill ok">Active</span> : <span className="pill bad">Disabled</span>}</td>
              <td className="muted">{day(v.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      ) : <div className="card empty"><Icon name="tag" size={30} /><h2>No vendors</h2><p>Create one with “New vendor”.</p></div>}</Async>
    </div>
  );
}
