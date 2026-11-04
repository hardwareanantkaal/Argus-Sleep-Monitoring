'use client';

// Night detail (API.md 4.2): the joined hypnogram D/L/A/O with out-of-bed gaps shaded,
// the sessions that were joined, naps shown separately (not counted in totals).

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Hypnogram } from '@/components/charts';
import { Icon } from '@/components/Icon';
import { Async, Head, Legend, Loading, PH, ScoreRing, STAGES, TzTag, useApi } from '@/components/ui';
import { dur, minutesIn, sleepDateLabel, timeIn } from '@/lib/format';
import { isMain, type DeviceDetail, type MainNight, type NightDetail, type NightsResponse } from '@/lib/types';

const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const ZERO = { avg: 0, min: 0, max: 0 };

/** A main night with every detail field filled in, so the screen never trips on a stray null. */
function full(n: MainNight) {
  return {
    ...n, efficiencyPct: n.efficiencyPct ?? 0, wakeUps: n.wakeUps ?? 0, exits: n.exits ?? 0, oobMin: n.oobMin ?? 0,
    sessions: n.sessions ?? [], hyp: n.hyp ?? '', hr: n.hr ?? ZERO, br: n.br ?? ZERO, turns: n.turns ?? 0,
    bigMvPct: n.bigMvPct ?? 0, smallMvPct: n.smallMvPct ?? 0, apnea: n.apnea ?? 0, struggles: n.struggles ?? 0,
  };
}

/** Naps: listed and drawn, never counted in the night's totals or trends. */
function NapCharts({ naps, tz, epochMin }: { naps: NightDetail['naps']; tz: string; epochMin: number }) {
  return <>{naps.filter((p) => p.hyp).map((p) => (
    <div className="card" key={`h${p.start}`}>
      <div className="ch"><div className="t"><h2>Nap · {timeIn(p.start, tz)} → {timeIn(p.end, tz)}</h2><span className="xs muted">{p.totalSleepMin != null ? `${dur(p.totalSleepMin)} asleep · ` : ''}not counted in totals or trends</span></div><Legend /></div>
      <div className="chartbox"><Hypnogram hyp={p.hyp!} startMin={minutesIn(p.start, tz)} epochMin={epochMin} label="Nap sleep stages" /></div>
    </div>
  ))}</>;
}

