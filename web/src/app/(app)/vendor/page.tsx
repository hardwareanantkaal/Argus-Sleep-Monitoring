'use client';

// Vendor devices (API.md 15.2): stock counts (v2), then every device of my vendor with its stage
// (in stock / sold + customer), group, online, live summary and how many temporary accesses are
// running. Filter by stage and group; move a device to a group.

import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireVendor } from '@/components/Shell';
import { Async, Head, StatusPill, useApi } from '@/components/ui';
import { errText, put } from '@/lib/api';
import { StagePill, StockTiles } from '@/components/vendor';
import { ago, day, prettyPhone, presenceText } from '@/lib/format';
import { useAccessChanged, useLive } from '@/lib/useLive';
import type { DeviceCard, Grant, VendorGroup, VendorStage, VendorSummary } from '@/lib/types';

export default function VendorDevicesPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

function Inner() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useApi<{ items: DeviceCard[] }>('/vendor/devices');
  const groups = useApi<{ items: VendorGroup[] }>('/vendor/groups');
  const grants = useApi<{ items: Grant[] }>('/vendor/grants');
  const summary = useApi<VendorSummary>('/vendor/summary');
  const [filter, setFilter] = useState<string>('all');
  const [stage, setStage] = useState<'all' | VendorStage>('all');
  const items = q.data?.items || [];
  const { live, status } = useLive(items.map((d) => d.id), items.map((d) => d.id));
  useAccessChanged((m) => { if (m.myPermissions === null) q.setData((x) => x && { items: x.items.filter((d) => d.id !== m.deviceId) }); });
  const online = (d: DeviceCard) => status[d.id]?.online ?? d.status.online;
  const active = (id: string) => (grants.data?.items || []).filter((g) => g.device.id === id && g.status === 'active').length;
  const gl = groups.data?.items || [];
  const shown = items.filter((d) => (stage === 'all' || d.stage === stage)
    && (filter === 'all' || (filter === 'none' ? !d.group : d.group?.id === filter)));
  const nStage = (s: VendorStage) => items.filter((d) => d.stage === s).length;

  const setGroup = async (d: DeviceCard, groupId: string) => {
    try {
      const r = await put<{ deviceId: string; group: { id: string; name: string } | null }>(`/vendor/devices/${d.id}/group`, { groupId: groupId || null });
      q.setData((x) => x && { items: x.items.map((y) => (y.id === d.id ? { ...y, group: r.group } : y)) });
      toast(r.group ? `${d.name} moved to ${r.group.name}` : `${d.name}: no group`);
      groups.reload();
    } catch (e) { toast(errText(e)); }
  };

  return (
    <div className="wrap">
      <Head title="Devices" sub={q.data ? `${user?.vendor?.name} · ${items.length} sensor${items.length === 1 ? '' : 's'} · ${items.filter(online).length} online` : undefined}
        actions={<><Link className="btn ghost" href="/vendor/access"><Icon name="clock" /> Give access</Link><Link className="btn" href="/devices/add"><Icon name="plus" /> Add device</Link></>} />
      {summary.data && <StockTiles s={summary.data} />}
      <div className="row">
        <div className="seg" role="tablist" aria-label="Stage">
          {([['all', `All (${items.length})`], ['stock', `In stock (${nStage('stock')})`], ['sold', `Sold (${nStage('sold')})`]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={stage === k} className={stage === k ? 'on' : ''} onClick={() => setStage(k)}>{l}</button>
          ))}
        </div>
        <Link className="btn ghost sm" href="/vendor/customers"><Icon name="person" /> Customers</Link>
      </div>
      {gl.length > 0 && (
        <div className="row">
          <label className="small muted" htmlFor="vd-filter">Group</label>
          <select className="inp sm" id="vd-filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All groups</option>
            {gl.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.deviceCount})</option>)}
            <option value="none">No group</option>
          </select>
        </div>
      )}
      <Async q={q}>{() => shown.length ? (
        <div className="dgrid">
          {shown.map((d) => {
            const on = online(d);
            const lv = live[d.id] || d.live;
            const n = active(d.id);
            return (
              <div className="card dcard" key={d.id}>
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <h2>{d.name}</h2>
                    <span className="xs muted">{[d.room, d.serial].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><StagePill stage={d.stage} /><StatusPill online={on} /></div>
                </div>
                {d.stage === 'sold' && d.customer
                  ? <div className="xs muted">Sold to <b>{d.customer.fullName}</b> · {prettyPhone(d.customer.phone)}{d.soldAt ? ` · ${day(d.soldAt)}` : ''}</div>
                  : <div className="xs muted">In stock since {day(d.stockedAt)}. The customer scans the same sticker to become the owner.</div>}
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
                    <select className="inp sm" aria-label={`Group for ${d.name}`} value={d.group?.id || ''} onChange={(e) => setGroup(d, e.target.value)} style={{ width: 'auto' }}>
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
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card empty">
          <Icon name="chip" size={30} />
          <h2>{items.length ? 'No devices here' : 'No devices yet'}</h2>
          <p>{items.length ? 'Pick another stage or group, or move a device into this group.' : `Scan the QR sticker on a sensor to add it to the stock of ${user?.vendor?.name}. Keep the sticker on the sensor: the customer scans it later.`}</p>
          {!items.length && <Link className="btn" href="/devices/add"><Icon name="plus" /> Add device</Link>}
        </div>
      )}</Async>
    </div>
  );
}
