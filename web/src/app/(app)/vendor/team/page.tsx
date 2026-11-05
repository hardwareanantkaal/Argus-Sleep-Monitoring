'use client';

// Vendor team (API.md 15.4): members see every vendor device. Only the vendor owner invites (link, shown once),
// cancels invites and removes members.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireVendor } from '@/components/Shell';
import { Async, copyText, Head, useApi } from '@/components/ui';
import { del, errText, post } from '@/lib/api';
import { day, prettyPhone } from '@/lib/format';
import type { VendorTeam } from '@/lib/types';

export default function VendorTeamPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

function Inner() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useApi<VendorTeam>('/vendor/team');
  const owner = user?.vendor?.role === 'owner';
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [link, setLink] = useState<{ label: string; url: string; expiresAt: string } | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (e) { toast(errText(e)); } q.reload(); };
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!label.trim()) return setErr('Add a label so you know who this link is for');
    try {
      const r = await post<{ inviteUrl: string; expiresAt: string }>('/vendor/team/invites', { label: label.trim() });
      setLink({ label: label.trim(), url: r.inviteUrl, expiresAt: r.expiresAt });
      setInviting(false); setLabel(''); q.reload();
    } catch (e2) { setErr(errText(e2)); }
  };

  return (
    <div className="wrap">
      <Head title="Team" sub={`Everyone on the ${user?.vendor?.name} team sees all of its devices.`}
        actions={owner ? <button className="btn" onClick={() => { setInviting(!inviting); setErr(''); }}><Icon name="plus" /> Invite member</button> : undefined} />

      {link && (
        <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
          <div className="stack" style={{ gap: 2 }}><h2>Invite link for {link.label}</h2><span className="xs muted">Opens a page where they accept with their own account, or create one, and join your team as staff.</span></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="inp mono" value={link.url} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="btn" onClick={async () => toast((await copyText(link.url)) ? 'Link copied' : 'Select the link and copy it')}>Copy link</button>
          </div>
          <p className="hint">Send it yourself. It works once and expires on {day(link.expiresAt)}. <b>Copy it now:</b> it won&apos;t be shown again.</p>
          <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setLink(null)}>Done</button>
        </div>
      )}

      {owner && inviting && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>Invite a team member</h2>
          <form className="form" onSubmit={invite}>
            <div className="field"><label htmlFor="vt-name">Who is it for?</label><input className="inp" id="vt-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Nurse Pooja" /><span className="hint">Only a label. You get a link to send them. They join as staff.</span></div>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit">Create invite link</button><button className="btn ghost" type="button" onClick={() => setInviting(false)}>Cancel</button></div>
          </form>
        </div>
      )}

      <Async q={q}>{(t) => <>
        {owner && t.invites.length > 0 && (
          <div className="card"><h2 style={{ marginBottom: 8 }}>Open invites</h2>
            {t.invites.map((i) => (
              <div key={i.id} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="stack" style={{ gap: 0 }}><b className="small">{i.label} · {i.role === 'owner' ? 'Owner' : 'Staff'}</b><span className="xs muted">Link not used yet · expires {day(i.expiresAt)}. Lost it? Cancel and invite again.</span></div>
                <button className="btn danger sm" onClick={() => { if (confirm(`Cancel the invite for ${i.label}?`)) act(() => del(`/vendor/team/invites/${i.id}`), 'Invite cancelled'); }}>Cancel</button>
              </div>
            ))}
          </div>
        )}
        <div className="card"><h2 style={{ marginBottom: 12 }}>Members</h2>
          <div className="tbl"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Joined</th>{owner && <th />}</tr></thead>
            <tbody>{t.members.map((m) => {
              const me = m.userId === user?.id;
              return (
                <tr key={m.userId}>
                  <td><b>{m.fullName}</b>{me && <span className="muted"> (you)</span>}</td>
                  <td className="mono">{prettyPhone(m.phone)}</td>
                  <td>{m.role === 'owner' ? <span className="pill acc">Owner</span> : <span className="pill">Staff</span>}</td>
                  <td className="muted">{day(m.joinedAt)}</td>
                  {owner && <td>{!me && <button className="btn danger sm" onClick={() => { if (confirm(`Remove ${m.fullName} from the team? They stop seeing your devices at once.`)) act(() => del(`/vendor/team/${m.userId}`), 'Removed from the team'); }}>Remove</button>}</td>}
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      </>}</Async>
      {!owner && <div className="note"><Icon name="shield" /><span>Only the vendor owner can invite or remove members.</span></div>}
    </div>
  );
}