export default function NightPage() {
  const { id, date } = useParams<{ id: string; date: string }>();
  const q = useApi<NightDetail>(`/devices/${id}/nights/${date}`);
  const list = useApi<NightsResponse>(`/devices/${id}/nights?days=90`);
  const dev = useApi<DeviceDetail>(`/devices/${id}`);
  const tz = list.data?.device.tz || dev.data?.tz;
  const place = list.data?.device.place ?? dev.data?.place ?? null;
  const dates = (list.data?.nights || []).map((n) => n.sleepDate); // newest first
  const i = dates.indexOf(date);
  const earlier = i >= 0 ? dates[i + 1] : undefined;
  const later = i > 0 ? dates[i - 1] : undefined;

  const nav = <>
    {earlier ? <Link className="btn ghost sm" href={`/history/${id}/${earlier}`}><Icon name="back" size={16} /> Earlier</Link> : <button className="btn ghost sm" disabled><Icon name="back" size={16} /> Earlier</button>}
    {later ? <Link className="btn ghost sm" href={`/history/${id}/${later}`}>Later <Icon name="chev" size={16} /></Link> : <button className="btn ghost sm" disabled>Later <Icon name="chev" size={16} /></button>}
  </>;

  return (
    <Async q={q}>{(raw) => {
      if (!tz) return <Loading />;
      const devName = dev.data?.name ? dev.data.name + ' · ' : '';
      if (!isMain(raw)) return (
        // A date with only naps has no main sleep (API.md §4): no score, no totals.
        <div className="wrap">
          <Head title={<>{sleepDateLabel(raw.sleepDate)}<TzTag tz={tz} place={place} /></>} sub={`${devName}naps only`} actions={nav} back={[`/history/${id}`, 'Sleep history']} />
          <div className="card empty"><Icon name="moon" size={30} /><h2>No main sleep this day</h2>
            <p>The sensor only saw {raw.naps.length === 1 ? 'a nap' : `${raw.naps.length} naps`}, none of them long enough to count as a night&apos;s sleep (3 h or more in bed). Naps don&apos;t count in the averages or trends.</p></div>
          <div className="card"><h2 style={{ marginBottom: 14 }}>Naps</h2><div className="stack" style={{ gap: 10 }}>
            {raw.naps.map((p) => (
              <div key={p.start} className="between"><span className="small"><span className="pill acc">Nap</span> <b>{timeIn(p.start, tz)} → {timeIn(p.end, tz)}</b></span>
                <span className="small muted">{mins(p.start, p.end)} min{p.totalSleepMin != null ? ` · ${dur(p.totalSleepMin)} asleep` : ''}</span></div>
            ))}
            {!raw.naps.length && <p className="small muted">Nothing recorded.</p>}
          </div></div>
          <NapCharts naps={raw.naps} tz={tz} epochMin={(raw.epochS || 300) / 60} />
        </div>
      );
      const n = full(raw);
      const total = n.stageMin.deep + n.stageMin.light + n.stageMin.awake + n.stageMin.outOfBed || 1;
      const verdict = n.score >= 80 ? 'A good night' : n.score >= 65 ? 'A fair night' : 'A restless night';
      return (
        <div className="wrap">
          <Head title={<>{sleepDateLabel(n.sleepDate)} night<TzTag tz={tz} place={place} /></>}
            sub={`${devName}${timeIn(n.start, tz)} → ${timeIn(n.end, tz)}`}
            actions={nav} back={[`/history/${id}`, 'Sleep history']} />
          <div className="card"><div className="row" style={{ gap: 24, alignItems: 'center' }}>
            <ScoreRing v={n.score} lg />
            <div className="stack" style={{ gap: 4, flex: 1, minWidth: 200 }}>
              <span className="label">Sleep score <PH /></span>
              <h2 style={{ fontSize: 22 }}>{verdict}</h2>
              <p className="muted small">{dur(n.totalSleepMin)} asleep out of {dur(n.inBedMin)} in bed, woke {n.wakeUps} time{n.wakeUps === 1 ? '' : 's'}{n.exits ? `, got up ${n.exits} time${n.exits === 1 ? '' : 's'}` : ''}.</p>
            </div>
          </div></div>
          <div className="tiles">
            <div className="card tile"><span className="label">Total sleep</span><div className="v">{dur(n.totalSleepMin)}</div></div>
            <div className="card tile"><span className="label">Time in bed</span><div className="v">{dur(n.inBedMin)}</div></div>
            <div className="card tile"><span className="label">Out of bed</span><div className="v">{n.oobMin}<small>min</small></div></div>
            <div className="card tile"><span className="label">Efficiency</span><div className="v">{n.efficiencyPct}<small>%</small></div></div>
          </div>
          <div className="card">
            <div className="ch"><div className="t"><h2>Sleep stages</h2><span className="xs muted">Main sleep, {n.sessions.length} session{n.sessions.length === 1 ? '' : 's'}{n.sessions.length > 1 ? ' joined' : ''} · each block is {n.epochS / 60} minutes</span></div><Legend /></div>
            <div className="chartbox"><Hypnogram hyp={n.hyp} startMin={minutesIn(n.start, tz)} epochMin={n.epochS / 60} /></div>
          </div>
          <div className="g2">
            <div className="card"><h2 style={{ marginBottom: 14 }}>Time in each stage</h2><div className="stagelist">
              {STAGES.map(([k, l, c]) => (
                <div className="r" key={k} style={{ gridTemplateColumns: '84px minmax(0,1fr) 72px' }}>
                  <span>{l}</span><div className="track"><i className={c} style={{ width: `${(n.stageMin[k] / total) * 100}%` }} /></div>
                  <b className="num" style={{ textAlign: 'right' }}>{dur(n.stageMin[k])}</b>
                </div>
              ))}
            </div></div>
            <div className="card"><h2 style={{ marginBottom: 14 }}>Sessions</h2><div className="stack" style={{ gap: 10 }}>
              {n.sessions.map((s, k) => (
                <div key={s.start} className="stack" style={{ gap: 10 }}>
                  {k > 0 && <div className="row xs muted" style={{ paddingLeft: 12 }}><Icon name="person" size={14} /> Out of bed {mins(n.sessions[k - 1].end, s.start)} min · short gap, so it&apos;s the same night</div>}
                  <div className="between"><span className="small"><b>{timeIn(s.start, tz)} → {timeIn(s.end, tz)}</b></span><span className="small muted">{dur(mins(s.start, s.end))}</span></div>
                </div>
              ))}
              {n.naps.length > 0 && <>
                <div className="divider" />
                {n.naps.map((p) => (
                  <div key={p.start} className="between"><span className="small"><span className="pill acc">Nap</span> <b>{timeIn(p.start, tz)} → {timeIn(p.end, tz)}</b></span><span className="small muted">{mins(p.start, p.end)} min</span></div>
                ))}
                <p className="xs muted">Naps are shown here but not counted in the totals or trends.</p>
              </>}
            </div></div>
          </div>
          <NapCharts naps={n.naps} tz={tz} epochMin={n.epochS / 60} />
          <div className="card"><h2 style={{ marginBottom: 14 }}>Body during sleep <PH /></h2><div className="g2" style={{ gap: '9px 32px' }}>
            <dl className="kv">
              <dt>Heart rate avg</dt><dd className="num">{n.hr.avg} bpm</dd>
              <dt>Heart rate min / max</dt><dd className="num">{n.hr.min} / {n.hr.max} bpm</dd>
              <dt>Breath rate avg</dt><dd className="num">{n.br.avg} /min</dd>
              <dt>Breath rate min / max</dt><dd className="num">{n.br.min} / {n.br.max} /min</dd>
              <dt>Apnea events</dt><dd className="num">{n.apnea}</dd>
            </dl>
            <dl className="kv">
              <dt>Turn-overs</dt><dd className="num">{n.turns}</dd>
              <dt>Large / small movement</dt><dd className="num">{n.bigMvPct}% / {n.smallMvPct}%</dd>
              <dt>Bed exits</dt><dd className="num">{n.exits}</dd>
              <dt>Abnormal struggle</dt><dd className="num">{n.struggles}</dd>
            </dl>
          </div></div>
        </div>
      );
    }}</Async>
  );
}
