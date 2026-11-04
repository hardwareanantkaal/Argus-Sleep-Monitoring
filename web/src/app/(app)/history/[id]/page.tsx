'use client';

// Sleep history: one card per night (main sleep), with session and nap badges (API.md 4.1).
// Times are in the device's time zone.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { BarChart } from '@/components/charts';
import { Icon } from '@/components/Icon';
import { Async, ErrorBox, Head, Legend, PH, ScoreRing, StageBar, TzTag, useApi } from '@/components/ui';
import { dur, sleepDateLabel, timeIn } from '@/lib/format';
import { isMain, type DeviceCard, type NightsResponse } from '@/lib/types';

const napMin = (n: { start: string; end: string }) => Math.round((new Date(n.end).getTime() - new Date(n.start).getTime()) / 60000);

export default function HistoryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const devs = useApi<{ items: DeviceCard[] }>('/devices');
  const q = useApi<NightsResponse>(`/devices/${id}/nights?days=14`);
  const list = (devs.data?.items || []).filter((d) => d.myPermissions.includes('history.view'));
  const dev = list.find((d) => d.id === id);

  return (
    <div className="wrap">
      <Head
        title={<>Sleep history{q.data && <TzTag tz={q.data.device.tz} place={q.data.device.place} />}</>}
        sub={`${dev ? dev.name + ' · ' : ''}One card per night. Trends count the main sleep only, not naps.`} />
      {list.length > 1 && (
        <div className="seg" role="tablist">
          {list.map((d) => <button key={d.id} role="tab" aria-selected={d.id === id} className={d.id === id ? 'on' : ''} onClick={() => router.replace(`/history/${d.id}`)}>{d.name}</button>)}
        </div>
      )}
      <Async q={q}>{(r) => {
        const { tz } = r.device;
        const N = r.nights, a = r.averages;
        if (!N.length) return <div className="card empty"><h2>No nights yet</h2><p>The first sleep summary appears the morning after the first night with the sensor.</p></div>;
        // Bars and averages use main sleeps only; nap-only days are listed but not counted (API.md §4).
        const rev = N.filter(isMain).reverse();
        const has = a.nights > 0;
        return <>
          <div className="tiles">
            <div className="card tile"><span className="label">Avg sleep</span><div className="v">{has ? dur(a.totalSleepMin) : '—'}</div></div>
            <div className="card tile"><span className="label">Avg score <PH /></span><div className="v">{has ? <>{a.score}<small>/100</small></> : '—'}</div></div>
            <div className="card tile"><span className="label">Avg heart rate</span><div className="v">{has ? <>{a.hrAvg}<small>bpm</small></> : '—'}</div></div>
            <div className="card tile"><span className="label">Wake-ups / night</span><div className="v">{has ? a.wakeUps.toFixed(1) : '—'}</div></div>
          </div>
          {rev.length > 0 && <div className="card">
            <div className="ch"><div className="t"><h2>Hours asleep</h2><span className="xs muted">Main sleep only · darker bar = last night</span></div></div>
            <div className="chartbox">
              <BarChart vals={rev.map((n) => n.totalSleepMin / 60)} labels={rev.map((n, i) => (i % 2 === rev.length % 2 ? '' : sleepDateLabel(n.sleepDate).split(' ').slice(1).join(' ')))}
                maxV={10} ticks={[0, 2, 4, 6, 8, 10]} fmt={(v) => `${v}h`} col="var(--st-light)" hi={rev.length - 1} />
            </div>
          </div>}
          <div className="card">
            <div className="ch"><h2>Nights</h2><Legend /></div>
            {N.map((n) => !isMain(n) ? (
              // nap-only day: a slim row, no score
              <Link key={n.sleepDate} href={`/history/${id}/${n.sleepDate}`} className="between" style={{ color: 'inherit', textDecoration: 'none', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="small"><b className="nd">{sleepDateLabel(n.sleepDate)}</b> <span className="muted">· No main sleep{n.naps.length ? ` · ${n.naps.map((p) => `nap ${napMin(p)}m`).join(', ')}` : ''}</span></span>
                <Icon name="chev" size={16} />
              </Link>
            ) : (
              <Link key={n.sleepDate} className="night" href={`/history/${id}/${n.sleepDate}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="stack" style={{ gap: 2 }}>
                  <b className="nd">{sleepDateLabel(n.sleepDate)}</b>
                  <span className="xs muted">{timeIn(n.start, tz)} → {timeIn(n.end, tz)}</span>
                  {(n.sessionCount > 1 || n.naps.length > 0) && (
                    <span className="chips">
                      {n.sessionCount > 1 && <span className="pill xs">{n.sessionCount} sessions</span>}
                      {n.naps.map((p) => <span key={p.start} className="pill acc xs">+ nap {napMin(p)}m</span>)}
                    </span>
                  )}
                </div>
                <div className="nt small"><b>{dur(n.totalSleepMin)}</b><span className="muted"> asleep</span></div>
                <div className="nb"><StageBar m={n.stageMin} /></div>
                <ScoreRing v={n.score} />
              </Link>
            ))}
          </div>
        </>;
      }}</Async>
      {devs.error ? <ErrorBox error={devs.error} retry={devs.reload} /> : null}
    </div>
  );
}
