'use client';

// Team & permissions (API.md 9.10–9.18): members, link-only invites {label, roleId}, roles with
// per-permission switches (the Owner role is locked).

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, copyText, Head, useApi } from '@/components/ui';
import { del, errText, patch, post } from '@/lib/api';
import { ago, day, prettyPhone } from '@/lib/format';
import type { Role, RolesResponse, StaffPerm, TeamResponse } from '@/lib/types';

export default function TeamPage() {
  return <RequireStaff perm="team.manage"><Inner /></RequireStaff>;
}

function Inner() {
  const { user, reload: reloadMe } = useAuth();
  const toast = useToast();
  const team = useApi<TeamResponse>('/admin/team');
  const roles = useApi<RolesResponse>('/admin/roles');
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [roleId, setRoleId] = useState<number | ''>('');
  const [link, setLink] = useState<{ label: string; role: string; url: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState('');
  const [newRole, setNewRole] = useState<string | null>(null);

  const roleList = roles.data?.roles || [];
  const iAmOwner = !!roleList.find((r) => r.id === user?.role?.id)?.isOwner;
  const invitable = roleList.filter((r) => !r.isOwner || iAmOwner); // only an Owner can invite an Owner

  const act = async (fn: () => Promise<unknown>, ok: string, reload: (() => void)[]) => {
    try { await fn(); toast(ok); reload.forEach((r) => r()); } catch (e) { toast(errText(e)); reload.forEach((r) => r()); }
  };
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!label.trim()) return setErr('Add a label so you know who this link is for');
    if (!roleId) return setErr('Pick a role');
    try {
      const r = await post<{ inviteUrl: string; expiresAt: string }>('/admin/team/invites', { label: label.trim(), roleId });
      setLink({ label: label.trim(), role: roleList.find((x) => x.id === roleId)?.name || '', url: r.inviteUrl, expiresAt: r.expiresAt });
      setInviting(false); setLabel(''); team.reload();
    } catch (e2) { setErr(errText(e2)); }
  };
  const togglePerm = (r: Role, p: StaffPerm, on: boolean) => {
    const perms = on ? [...r.permissions, p] : r.permissions.filter((x) => x !== p);
    roles.setData((x) => x && { ...x, roles: x.roles.map((y) => (y.id === r.id ? { ...y, permissions: perms } : y)) });
    // my own role changed: reload me so the menu and screens follow at once
    act(() => patch(`/admin/roles/${r.id}`, { permissions: perms }), `${r.name}: ${p} ${on ? 'on' : 'off'}`, r.id === user?.role?.id ? [roles.reload, reloadMe] : [roles.reload]);
  };

  return (
    <div className="wrap">
      <Head title="Team and permissions" sub="Who on the team can do what"
        actions={<button className="btn" onClick={() => { setInviting(!inviting); setErr(''); if (!roleId && invitable.length) setRoleId(invitable.find((r) => !r.isOwner)?.id || invitable[0].id); }}><Icon name="plus" /> Invite member</button>} />

      {link && (
        <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
          <div className="stack" style={{ gap: 2 }}><h2>Invite link for {link.label} · {link.role}</h2><span className="xs muted">Opens a page where they accept with their own account, or create one, and join with this role.</span></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="inp mono" value={link.url} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="btn" onClick={async () => toast((await copyText(link.url)) ? 'Link copied' : 'Select the link and copy it')}>Copy link</button>
          </div>
          <p className="hint">Send it yourself. It works once and expires on {day(link.expiresAt)}. <b>Copy it now:</b> it won&apos;t be shown again.</p>
          <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setLink(null)}>Done</button>
        </div>
      )}

      {inviting && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>Invite a team member</h2>
          <form className="form" onSubmit={invite}>
            <div className="fields2">
              <div className="field"><label htmlFor="ti-name">Who is it for?</label><input className="inp" id="ti-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Meet Shah" /><span className="hint">Only a label. You get a link to send them.</span></div>
              <div className="field"><label htmlFor="ti-role">Role</label><select className="inp" id="ti-role" value={roleId} onChange={(e) => setRoleId(Number(e.target.value))}>{invitable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit">Create invite link</button><button className="btn ghost" type="button" onClick={() => setInviting(false)}>Cancel</button></div>
          </form>
        </div>
      )}

      <Async q={team}>{(t) => <>
        {t.invites.length > 0 && (
          <div className="card"><h2 style={{ marginBottom: 8 }}>Open invites</h2>
            {t.invites.map((i) => (
              <div key={i.id} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="stack" style={{ gap: 0 }}><b className="small">{i.label} · {i.role.name}</b><span className="xs muted">Link not used yet · expires {day(i.expiresAt)}. Lost it? Cancel and invite again.</span></div>
                <button className="btn danger sm" onClick={() => { if (confirm(`Cancel the invite for ${i.label}?`)) act(() => del(`/admin/team/invites/${i.id}`), 'Invite cancelled', [team.reload]); }}>Cancel</button>
              </div>
            ))}
          </div>
        )}
        <div className="card"><h2 style={{ marginBottom: 12 }}>Members</h2>
          <div className="tbl"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Last active</th><th /></tr></thead>
            <tbody>{t.members.map((m) => {
              const me = m.userId === user?.id;
              return (
                <tr key={m.userId}>
                  <td><b>{m.fullName}</b>{me && <span className="muted"> (you)</span>}</td>
                  <td className="mono">{prettyPhone(m.phone)}</td>
                  <td><select className="inp sm" value={m.role.id} disabled={me} aria-label={`Role for ${m.fullName}`}
                    onChange={(e) => act(() => patch(`/admin/team/${m.userId}`, { roleId: Number(e.target.value) }), 'Role changed', [team.reload, roles.reload])}>
                    {roleList.filter((r) => !r.isOwner || iAmOwner || r.id === m.role.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select></td>
                  <td className="muted">{ago(m.lastActiveAt)}</td>
                  <td>{!me && <button className="btn danger sm" onClick={() => { if (confirm(`Remove ${m.fullName} from the team? Their account stays as a customer.`)) act(() => del(`/admin/team/${m.userId}`), 'Removed from the team', [team.reload, roles.reload]); }}>Remove</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      </>}</Async>

      <Async q={roles}>{(r) => (
        <div className="card">
          <div className="ch"><div className="t"><h2>Roles</h2><span className="xs muted">Switch a permission on or off for a whole role. Owner always has everything.</span></div>
            {newRole === null ? <button className="btn ghost sm" onClick={() => setNewRole('')}><Icon name="plus" size={16} /> Add role</button>
              : <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (!newRole.trim()) return; act(() => post('/admin/roles', { name: newRole.trim(), permissions: ['devices.view'] }), 'Role added', [roles.reload]).then(() => setNewRole(null)); }}>
                <input className="inp sm" value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="Role name" aria-label="New role name" autoFocus />
                <button className="btn sm" type="submit">Add</button><button className="btn ghost sm" type="button" onClick={() => setNewRole(null)}>Cancel</button>
              </form>}
          </div>
          <div className="tbl"><table className="matrix">
            <thead><tr><th>Permission</th>{r.roles.map((x) => <th key={x.id}>{x.name}<br /><span className="xs muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{x.memberCount} {x.memberCount === 1 ? 'member' : 'members'}</span></th>)}</tr></thead>
            <tbody>
              {r.permissions.map((p) => (
                <tr key={p.code}><td><span>{p.label}</span><br /><span className="xs muted mono">{p.code}</span></td>
                  {r.roles.map((x) => <td key={x.id}><input type="checkbox" className="sw" aria-label={`${p.label} for ${x.name}`} checked={x.isOwner || x.permissions.includes(p.code)} disabled={x.isOwner}
                    onChange={(e) => togglePerm(x, p.code, e.target.checked)} /></td>)}
                </tr>
              ))}
              <tr><td className="muted small">Delete role</td>
                {r.roles.map((x) => <td key={x.id}>{!x.isOwner && <button className="btn danger sm" disabled={x.memberCount > 0} title={x.memberCount ? 'Move its members to another role first' : undefined}
                  onClick={() => { if (confirm(`Delete the ${x.name} role?`)) act(() => del(`/admin/roles/${x.id}`), 'Role deleted', [roles.reload]); }}>Delete</button>}</td>)}
              </tr>
            </tbody>
          </table></div>
        </div>
      )}</Async>
      <div className="note"><Icon name="shield" /><span>Customers use the same system when they share a sensor with family: a list of permissions, switched on per person.</span></div>
    </div>
  );
}
