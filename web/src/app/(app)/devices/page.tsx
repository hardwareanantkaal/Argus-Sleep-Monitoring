'use client';

// My devices: sensors I own or that are shared with me (API.md 3.1), with live values on each card.

import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { Async, Head, ScoreRing, StatusPill, useApi } from '@/components/ui';
import { ago, dur, presenceText } from '@/lib/format';
import { useLive } from '@/lib/useLive';
import type { DeviceCard } from '@/lib/types';

export default function DevicesPage() {
  const q = useApi<{ items: DeviceCard[] }>('/devices');
  const items = q.data?.items || [];
  const { live, status } = useLive(items.map((d) => d.id), items.filter((d) => d.myPermissions.includes('live.view')).map((d) => d.id));
  const online = (d: DeviceCard) => status[d.id]?.online ?? d.status.online;

  const addBtn = <Link className="btn" href="/devices/add"><Icon name="plus" /> Add device</Link>;
  return (
    <div className="wrap">
      <Head title="My devices" sub={q.data ? `${items.length} sensor${items.length === 1 ? '' : 's'} · ${items.filter(online).length} online` : undefined} actions={addBtn} />
      <Async q={q}>{() => items.length ? (
        <div className="dgrid">
          {items.map((d) => {
            const on = online(d);
            const lv = live[d.id] || d.live;
            const canLive = d.myPermissions.includes('live.view');
            const canHist = d.myPermissions.includes('history.view');
            return (
              <div className="card dcard" key={d.id}>
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <h2>{d.name}</h2>
                    <span className="xs muted">{[d.room, d.sharedBy && `shared by ${d.sharedBy.fullName}`].filter(Boolean).join(' · ') || d.serial}</span>
                  </div>
                  <StatusPill online={on} />
                </div>
                {on && canLive && lv ? (
                  <div className="vitals">
                    <div className="vital"><span>Heart</span><b>{lv.hr || '—'}<span> bpm</span></b></div>
                    <div className="vital"><span>Breath</span><b>{lv.br || '—'}<span> /min</span></b></div>
                    <div className="vital"><span>Now</span><b style={{ fontSize: 15, paddingBlock: 3 }}>{presenceText(lv.pr, lv.bed)}</b></div>
                  </div>
                ) : !on ? (
                  <div className="note"><Icon name="off" /><span>Last seen {ago(status[d.id]?.lastSeenAt ?? d.status.lastSeenAt).toLowerCase()}. Check that it is plugged in and on Wi-Fi.</span></div>
                ) : <div className="note"><Icon name="info" /><span>{canLive ? 'Waiting for the first reading…' : 'You can see sleep history for this sensor, not live values.'}</span></div>}
                <div className="between">
                  <div className="row" style={{ gap: 10 }}>
                    {canHist && d.lastNight ? <>
                      <ScoreRing v={d.lastNight.score} />
                      <div className="stack" style={{ gap: 0 }}><span className="xs muted">Last night</span><b className="small">{dur(d.lastNight.totalSleepMin)} asleep</b></div>
                    </> : <span className="xs muted">{canHist ? 'No nights yet' : ''}</span>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {canHist && <Link className="btn ghost sm" href={`/history/${d.id}`}>Sleep</Link>}
                    {canLive ? <Link className="btn sm" href={`/devices/${d.id}`}>Live</Link> : <Link className="btn ghost sm" href={`/devices/${d.id}`}>Open</Link>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card empty">
          <Icon name="bed" size={30} />
          <h2>No devices yet</h2>
          <p>Scan the QR sticker on your sensor to add it. If someone shared a sensor with you, open the invite link they sent.</p>
          {addBtn}
        </div>
      )}</Async>
    </div>
  );
}
