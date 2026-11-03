'use client';

// Share access (API.md 5.1–5.5). Invites are LINK-ONLY: the owner gives a label and the permissions,
// gets a link, and sends it themselves. No phone number, no SMS from us.

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { Async, copyText, ErrorBox, Head, Locked, permLabel, PermToggles, useApi } from '@/components/ui';
import { del, errText, patch, post } from '@/lib/api';
import { day, initials, prettyPhone } from '@/lib/format';
import type { DeviceDetail, DevicePerm, InviteCreated, SharesResponse } from '@/lib/types';

export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const dev = useApi<DeviceDetail>(`/devices/${id}`);
  const canShare = !!dev.data?.myPermissions.includes('sharing.manage');
  const q = useApi<SharesResponse>(canShare ? `/devices/${id}/shares` : null);
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [perms, setPerms] = useState<DevicePerm[]>(['live.view', 'history.view', 'alerts.receive']);
  const [link, setLink] = useState<{ label: string; url: string; expiresAt: string } | null>(null);
  const [edit, setEdit] = useState<{ userId: string; perms: DevicePerm[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (dev.error) return <div className="wrap narrow"><ErrorBox error={dev.error} retry={dev.reload} /></div>;
  const d = dev.data;
  if (d && !canShare) return <div className="wrap narrow"><Locked msg="Only people with “Invite and manage people” on this sensor can see this." home="/devices" /></div>;
  // Only the owner can let others invite people (API.md 5.2)
  const allowed: DevicePerm[] = d?.isOwner ? ['live.view', 'history.view', 'alerts.receive', 'settings.edit', 'sharing.manage'] : ['live.view', 'history.view', 'alerts.receive', 'settings.edit'];

  const createInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!label.trim()) return setErr('Add a label so you know who this link is for');
    if (!perms.length) return setErr('Pick at least one thing they can do');
    setBusy(true);
    try {
      const r = await post<InviteCreated>(`/devices/${id}/invites`, { label: label.trim(), permissions: perms });
      setLink({ label: label.trim(), url: r.inviteUrl, expiresAt: r.expiresAt || r.invite?.expiresAt || '' });
      setInviting(false); setLabel('');
      q.reload();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  const copy = async (url: string) => toast((await copyText(url)) ? 'Link copied' : 'Couldn’t copy. Select the link and copy it.');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); q.reload(); } catch (e) { toast(errText(e)); }
  };
  const saveEdit = async () => {
    if (!edit) return;
    if (!edit.perms.length) return toast('Keep at least one permission, or remove the person instead');
    await act(() => patch(`/devices/${id}/shares/${edit.userId}`, { permissions: edit.perms }), 'Saved');
    setEdit(null);
  };

  return (
    <div className="wrap narrow">
      <Head title="Share access" sub={d ? `${d.name} · choose what each person can see and do` : undefined}
        actions={<button className="btn" onClick={() => { setInviting(!inviting); setErr(''); }}><Icon name="plus" /> Invite someone</button>}
        back={[`/devices/${id}`, d?.name || 'Device']} />

      {link && (
        <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
          <div className="stack" style={{ gap: 2 }}><h2>Invite link for {link.label}</h2><span className="xs muted">Opens a page where they accept with their own account, or create one.</span></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="inp mono" value={link.url} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="btn" onClick={() => copy(link.url)}>Copy link</button>
          </div>
          <p className="hint">Send it to them yourself, on WhatsApp, SMS or email. Anyone who opens it can accept, so send it only to that person. It works once{link.expiresAt ? ` and expires on ${day(link.expiresAt)}` : ' and expires in 7 days'}.</p>
          <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setLink(null)}>Done</button>
        </div>
      )}

      {inviting && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>Invite someone</h2>
          <form className="form" onSubmit={createInvite}>
            <div className="field"><label htmlFor="iv-label">Who is it for?</label><input className="inp" id="iv-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Anita (sister)" /><span className="hint">Only a label for your list. You get a link to send them.</span></div>
            <div><span className="label">What they can do</span><PermToggles on={perms} onChange={setPerms} allowed={allowed} /></div>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create invite link'}</button><button className="btn ghost" type="button" onClick={() => setInviting(false)}>Cancel</button></div>
          </form>
        </div>
      )}

      <Async q={q}>{(r) => (
        <div className="card">
          <div className="person"><div className="avatar">{initials(r.owner.fullName)}</div>
            <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}><b>{r.owner.fullName} <span className="pill acc" style={{ marginLeft: 4 }}>Owner</span></b><span className="xs muted">{prettyPhone(r.owner.phone)} · can do everything</span></div>
          </div>
          {r.shares.map((s) => {
            const editing = edit?.userId === s.userId;
            return (
              <div className="person" key={s.userId}><div className="avatar">{initials(s.fullName)}</div>
                <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                  <div className="between" style={{ alignItems: 'flex-start' }}>
                    <div className="stack" style={{ gap: 2, minWidth: 0 }}><b>{s.fullName}</b><span className="xs muted">{prettyPhone(s.phone)}</span></div>
                    {editing ? <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={saveEdit}>Save</button><button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button></div>
                      : <button className="btn ghost sm" onClick={() => setEdit({ userId: s.userId, perms: s.permissions })}>Edit</button>}
                  </div>
                  {editing ? <>
                    <div><PermToggles on={edit.perms} onChange={(p) => setEdit({ ...edit, perms: p })} allowed={allowed} /></div>
                    <button className="btn danger sm" style={{ alignSelf: 'flex-start' }} onClick={() => { if (confirm(`Remove ${s.fullName}? They lose access at once.`)) { setEdit(null); act(() => del(`/devices/${id}/shares/${s.userId}`), 'Access removed'); } }}>Remove access</button>
                  </> : <div className="chips">{s.permissions.map((p) => <span key={p} className="pill">{permLabel(p)}</span>)}</div>}
                </div>
              </div>
            );
          })}
          {r.invites.map((i) => (
            <div className="person" key={i.id}><div className="avatar">{initials(i.label)}</div>
              <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}><b>{i.label} <span className="pill warn" style={{ marginLeft: 4 }}>Link not used yet</span></b><span className="xs muted">Invite link expires {day(i.expiresAt)}</span></div>
                  <div className="row" style={{ gap: 6 }}>
                    {i.url && <button className="btn ghost sm" onClick={() => copy(i.url!)}>Copy link</button>}
                    <button className="btn danger sm" onClick={() => { if (confirm(`Cancel the invite for ${i.label}? The link stops working.`)) act(() => del(`/devices/${id}/invites/${i.id}`), 'Invite cancelled'); }}>Cancel</button>
                  </div>
                </div>
                <div className="chips">{i.permissions.map((p) => <span key={p} className="pill">{permLabel(p)}</span>)}</div>
              </div>
            </div>
          ))}
          {!r.shares.length && !r.invites.length && <p className="muted small" style={{ paddingTop: 12 }}>No one else has access yet.</p>}
        </div>
      )}</Async>
      <div className="note"><Icon name="shield" /><span>These are the same permission switches the team uses for its own staff, so access works the same way everywhere.</span></div>
    </div>
  );
}
