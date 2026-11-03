'use client';

// Admin: customer detail (API.md 7.2–7.5): devices, family, reset link (copy), disable/enable, log out everywhere.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AdminStatusPill } from '@/components/admin';
import { useAuth, useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, copyText, Head, useApi } from '@/components/ui';
import { errText, post } from '@/lib/api';
import { ago, countryName, dateTime, day, initials, prettyPhone } from '@/lib/format';
import type { CustomerDetail } from '@/lib/types';

export default function CustomerPage() {
  return <RequireStaff perm="customers.view"><Inner /></RequireStaff>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const q = useApi<CustomerDetail>(`/admin/customers/${id}`);
  const [reset, setReset] = useState<{ resetUrl: string; expiresAt: string } | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [reason, setReason] = useState('');
  const ed = can('customers.edit');

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); q.reload(); } catch (e) { toast(errText(e)); } };
  const makeReset = async () => {
    try {
      const r = await post<{ resetUrl: string; expiresAt: string }>(`/admin/customers/${id}/reset-link`);
      setReset(r);
      toast((await copyText(r.resetUrl)) ? 'Reset link created and copied' : 'Reset link created');
    } catch (e) { toast(errText(e)); }
  };

  return (
    <Async q={q}>{(c) => (
      <div className="wrap">
        <Head title={c.fullName} sub={`${prettyPhone(c.phone)} · ${countryName(c.country)} · joined ${day(c.createdAt)} · active ${ago(c.lastActiveAt).toLowerCase()}`}
          actions={c.status === 'active' ? <span className="pill ok">Active</span> : <span className="pill bad">Disabled</span>} back={['/admin/customers', 'Customers']} />
        <div className="g21">
          <div className="card"><h2 style={{ marginBottom: 12 }}>Devices</h2>
            {c.devices.length ? (
              <div className="tbl"><table><thead><tr><th>Serial</th><th>Name</th><th>Status</th><th>Time zone</th><th>Firmware</th><th>Last seen</th></tr></thead>
                <tbody>{c.devices.map((d) => (
                  <tr key={d.id} className={can('devices.view') ? 'click' : ''} onClick={() => can('devices.view') && router.push(`/admin/devices/${d.id}`)}>
                    <td className="mono">{d.serial}</td><td>{d.name}</td><td><AdminStatusPill d={{ online: d.online, owner: true }} /></td>
                    <td className="mono">{d.tz}</td><td className="mono">{d.fw || '—'}</td><td className="muted">{d.online ? 'Now' : ago(d.lastSeenAt)}</td>
                  </tr>
                ))}</tbody></table></div>
            ) : <p className="small muted">No devices claimed.</p>}
          </div>
          <div className="stack" style={{ gap: 16 }}>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Family members</h2>
              {c.family.length ? c.family.map((f) => (
                <div className="row" key={f.phone + f.deviceName} style={{ padding: '6px 0', flexWrap: 'nowrap' }}>
                  <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{initials(f.fullName)}</div>
                  <div className="stack" style={{ gap: 0, minWidth: 0 }}><span className="small">{f.fullName}</span><span className="xs muted">{prettyPhone(f.phone)} · {f.deviceName}</span></div>
                </div>
              )) : <p className="small muted">Not shared with anyone.</p>}
            </div>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Account actions</h2>
              <div className="stack" style={{ gap: 8 }}>
                <button className="btn ghost" disabled={!ed || c.status !== 'active'} onClick={makeReset}>Create password reset link</button>
                {reset && <div className="stack" style={{ gap: 8 }}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input className="inp mono" value={reset.resetUrl} readOnly onFocus={(e) => e.target.select()} style={{ minWidth: 0 }} aria-label="Reset link" />
                    <button className="btn sm" onClick={async () => toast((await copyText(reset.resetUrl)) ? 'Link copied' : 'Select the link and copy it')}>Copy</button>
                  </div>
                  <p className="hint">Send it to {c.fullName.split(' ')[0]} yourself (WhatsApp, SMS or email). It is valid for 24 hours, works once, and is shown only now. Expires {dateTime(reset.expiresAt)}.</p>
                </div>}
                {c.status === 'active' ? (!disabling
                  ? <button className="btn danger" disabled={!ed} onClick={() => { setDisabling(true); setReason(''); }}>Disable account</button>
                  : <form className="form" onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) return toast('Give a reason'); act(() => post(`/admin/customers/${id}/disable`, { reason: reason.trim() }), 'Account disabled').then(() => setDisabling(false)); }}>
                    <div className="field"><label htmlFor="cu-reason">Why disable it?</label><input className="inp" id="cu-reason" value={reason} onChange={(e) => setReason(e.target.value)} /><span className="hint">They are logged out at once and can&apos;t log in until enabled.</span></div>
                    <div className="row"><button className="btn danger solid" type="submit">Disable</button><button className="btn ghost" type="button" onClick={() => setDisabling(false)}>Cancel</button></div>
                  </form>)
                  : <button className="btn ghost" disabled={!ed} onClick={() => act(() => post(`/admin/customers/${id}/enable`), 'Account enabled')}>Enable account</button>}
                <button className="btn ghost" disabled={!ed} onClick={() => { if (confirm(`Log ${c.fullName} out on every device?`)) act(() => post(`/admin/customers/${id}/logout-all`), 'Logged out everywhere'); }}>Log out everywhere</button>
                {!ed && <p className="xs muted">Needs customers.edit.</p>}
              </div>
            </div>
            {can('audit.view') && <Link className="small" href={`/admin/audit?q=${encodeURIComponent(c.fullName)}`}>See this customer in the audit log</Link>}
          </div>
        </div>
      </div>
    )}</Async>
  );
}
