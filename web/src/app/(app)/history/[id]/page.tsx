'use client';

// Sleep history: Week / Month view (18 Nov feedback) — averages for the period,
// sleep score and hours asleep per night, and one clickable row per night
// (API.md 4.1). Times are in the device's time zone.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart } from '@/components/charts';
import { Icon } from '@/components/Icon';
import { Async, ErrorBox, Head, Legend, PH, ScoreRing, StageBar, TzTag, useApi } from '@/components/ui';
import { dur, sleepDateLabel, timeIn } from '@/lib/format';
import { isMain, type DeviceCard, type NightsResponse } from '@/lib/types';

const napMin = (n: { start: string; end: string }) => Math.round((new Date(n.end).getTime() - new Date(n.start).getTime()) / 60000);
const PERIODS = { week: { days: 7, label: 'Week' }, month: { days: 30, label: 'Month' } } as const;
type Period = keyof typeof PERIODS;

export default function HistoryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('week');
  const devs = useApi<{ items: DeviceCard[] }>('/devices');
  // Sleep monitors only: a fall detector's history (its falls) is on its device page.
  const isFall = devs.data?.items.some((d) => d.id === id && d.product === 'fall');
  useEffect(() => { if (isFall) router.replace(`/devices/${id}`); }, [isFall, id, router]);
  const q = useApi<NightsResponse>(!devs.data || isFall ? null : `/devices/${id}/nights?days=${PERIODS[period].days}`);
  const list = (devs.data?.items || []).filter((d) => d.product !== 'fall' && d.myPermissions.includes('history.view'));
  const dev = list.find((d) => d.id === id);

  return (
    <div className="wrap">
      <Head
        title={<>Sleep history{q.data && <TzTag tz={q.data.device.tz} place={q.data.device.place} />}</>}
        sub={`${dev ? dev.name + ' · ' : ''}Tap a night to see its full sleep graph. Averages count the main sleep only, not naps.`} />
      {list.length > 1 && (
        <div className="seg" role="tablist">
          {list.map((d) => <button key={d.id} role="tab" aria-selected={d.id === id} className={d.id === id ? 'on' : ''} onClick={() => router.replace(`/history/${d.id}`)}>{d.name}</button>)}
        </div>
      )}
      <div className="seg" role="tablist" aria-label="Period">
        {(Object.keys(PERIODS) as Period[]).map((p) => (
          <button key={p} role="tab" aria-selected={period === p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
            {PERIODS[p].label} <span className="muted">· last {PERIODS[p].days} days</span>
          </button>
        ))}
      </div>
      <Async q={q}>{(r) => {
        const { tz } = r.device;
        const N = r.nights, a = r.averages;
        if (!N.length) return <div className="card empty"><h2>No nights in the last {PERIODS[period].days} days</h2><p>A night appears here the morning after, once you&apos;ve been out of bed for 5 minutes or pressed End session now.</p></div>;
        // Charts and averages use main sleeps only; nap-only days are listed but not counted (API.md §4).
        const mains = N.filter(isMain);
        const rev = [...mains].reverse();
        const has = a.nights > 0;
        const deepPct = (n: (typeof mains)[number]) => {
          const s = n.stageMin ? n.stageMin.deep + n.stageMin.light : 0;
          return s ? Math.round((n.stageMin!.deep / s) * 100) : null;
        };
        const eff = (n: (typeof mains)[number]) => (n.inBedMin ? Math.round(((n.totalSleepMin ?? 0) / n.inBedMin) * 100) : null);
        const avg = (vals: (number | null)[]) => {
          const v = vals.filter((x): x is number => x != null);
          return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
        };
        const avgDeep = avg(mains.map(deepPct));
        const avgEff = avg(mains.map(eff));
        const every = rev.length > 10 ? Math.ceil(rev.length / 8) : 1;     // keep date labels readable on a month
        const labels = rev.map((n, i) => (i % every === (rev.length - 1) % every ? sleepDateLabel(n.sleepDate).split(' ').slice(1).join(' ') : ''));
        return <>
          <div className="tiles">
            <div className="card tile"><span className="label">Avg sleep score <PH /></span><div className="v">{has ? <>{a.score}<small>/100</small></> : '—'}</div></div>
            <div className="card tile"><span className="label">Avg total sleep</span><div className="v">{has ? dur(a.totalSleepMin) : '—'}</div></div>
            <div className="card tile"><span className="label">Avg deep sleep</span><div className="v">{avgDeep != null ? <>{avgDeep}<small>%</small></> : '—'}</div></div>
            <div className="card tile"><span className="label">Avg efficiency</span><div className="v">{avgEff != null ? <>{avgEff}<small>%</small></> : '—'}</div></div>
          </div>
          {rev.length > 0 && (
            <div className="card">
              <div className="ch"><div className="t"><h2>Hours asleep</h2><span className="xs muted">Deep + light, per night · hover or tap a bar for details</span></div></div>
              <div className="chartbox">
                <BarChart vals={rev.map((n) => (n.totalSleepMin ?? 0) / 60)} labels={labels} maxV={10} ticks={[0, 2, 4, 6, 8, 10]} fmt={(v) => `${v}h`} col="var(--st-light)" hi={rev.length - 1}
                  tip={(i) => {
                    const n = rev[i], m = n.stageMin;
                    return <>
                      <b>{sleepDateLabel(n.sleepDate)}</b>
                      <span className="r"><span>Bed</span><span>{timeIn(n.start, tz)} → {timeIn(n.end, tz)}</span></span>
                      <span className="r"><span>Total sleep</span><span>{dur(n.totalSleepMin)}</span></span>
                      {m && <span className="r"><span>Deep</span><span>{dur(m.deep)}</span></span>}
                      {m && <span className="r"><span>Light</span><span>{dur(m.light)}</span></span>}
                      {m && <span className="r"><span>Awake</span><span>{dur(m.awake)}</span></span>}
                      {eff(n) != null && <span className="r"><span>Efficiency</span><span>{eff(n)}%</span></span>}
                      <span className="r"><span>Score</span><span>{n.score ?? '—'}</span></span>
                    </>;
                  }} />
              </div>
            </div>
          )}
          <div className="card">
            <div className="ch"><h2>Nights</h2><Legend /></div>
            {N.map((n) => !isMain(n) ? (
              // nap-only day: a slim row, no score
              <Link key={n.sleepDate} href={`/history/${id}/${n.sleepDate}`} className="between nrow" style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px solid var(--line)' }}>
                <span className="small"><b className="nd">{sleepDateLabel(n.sleepDate)}</b> <span className="muted">· No main sleep{n.naps.length ? ` · ${n.naps.map((p) => `nap ${napMin(p)}m`).join(', ')}` : ''}</span></span>
                <span className="row xs muted" style={{ gap: 4 }}>View <Icon name="chev" size={16} /></span>
              </Link>
            ) : (
              <Link key={n.sleepDate} className="night" href={`/history/${id}/${n.sleepDate}`} style={{ color: 'inherit', textDecoration: 'none' }} aria-label={`Open the night of ${sleepDateLabel(n.sleepDate)}`}>
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
                <div className="nt small stack" style={{ gap: 2 }}>
                  <span><b>{dur(n.totalSleepMin)}</b><span className="muted"> asleep</span></span>
                  <span className="xs muted">{deepPct(n) != null ? `Deep ${deepPct(n)}%` : ''}{eff(n) != null ? ` · Efficiency ${eff(n)}%` : ''}</span>
                </div>
                <div className="nb"><StageBar m={n.stageMin} /></div>
                <ScoreRing v={n.score} />
                <span className="go"><span>View</span><Icon name="chev" size={18} /></span>
              </Link>
            ))}
          </div>
        </>;
      }}</Async>
      {devs.error ? <ErrorBox error={devs.error} retry={devs.reload} /> : null}
    </div>
  );
}
