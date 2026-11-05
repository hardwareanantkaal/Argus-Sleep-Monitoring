'use client';

// Admin: vendor detail (API.md 15.1c–f): members, open invites, groups, devices; owner invite link (shown once); disable/enable.

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AdminStatusPill } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { CustomerList, StagePill, StockTiles } from '@/components/vendor';
import { Async, copyText, Head, useApi } from '@/components/ui';
import { del, errText, post } from '@/lib/api';
import { ago, day, prettyPhone } from '@/lib/format';
import type { VendorDetail } from '@/lib/types';

export default function VendorDetailPage() {
  return <RequireStaff perm="vendors.manage"><Inner /></RequireStaff>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const q = useApi<VendorDetail>(`/admin/vendors/${id}`);
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [link, setLink] = useState<{ label: string; url: string; expiresAt: string } | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (e) { toast(errText(e)); } q.reload(); };
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!label.trim()) return setErr('Add a label so you know who this link is for');
    try {
      const r = await post<{ inviteUrl: string; expiresAt: string }>(`/admin/vendors/${id}/invites`, { label: label.trim() });
      setLink({ label: label.trim(), url: r.inviteUrl, expiresAt: r.expiresAt });
      setInviting(false); setLabel(''); q.reload();
    } catch (e2) { setErr(errText(e2)); }
  };

  return (
    <Async q={q}>{(v) => {
      const groupName = (gid: string | null) => v.groups.find((g) => g.id === gid)?.name || '—';
      const active = v.status === 'active';
      return (
        <div className="wrap">
          <Head title={v.name} back={['/admin/vendors', 'Vendors']}
            sub={[v.contactName, v.phone && prettyPhone(v.phone), v.email, `since ${day(v.createdAt)}`].filter(Boolean).join(' · ')}
            actions={<>
              {active ? <span className="pill ok">Active</span> : <span className="pill bad">Disabled</span>}
              {active && <button className="btn ghost" onClick={() => { setInviting(!inviting); setErr(''); }}><Icon name="plus" /> New owner link</button>}
            </>} />

          {!active && <div className="banner" role="status"><Icon name="alert" /><span>Disabled: its team and people with temporary access can&apos;t see its devices. Devices and history are kept.</span></div>}

          {link && (
            <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
              <div className="stack" style={{ gap: 2 }}><h2>Owner invite link for {link.label}</h2><span className="xs muted">Opens a page where they accept with their own account, or create one, and become the owner of {v.name}.</span></div>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="inp mono" value={link.url} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Invite link" />
                <button className="btn" onClick={async () => toast((await copyText(link.url)) ? 'Link copied' : 'Select the link and copy it')}>Copy link</button>
              </div>
              <p className="hint">Send it yourself. It works once and expires on {day(link.expiresAt)}. <b>Copy it now:</b> it won&apos;t be shown again.</p>
              <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setLink(null)}>Done</button>
            </div>
          )}

          {inviting && (
            <div className="card"><h2 style={{ marginBottom: 14 }}>New owner invite link</h2>
              <p className="small muted" style={{ marginBottom: 12 }}>Use this when the first link was lost or expired, or for a second owner.</p>
              <form className="form" onSubmit={invite}>
                <div className="field"><label htmlFor="vo-name">Who is it for?</label><input className="inp" id="vo-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={v.contactName || 'e.g. Dr. Kavita Nair'} /><span className="hint">Only a label. The owner can then invite their own staff.</span></div>
                {err && <p className="err" role="alert">{err}</p>}
                <div className="row"><button className="btn" type="submit">Create invite link</button><button className="btn ghost" type="button" onClick={() => setInviting(false)}>Cancel</button></div>
              </form>
            </div>
          )}

          {v.summary && <StockTiles s={v.summary} />}

          <div className="g21">
            <div className="stack" style={{ gap: 16, minWidth: 0 }}>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Devices ({v.devices.length})</h2>
              {v.devices.length ? (
                <div className="tbl"><table><thead><tr><th>Serial</th><th>Name</th><th>Stage</th><th>Customer</th><th>Group</th><th>Status</th><th>Firmware</th><th>Access</th><th>Last seen</th></tr></thead>
                  <tbody>{v.devices.map((d) => (
                    <tr key={d.id} className={can('devices.view') ? 'click' : ''} onClick={() => can('devices.view') && router.push(`/admin/devices/${d.id}`)}>
                      <td className="mono">{d.serial}</td><td>{d.name}</td>
                      <td><StagePill stage={d.stage} /></td>
                      <td>{d.customer ? <>{d.customer.fullName}<br /><span className="xs muted">{day(d.soldAt)}</span></> : '—'}</td>
                      <td>{groupName(d.groupId)}</td>
                      <td><AdminStatusPill d={{ online: d.online, owner: true }} /></td>
                      <td className="mono">{d.fw || '—'}</td><td className="num">{d.activeGrants}</td>
                      <td className="muted">{d.online ? 'Now' : ago(d.lastSeenAt)}</td>
                    </tr>
                  ))}</tbody></table></div>
              ) : <p className="small muted">No devices yet. The vendor team scans the QR sticker to add a sensor to its stock.</p>}
            </div>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Customers ({v.customers?.length ?? 0})</h2>
              <CustomerList items={v.customers || []} deviceHref={(did) => (can('devices.view') ? `/admin/devices/${did}` : null)} />
            </div>
            </div>
            <div className="stack" style={{ gap: 16 }}>
              <div className="card"><h2 style={{ marginBottom: 12 }}>Team</h2>
                {v.members.length ? v.members.map((m) => (
                  <div key={m.userId} className="between" style={{ padding: '6px 0' }}>
                    <div className="stack" style={{ gap: 0 }}><span className="small">{m.fullName}</span><span className="xs muted">{prettyPhone(m.phone)}</span></div>
                    {m.role === 'owner' ? <span className="pill acc">Owner</span> : <span className="pill">Staff</span>}
                  </div>
                )) : <p className="small muted">No members yet. Invite the vendor owner.</p>}
              </div>
              {v.invites.length > 0 && (
                <div className="card"><h2 style={{ marginBottom: 8 }}>Open invites</h2>
                  {v.invites.map((i) => (
                    <div key={i.id} className="between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      <div className="stack" style={{ gap: 0 }}><b className="small">{i.label} · {i.role === 'owner' ? 'Owner' : 'Staff'}</b><span className="xs muted">Expires {day(i.expiresAt)}</span></div>
                      {i.role === 'owner' && <button className="btn danger sm" onClick={() => { if (confirm(`Cancel the invite for ${i.label}?`)) act(() => del(`/admin/vendors/${id}/invites/${i.id}`), 'Invite cancelled'); }}>Cancel</button>}
                    </div>
                  ))}
                </div>
              )}
              <div className="card"><h2 style={{ marginBottom: 12 }}>Groups</h2>
                {v.groups.length ? <div className="row" style={{ gap: 6 }}>{v.groups.map((g) => <span key={g.id} className="pill">{g.name}</span>)}</div> : <p className="small muted">No groups.</p>}
              </div>
              <div className="card"><h2 style={{ marginBottom: 6 }}>{active ? 'Disable vendor' : 'Enable vendor'}</h2>
                <p className="small muted" style={{ marginBottom: 12 }}>{active ? 'Its team and everyone with temporary access lose access at once. Devices and history are kept.' : 'Its team and current temporary access work again.'}</p>
                {active
                  ? <button className="btn danger" onClick={() => { if (confirm(`Disable ${v.name}?`)) act(() => post(`/admin/vendors/${id}/disable`), 'Vendor disabled'); }}>Disable {v.name}</button>
                  : <button className="btn" onClick={() => act(() => post(`/admin/vendors/${id}/enable`), 'Vendor enabled')}>Enable {v.name}</button>}
              </div>
            </div>
          </div>
        </div>
      );
    }}</Async>
  );
}
