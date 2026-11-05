'use client';

// Admin: vendors (API.md 15.1). Resellers with their own stock and customers, and hospitals / care homes
// that keep devices and give temporary access. v2: one-step create returns the owner invite link.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDebounced } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, copyText, Head, PhoneInput, useApi } from '@/components/ui';
import { errText, post, qs } from '@/lib/api';
import { day, prettyPhone, toE164 } from '@/lib/format';
import type { Vendor, VendorCreated } from '@/lib/types';

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
  const blank = { name: '', ownerName: '', code: '+91', local: '', email: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<VendorCreated | null>(null);

  // v2: one step. Creates the vendor and its owner invite link together.
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!f.name.trim()) return setErr('Enter the company name');
    if (!f.ownerName.trim()) return setErr("Enter the owner's full name");
    if (!f.local.trim()) return setErr("Enter the owner's phone number");
    setBusy(true);
    try {
      const r = await post<VendorCreated>('/admin/vendors', { name: f.name.trim(), ownerName: f.ownerName.trim(),
        ownerPhone: toE164(f.code, f.local), ownerEmail: f.email.trim() || undefined });
      setMade(r); setCreating(false); setF(blank); q.reload();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };

  return (
    <div className="wrap">
      <Head title="Vendors" sub="Resellers and organizations (hospitals, care homes) with their own sensor stock and customers."
        actions={<button className="btn" onClick={() => { setCreating(!creating); setErr(''); setMade(null); }}><Icon name="plus" /> New vendor</button>} />
      {made && (
        <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
          <div className="stack" style={{ gap: 2 }}><h2>{made.vendor.name} created</h2><span className="xs muted">Send this link to {made.vendor.contactName || 'the owner'}. They sign up or log in with their own phone and password, and become the owner of {made.vendor.name}.</span></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="inp mono" value={made.inviteUrl} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Owner invite link" />
            <button className="btn" onClick={async () => toast((await copyText(made.inviteUrl)) ? 'Link copied' : 'Select the link and copy it')}>Copy link</button>
          </div>
          <p className="hint">It works once and expires on {day(made.expiresAt)}. <b>Copy it now:</b> it won&apos;t be shown again. A lost link can be replaced on the vendor page.</p>
          <div className="row"><button className="btn ghost sm" onClick={() => router.push(`/admin/vendors/${made.vendor.id}`)}>Open {made.vendor.name}</button><button className="link small" onClick={() => setMade(null)}>Done</button></div>
        </div>
      )}
      {creating && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>New vendor</h2>
          <form className="form" onSubmit={create}>
            <div className="field"><label htmlFor="nv-name">Company name</label><input className="inp" id="nv-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Shree Medical Distributors" /></div>
            <div className="fields2">
              <div className="field"><label htmlFor="nv-owner">Owner&apos;s full name</label><input className="inp" id="nv-owner" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></div>
              <div className="field"><label htmlFor="nv-phone">Owner&apos;s phone</label><PhoneInput id="nv-phone" code={f.code} setCode={(code) => setF({ ...f, code })} local={f.local} setLocal={(local) => setF({ ...f, local })} /></div>
            </div>
            <div className="field"><label htmlFor="nv-email">Owner&apos;s email (optional)</label><input className="inp" id="nv-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <p className="hint">Creating the vendor also makes the owner&apos;s invite link. You send it yourself (WhatsApp, email).</p>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create vendor + invite link'}</button><button className="btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
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
          <thead><tr><th>Name</th><th>Owner / contact</th><th>In stock</th><th>Sold</th><th>Customers</th><th>Team</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>{r.items.map((v) => (
            <tr key={v.id} className="click" onClick={() => router.push(`/admin/vendors/${v.id}`)}>
              <td><b>{v.name}</b></td>
              <td>{v.contactName || '—'}<br /><span className="xs muted">{[v.phone && prettyPhone(v.phone), v.email].filter(Boolean).join(' · ')}</span></td>
              <td className="num">{v.stockCount ?? v.deviceCount}</td><td className="num">{v.soldCount ?? 0}</td><td className="num">{v.customerCount ?? 0}</td><td className="num">{v.memberCount}</td>
              <td>{v.status === 'active' ? <span className="pill ok">Active</span> : <span className="pill bad">Disabled</span>}</td>
              <td className="muted">{day(v.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      ) : <div className="card empty"><Icon name="tag" size={30} /><h2>No vendors</h2><p>Create one with “New vendor”.</p></div>}</Async>
    </div>
  );
}
