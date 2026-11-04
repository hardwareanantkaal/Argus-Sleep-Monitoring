'use client';

// Live view (API.md 3.4 + Socket.IO live:subscribe / device:live). Values are shown, never stored.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { Spark } from '@/components/charts';
import { Icon } from '@/components/Icon';
import { CompositeCard, firstLocalMin, pushStage, SessionCard } from '@/components/LiveTelemetry';
import { Async, Head, PH, TzTag, useApi } from '@/components/ui';
import { ago, BREATH_STATE, moveText, presenceText, STAGE_NAME } from '@/lib/format';
import { useLive, type LiveMsg } from '@/lib/useLive';
import type { DeviceDetail } from '@/lib/types';

const KEEP = 40; // points in each sparkline

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<DeviceDetail>(`/devices/${id}`);
  const d = q.data;
  const canLive = !!d?.myPermissions.includes('live.view');
  const hist = useRef<{ hr: number[]; br: number[] }>({ hr: [], br: [] });
  const stages = useRef<{ first: number | null; mins: string[] }>({ first: null, mins: [] }); // live hypnogram from sess.st
  const [, bump] = useState(0);
  const { live, status } = useLive(d ? [d.id] : [], d && canLive ? [d.id] : [], (m: LiveMsg) => {
    if (m.hr) hist.current.hr = [...hist.current.hr, m.hr].slice(-KEEP);
    if (m.br) hist.current.br = [...hist.current.br, m.br].slice(-KEEP);
    if (d) pushStage(stages.current, m, d.tz);
    bump((n) => n + 1);
  });

  return (
    <Async q={q}>{(d) => {
      const online = status[d.id]?.online ?? d.status.online;
      const lv = live[d.id] || d.live || null;
      const perms = d.myPermissions;
      const acts = <>
        {perms.includes('sharing.manage') && <Link className="btn ghost sm" href={`/devices/${d.id}/share`}><Icon name="share" size={16} /> Share</Link>}
        {perms.includes('settings.edit') && <Link className="btn ghost sm" href={`/devices/${d.id}/settings`}><Icon name="gear" size={16} /> Settings</Link>}
      </>;
      const histBtn = perms.includes('history.view') && <Link className="btn ghost" style={{ alignSelf: 'flex-start' }} href={`/history/${d.id}`}><Icon name="moon" /> See sleep history</Link>;
      const back: [string, string] = ['/devices', 'My devices'];

      if (!canLive) return (
        <div className="wrap">
          <Head title={d.name} sub={d.room || d.serial} actions={acts} back={back} />
          <div className="card empty"><Icon name="shield" size={30} /><h2>Live values aren&apos;t shared with you</h2><p>Ask the owner to turn on “See live values” for you.</p></div>
          {histBtn}
        </div>
      );
      if (!online) return (
        <div className="wrap">
          <Head title={d.name} sub={d.room || d.serial} actions={acts} back={back} />
          <div className="card empty"><Icon name="off" size={32} /><h2>Sensor is offline</h2><p>Last seen {ago(status[d.id]?.lastSeenAt ?? d.status.lastSeenAt).toLowerCase()}. Live values show again as soon as it reconnects.</p></div>
          {histBtn}
        </div>
      );

      const hr = lv?.hr || 0, br = lv?.br || 0, mr = lv?.mr ?? 0;
      const bs = BREATH_STATE[lv?.bs ?? 1] || BREATH_STATE[4];
      const hrs = hist.current.hr, brs = hist.current.br;
      return (
        <div className="wrap">
          <Head
            title={<>{d.name} <span className="pill live" style={{ verticalAlign: 'middle', marginLeft: 6 }}><span className="dot pulse" />LIVE</span></>}
            sub={<>{d.room ? `${d.room} · ` : ''}updates every few seconds while someone is in bed<TzTag tz={d.tz} place={d.place} /></>}
            actions={acts} back={back} />
          <div className="g2">
            <div className="card metric"><div className="top"><Icon name="person" /> Presence</div><div className="big" style={{ fontSize: 36 }}>{presenceText(lv?.pr, lv?.bed)}</div>
              <span className="small muted">{lv?.dist ? <>Person about {lv.dist} cm away <PH /></> : 'Waiting for a reading…'}</span></div>
            <div className="card metric"><div className="top"><Icon name="moon" /> Sleep stage <PH /></div><div className="big" style={{ fontSize: 36 }}>{lv?.bed ? STAGE_NAME[lv.ss] ?? '—' : '—'}</div>
              <span className="small muted">Deep, light or awake. The sensor does not report REM.</span></div>
          </div>
          <div className="metrics">
            <div className="card metric"><div className="top"><Icon name="heart" /> Heart rate</div><div className="big"><span>{hr || '—'}</span><small>bpm</small></div>
              <Spark vals={hrs} min={Math.min(...hrs, hr || 60) - 4} max={Math.max(...hrs, hr || 60) + 4} col="var(--bad)" /></div>
            <div className="card metric"><div className="top"><Icon name="wind" /> Breath rate <span className="sp" />{lv?.bed ? <span className={`pill ${bs[1]}`}>{bs[0]}</span> : null}</div><div className="big"><span>{br || '—'}</span><small>/min</small></div>
              <Spark vals={brs} min={Math.min(...brs, br || 14) - 3} max={Math.max(...brs, br || 14) + 3} col="var(--live)" /></div>
            <div className="card metric"><div className="top"><Icon name="activity" /> Movement range</div><div className="big"><span>{mr}</span><small>/ 100</small></div>
              <div className="meter"><i style={{ width: `${mr}%` }} /></div><span className="xs muted">{moveText(mr)}</span></div>
          </div>
          <div className="g2">
            <div className="card"><div className="between"><div className="row small muted" style={{ gap: 8 }}><Icon name="wifi" /> Signal</div><b className="num">{lv?.rssi ?? d.connection?.rssi ?? '—'} dBm</b></div></div>
            <div className="card"><div className="between"><div className="row small muted" style={{ gap: 8 }}><Icon name="chip" /> Serial</div><b className="mono">{d.serial}</b></div></div>
          </div>
          <CompositeCard lv={lv} fw={d.connection?.fw} rssi={d.connection?.rssi} />
          <SessionCard lv={lv} tz={d.tz} stages={stages.current.mins.join('')} firstMin={firstLocalMin(stages.current.first, d.tz)} />
          <div className="note"><Icon name="info" /><span>Live values come straight from the sensor and are <b>not saved</b>. The saved record is the nightly sleep summary.</span></div>
          {histBtn}
        </div>
      );
    }}</Async>
  );
}
