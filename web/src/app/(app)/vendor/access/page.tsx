'use client';

// Temporary access (API.md 15.5): give one person access to one device from a start to an end time.
// Times are picked in this browser's local time and sent as ISO 8601 with the offset.
// The login link is shown once. Access stops by itself at the end; extend it or end it now.

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { RequireVendor } from '@/components/Shell';
import { Async, copyText, Head, useApi } from '@/components/ui';
import { DEFAULT_GRANT_PERMS, GRANT_PERMS, GrantStatusPill, localToIso, toLocalInput, whenLocal } from '@/components/vendor';
import { errText, patch, post, qs } from '@/lib/api';
import { prettyPhone } from '@/lib/format';
import type { DeviceCard, Grant, GrantCreated, GrantPerm } from '@/lib/types';

export default function VendorAccessPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

const plusDays = (n: number) => { const d = new Date(Date.now() + n * 86400000); d.setSeconds(0, 0); return d; };
const LIVE_STATUSES = ['invite_sent', 'scheduled', 'active'];

function Inner() {
  const toast = useToast();
  const devices = useApi<{ items: DeviceCard[] }>('/vendor/devices');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [all, setAll] = useState(false);
  const grants = useApi<{ items: Grant[] }>(`/vendor/grants${qs({ deviceId: deviceFilter || undefined, status: all ? 'all' : undefined })}`);
  // ?device=<id> from the Devices screen: preselect it
  useEffect(() => { const d = new URLSearchParams(window.location.search).get('device'); if (d) { setDeviceFilter(d); setForm((f) => ({ ...f, deviceId: d })); setCreating(true); } }, []);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ deviceId: string; label: string; perms: GrantPerm[]; start: string; end: string }>(
    { deviceId: '', label: '', perms: DEFAULT_GRANT_PERMS, start: '', end: '' });
  useEffect(() => setForm((f) => ({ ...f, start: f.start || toLocalInput(plusDays(0)), end: f.end || toLocalInput(plusDays(7)) })), []); // client only: local time
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ label: string; device: string; url: string; expiresAt: string } | null>(null);
  const [extend, setExtend] = useState<{ id: string; end: string } | null>(null);

  const devs = devices.data?.items || [];
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!form.deviceId) return setErr('Pick a device');
    if (!form.label.trim()) return setErr('Who is it for? Add a label for your list');
    if (!form.perms.length) return setErr('Pick at least one thing they can do');
    const startsAt = localToIso(form.start), endsAt = localToIso(form.end);
    if (!startsAt || !endsAt) return setErr('Pick a start and an end date and time');
    if (new Date(endsAt) <= new Date(startsAt)) return setErr('The end must be after the start');
    setBusy(true);
    try {
      const r = await post<GrantCreated>('/vendor/grants', { deviceId: form.deviceId, label: form.label.trim(), permissions: form.perms, startsAt, endsAt });
      setLink({ label: r.grant.label, device: r.grant.device.name, url: r.inviteUrl, expiresAt: r.expiresAt });
      setCreating(false); setForm({ ...form, label: '', perms: DEFAULT_GRANT_PERMS }); grants.reload();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  const saveExtend = async (g: Grant) => {
    const endsAt = extend && localToIso(extend.end);
    if (!endsAt) return toast('Pick a new end date and time');
    try { await patch(`/vendor/grants/${g.id}`, { endsAt }); toast(`Access for ${g.label} now ends ${whenLocal(endsAt)}`); setExtend(null); grants.reload(); } catch (e) { toast(errText(e)); }
  };
  const endNow = async (g: Grant) => {
    if (!confirm(`End access for ${g.label} to ${g.device.name} now?${g.user ? ' They lose the device at once.' : ' The link stops working.'}`)) return;
    try { await post(`/vendor/grants/${g.id}/end`); toast('Access ended'); grants.reload(); } catch (e) { toast(errText(e)); }
  };

  return (
    <div className="wrap">
      <Head title="Temporary access" sub="Give a patient, family member or guest access to one device for a set time."
        actions={<button className="btn" onClick={() => { setCreating(!creating); setErr(''); }}><Icon name="plus" /> Give access</button>} />

      {link && (
        <div className="card stack" style={{ gap: 12, borderColor: 'var(--accent)' }}>
          <div className="stack" style={{ gap: 2 }}><h2>Login link for {link.label} · {link.device}</h2><span className="xs muted">Opens a page where they log in or create an account. Access starts and ends at the times you set.</span></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="inp mono" value={link.url} readOnly style={{ minWidth: 0 }} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="btn" onClick={async () => toast((await copyText(link.url)) ? 'Link copied' : 'Select the link and copy it')}>Copy link</button>
          </div>
          <p className="hint">Send it yourself. It works once and expires {whenLocal(link.expiresAt)}. <b>Copy it now:</b> it won&apos;t be shown again.</p>
          <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setLink(null)}>Done</button>
        </div>
      )}

      {creating && (
        <div className="card"><h2 style={{ marginBottom: 14 }}>Give temporary access</h2>
          <form className="form" onSubmit={create}>
            <div className="fields2">
              <div className="field"><label htmlFor="ga-dev">Device</label>
                <select className="inp" id="ga-dev" value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
                  <option value="">Pick a device…</option>
                  {devs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.group ? ` · ${d.group.name}` : ''} ({d.serial})</option>)}
                </select></div>
              <div className="field"><label htmlFor="ga-label">Who is it for?</label><input className="inp" id="ga-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Ramesh (son)" /><span className="hint">Only a label. You get a link to send them.</span></div>
            </div>
            <div className="fields2">
              <div className="field"><label htmlFor="ga-start">Starts</label><input className="inp" type="datetime-local" id="ga-start" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></div>
              <div className="field"><label htmlFor="ga-end">Ends</label><input className="inp" type="datetime-local" id="ga-end" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /><span className="hint">Your local time. Access stops by itself at the end.</span></div>
            </div>
            <div className="field"><span className="label">They can</span>
              {GRANT_PERMS.map(([k, l]) => (
                <label className="tog" key={k}>
                  <span className="t"><span>{l}</span><span className="xs muted mono">{k}</span></span>
                  <input type="checkbox" className="sw" checked={form.perms.includes(k)} onChange={(e) => setForm({ ...form, perms: e.target.checked ? [...form.perms, k] : form.perms.filter((x) => x !== k) })} />
                </label>
              ))}
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create login link'}</button><button className="btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
          </form>
        </div>
      )}

      <div className="row">
        <select className="inp sm" aria-label="Device" value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All devices</option>
          {devs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={!all} className={!all ? 'on' : ''} onClick={() => setAll(false)}>Current</button>
          <button role="tab" aria-selected={all} className={all ? 'on' : ''} onClick={() => setAll(true)}>All</button>
        </div>
      </div>

      <Async q={grants}>{(r) => r.items.length ? (
        <div className="card">
          <div className="tbl"><table>
            <thead><tr><th>For</th><th>Device</th><th>From</th><th>Until</th><th>Status</th><th /></tr></thead>
            <tbody>{r.items.map((g) => {
              const open = LIVE_STATUSES.includes(g.status);
              return (
                <tr key={g.id}>
                  <td><b>{g.label}</b><br /><span className="xs muted">{g.user ? `${g.user.fullName} · ${prettyPhone(g.user.phone)}` : g.status === 'invite_sent' ? `Link not used yet · expires ${whenLocal(g.inviteExpiresAt)}` : 'Link not used'}</span></td>
                  <td>{g.device.name}<br /><span className="xs muted mono">{g.device.serial}</span></td>
                  <td className="muted">{whenLocal(g.startsAt)}</td>
                  <td>{extend?.id === g.id ? (
                    <form className="row" style={{ gap: 6, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); saveExtend(g); }}>
                      <input className="inp sm" type="datetime-local" value={extend.end} onChange={(e) => setExtend({ ...extend, end: e.target.value })} aria-label="New end" />
                      <button className="btn sm" type="submit">Save</button><button className="btn ghost sm" type="button" onClick={() => setExtend(null)}>Cancel</button>
                    </form>
                  ) : <span className="muted">{whenLocal(g.endedAt || g.endsAt)}</span>}</td>
                  <td><GrantStatusPill s={g.status} /></td>
                  <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    {g.status !== 'ended' && extend?.id !== g.id && <button className="btn ghost sm" onClick={() => setExtend({ id: g.id, end: toLocalInput(new Date(Math.max(Date.now(), new Date(g.endsAt).getTime()) + 86400000)) })}>Extend</button>}
                    {open && <button className="btn danger sm" onClick={() => endNow(g)}>End now</button>}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      ) : <div className="card empty"><Icon name="clock" size={30} /><h2>No {all ? '' : 'current '}access</h2><p>Use “Give access” to send someone a login link for one device.</p></div>}</Async>
    </div>
  );
}
