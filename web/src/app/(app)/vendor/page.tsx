'use client';

// Vendor stock & devices (API.md 15.2, v2.1): counts, then every sensor of my vendor by stage.
//   In stock: added by QR scan only. No data is kept. Actions: "Use here" (or sell: the customer
//             scans the same sticker).
//   In use:   the vendor uses it itself (QR locked). Group, temporary access, sleep, live,
//             and "Back to stock" (history deleted, QR works again).
//   Sold:     a record only (customer + date). The vendor has no access.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireVendor } from '@/components/Shell';
import { Async, Head, StatusPill, TzSelect, useApi } from '@/components/ui';
import { StagePill, StockTiles } from '@/components/vendor';
import { errText, post, put } from '@/lib/api';
import { ago, browserTz, day, placeName, prettyPhone, presenceText, TIMEZONES } from '@/lib/format';
import { useAccessChanged, useLive } from '@/lib/useLive';
import type { DeviceCard, DeviceDetail, Grant, VendorDevices, VendorGroup, VendorStage, VendorSummary } from '@/lib/types';

export default function VendorDevicesPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

function Inner() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useApi<VendorDevices>('/vendor/devices');
  const groups = useApi<{ items: VendorGroup[] }>('/vendor/groups');
  const grants = useApi<{ items: Grant[] }>('/vendor/grants');
  const summary = useApi<VendorSummary>('/vendor/summary');
  const [filter, setFilter] = useState<string>('all');
  const [stage, setStage] = useState<'all' | VendorStage>('all');
  const [using, setUsing] = useState<string | null>(null);   // device id with the "Use here" form open
  const items = q.data?.items || [];
  const sold = q.data?.sold || [];
  const { live, status } = useLive(items.map((d) => d.id), items.map((d) => d.id));
  useAccessChanged((m) => { if (m.myPermissions === null) q.setData((x) => x && { ...x, items: x.items.filter((d) => d.id !== m.deviceId) }); });
  const online = (d: DeviceCard) => status[d.id]?.online ?? d.status.online;
  const active = (id: string) => (grants.data?.items || []).filter((g) => g.device.id === id && g.status === 'active').length;
  const gl = groups.data?.items || [];
  const shown = stage === 'sold' ? [] : items.filter((d) => (stage === 'all' || d.stage === stage)
    && (filter === 'all' || (filter === 'none' ? !d.group : d.group?.id === filter)));
  const nStage = (s: VendorStage) => items.filter((d) => d.stage === s).length;
  const reload = () => { q.reload(); summary.reload(); groups.reload(); grants.reload(); };
  const label = (d: DeviceCard) => d.name || d.serial;

  const setGroup = async (d: DeviceCard, groupId: string) => {
    try {
      const r = await put<{ deviceId: string; group: { id: string; name: string } | null }>(`/vendor/devices/${d.id}/group`, { groupId: groupId || null });
      toast(r.group ? `${label(d)} moved to ${r.group.name}` : `${label(d)}: no group`);
      reload();
    } catch (e) { toast(errText(e)); }
  };
  const toStock = async (d: DeviceCard) => {
    if (!confirm(`Put ${label(d)} back in stock?\n\nIts sleep history, alerts and temporary access are deleted, so the next user starts clean. The QR sticker works again.`)) return;
    try { await post(`/vendor/devices/${d.id}/stock`); toast(`${d.serial} is back in stock`); reload(); } catch (e) { toast(errText(e)); }
  };

  return (
    <div className="wrap">
      <Head title="Stock & devices" sub={q.data ? `${user?.vendor?.name} · ${items.length + sold.length} sensor${items.length + sold.length === 1 ? '' : 's'}` : undefined}
        actions={<><Link className="btn ghost" href="/vendor/access"><Icon name="clock" /> Give access</Link><Link className="btn" href="/devices/add"><Icon name="plus" /> Add to stock</Link></>} />
      {summary.data && <StockTiles s={summary.data} />}
      <div className="row">
        <div className="seg" role="tablist" aria-label="Stage">
          {([['all', `All (${items.length})`], ['stock', `In stock (${nStage('stock')})`], ['in_use', `In use (${nStage('in_use')})`], ['sold', `Sold (${sold.length})`]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={stage === k} className={stage === k ? 'on' : ''} onClick={() => setStage(k)}>{l}</button>
          ))}
        </div>
        {gl.length > 0 && stage !== 'sold' && stage !== 'stock' && (
          <select className="inp sm" aria-label="Group" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All groups</option>
            {gl.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.deviceCount})</option>)}
            <option value="none">No group</option>
          </select>
        )}
      </div>

      <Async q={q}>{() => stage === 'sold' ? <SoldList items={sold} /> : shown.length ? (
        <div className="dgrid">
          {shown.map((d) => {
            const on = online(d);
            const lv = live[d.id] || d.live;
            if (d.stage !== 'in_use') return (
              <div className="card dcard" key={d.id}>
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}><h2 className="mono">{d.serial}</h2><span className="xs muted">In stock since {day(d.stockedAt)}</span></div>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><StagePill stage="stock" /><StatusPill online={on} /></div>
                </div>
                {using === d.id
                  ? <UseHereForm d={d} groups={gl} onCancel={() => setUsing(null)} onDone={(x) => { setUsing(null); toast(`${x.name} is in use`); reload(); }} />
                  : <>
                    <p className="xs muted">No data is kept while it is in stock. To sell it, give it to the customer with its sticker: they scan it and become the owner.</p>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => setUsing(d.id)}>Use here</button>
                      <Link className="btn ghost sm" href={`/devices/${d.id}`}>Test live</Link>
                    </div>
                  </>}
              </div>
            );
            const n = active(d.id);
            return (
              <div className="card dcard" key={d.id}>
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <h2>{label(d)}</h2>
                    <span className="xs muted">{[d.room, d.serial].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><StagePill stage="in_use" /><StatusPill online={on} /></div>
                </div>
                {on && lv ? (
                  <div className="vitals">
                    <div className="vital"><span>Heart</span><b>{lv.hr || '—'}<span> bpm</span></b></div>
                    <div className="vital"><span>Breath</span><b>{lv.br || '—'}<span> /min</span></b></div>
                    <div className="vital"><span>Now</span><b style={{ fontSize: 15, paddingBlock: 3 }}>{presenceText(lv.pr, lv.bed)}</b></div>
                  </div>
                ) : !on ? (
                  <div className="note"><Icon name="off" /><span>Last seen {ago(status[d.id]?.lastSeenAt ?? d.status.lastSeenAt).toLowerCase()}.</span></div>
                ) : <div className="note"><Icon name="info" /><span>Waiting for the first reading…</span></div>}
                <div className="between">
                  <div className="row" style={{ gap: 8 }}>
                    <select className="inp sm" aria-label={`Group for ${label(d)}`} value={d.group?.id || ''} onChange={(e) => setGroup(d, e.target.value)} style={{ width: 'auto' }}>
                      <option value="">No group</option>
                      {gl.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <span className={`pill ${n ? 'ok' : ''}`} title="People with temporary access right now">{n} active access{n === 1 ? '' : 'es'}</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Link className="btn ghost sm" href={`/vendor/access?device=${d.id}`}>Access</Link>
                    <Link className="btn ghost sm" href={`/history/${d.id}`}>Sleep</Link>
                    <Link className="btn sm" href={`/devices/${d.id}`}>Live</Link>
                  </div>
                </div>
                <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => toStock(d)}>Back to stock…</button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card empty">
          <Icon name="chip" size={30} />
          <h2>{items.length ? 'No sensors here' : 'No sensors yet'}</h2>
          <p>{items.length ? 'Pick another tab or group.' : `Scan the QR sticker on a sensor to add it to the stock of ${user?.vendor?.name}. Keep the sticker on the sensor: a customer you sell it to scans it later.`}</p>
          {!items.length && <Link className="btn" href="/devices/add"><Icon name="plus" /> Add to stock</Link>}
        </div>
      )}</Async>
    </div>
  );
}

function SoldList({ items }: { items: VendorDevices['sold'] }) {
  if (!items.length) return <div className="card empty"><Icon name="tag" size={30} /><h2>Nothing sold yet</h2><p>When a customer scans the sticker of a sensor in your stock, it shows here.</p></div>;
  return (
    <div className="card">
      <p className="xs muted" style={{ marginBottom: 10 }}>Your sales record. The customer owns these sensors, so you can&apos;t see their data.</p>
      <div className="tbl"><table>
        <thead><tr><th>Serial</th><th>Customer</th><th>Phone</th><th>Sold</th></tr></thead>
        <tbody>{items.map((s) => (
          <tr key={s.id}><td className="mono">{s.serial}</td><td><b>{s.customer.fullName}</b></td><td className="mono">{prettyPhone(s.customer.phone)}</td><td className="muted">{day(s.soldAt)}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/** "Use here": the vendor uses a stock sensor itself (API 15.2f). Same questions as a customer claim, plus a group. */
function UseHereForm({ d, groups, onCancel, onDone }: { d: DeviceCard; groups: VendorGroup[]; onCancel(): void; onDone(x: DeviceDetail): void }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [tz, setTz] = useState('Asia/Kolkata');
  const [place, setPlace] = useState('');
  const [groupId, setGroupId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTz(browserTz()), []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setErr('Give the sensor a name');
    setErr(''); setBusy(true);
    try {
      onDone(await post<DeviceDetail>(`/vendor/devices/${d.id}/use`, { name: name.trim(), room: room.trim() || undefined, tz, place: place.trim() || undefined, groupId: groupId || undefined }));
    } catch (e2) { setErr(errText(e2)); setBusy(false); }
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label htmlFor={`uh-n-${d.id}`}>Name</label><input className="inp" id={`uh-n-${d.id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bed 4" /></div>
      <div className="field"><label htmlFor={`uh-r-${d.id}`}>Room (optional)</label><input className="inp" id={`uh-r-${d.id}`} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Ward B" /></div>
      <div className="field"><label htmlFor={`uh-tz-${d.id}`}>Time zone where the sensor is</label><TzSelect id={`uh-tz-${d.id}`} value={tz} onChange={setTz} options={TIMEZONES} /></div>
      <div className="field"><label htmlFor={`uh-p-${d.id}`}>Town or city (optional)</label><input className="inp" id={`uh-p-${d.id}`} value={place} onChange={(e) => setPlace(e.target.value)} placeholder={placeName(tz, null)} /></div>
      {groups.length > 0 && (
        <div className="field"><label htmlFor={`uh-g-${d.id}`}>Group (optional)</label>
          <select className="inp" id={`uh-g-${d.id}`} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">No group</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select></div>
      )}
      <p className="hint">While it is in use, the QR sticker is locked: nobody else can claim it.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row"><button className="btn sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Start using'}</button><button className="btn ghost sm" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
