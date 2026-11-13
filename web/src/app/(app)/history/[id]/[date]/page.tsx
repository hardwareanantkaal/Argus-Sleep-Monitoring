'use client';

// Night detail (API.md 4.2), laid out like the Firebase-era session page: session header with score,
// stat tiles, the stage timeline (step line, hover tooltip, out-of-bed gaps shaded), the sessions that
// were joined, naps shown separately (not counted in totals). Download CSV is built in the browser.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { StageTiles, StageTimeline, stageChanges } from '@/components/StageTimeline';
import { Async, Head, Loading, TzTag, useApi } from '@/components/ui';
import { del, errText } from '@/lib/api';
import { dur, minutesIn, sleepDateLabel, timeIn } from '@/lib/format';
import { isMain, type DeviceDetail, type MainNight, type NightDetail, type NightsResponse } from '@/lib/types';

const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const short = (m: number) => (m < 60 ? `${Math.round(m)}m` : dur(m));
const ZERO = { avg: 0, min: 0, max: 0 };
const STAGE_WORD: Record<string, string> = { D: 'Deep', L: 'Light', A: 'Awake', O: 'Out of bed' };

/** A main night with every detail field filled in, so the screen never trips on a stray null. */
function full(n: MainNight) {
  return {
    ...n, efficiencyPct: n.efficiencyPct ?? 0, wakeUps: n.wakeUps ?? 0, exits: n.exits ?? 0, oobMin: n.oobMin ?? 0,
    sessions: n.sessions ?? [], hyp: n.hyp ?? '', hr: n.hr ?? ZERO, br: n.br ?? ZERO, turns: n.turns ?? 0,
    bigMvPct: n.bigMvPct ?? 0, smallMvPct: n.smallMvPct ?? 0, apnea: n.apnea ?? 0, struggles: n.struggles ?? 0,
  };
}

/** CSV made in the browser. `changes`: one row per stage change (start, end, stage, minutes);
 *  otherwise one row per epoch (local time, UTC time, stage). */
function downloadCsv(hyp: string, startIso: string, epochS: number, tz: string, name: string, changes = true) {
  const t0 = Date.parse(startIso);
  const local = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz, hour12: false });
  const rows: string[] = [];
  if (changes) {
    rows.push('start_local,end_local,stage,minutes');
    for (const c of stageChanges(hyp, epochS / 60)) {
      const s = t0 + c.startMin * 60000;
      rows.push(`${local(s)},${local(s + c.minutes * 60000)},${c.stage},${c.minutes}`);
    }
  } else {
    rows.push('local_time,utc_time,stage,minutes');
    for (let i = 0; i < hyp.length; i++) {
      const ms = t0 + i * epochS * 1000;
      rows.push(`${local(ms)},${new Date(ms).toISOString()},${STAGE_WORD[hyp[i]] || hyp[i]},${epochS / 60}`);
    }
    name += '-per-minute';
  }
  const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name.replace(/[^\w.-]+/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Every stage change with its clock time: "00:05 Light 55 min", "01:00 Deep 40 min" … */
function StageChangeList({ hyp, start, epochMin, tz }: { hyp: string; start: string; epochMin: number; tz: string }) {
  const t0 = Date.parse(start);
  const rows = stageChanges(hyp, epochMin);
  const COLV: Record<string, string> = { D: 'var(--violet)', L: 'var(--cyan)', A: 'var(--amber)', O: 'var(--muted)' };
  return (
    <div className="dcard">
      <div className="dc-h"><span className="dc-t t-violet"><Icon name="moon" size={17} /><span>Stage changes · {rows.length}</span></span><span className="chip">Every change with its time</span></div>
      <div className="tbl" style={{ maxHeight: 360, overflowY: 'auto', margin: 0 }}><table>
        <thead><tr><th>From</th><th>To</th><th>Stage</th><th style={{ textAlign: 'right' }}>Duration</th></tr></thead>
        <tbody>{rows.map((c) => {
          const s = t0 + c.startMin * 60000;
          return (
            <tr key={c.startMin}>
              <td className="num">{timeIn(new Date(s).toISOString(), tz)}</td>
              <td className="num">{timeIn(new Date(s + c.minutes * 60000).toISOString(), tz)}</td>
              <td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: COLV[c.code], marginRight: 8 }} />{c.stage}</td>
              <td className="num" style={{ textAlign: 'right' }}>{short(c.minutes)}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </div>
  );
}

function Tile({ l, v, s }: { l: string; v: React.ReactNode; s?: string }) {
  return <div className="dhero"><span className="lbl">{l}</span><b>{v}</b>{s && <span className="sub">{s}</span>}</div>;
}

/** Naps: listed and drawn, never counted in the night's totals or trends. */
function NapCharts({ naps, tz, epochMin }: { naps: NightDetail['naps']; tz: string; epochMin: number }) {
  return <>{naps.filter((p) => p.hyp).map((p) => (
    <div className="dcard" key={`h${p.start}`}>
      <div className="dc-h"><span className="dc-t t-violet"><Icon name="moon" size={17} /><span>Nap · {timeIn(p.start, tz)} → {timeIn(p.end, tz)}</span></span>
        <span className="chip">{p.totalSleepMin != null ? `${short(p.totalSleepMin)} asleep · ` : ''}not in totals</span></div>
      <StageTimeline hyp={p.hyp!} startMin={minutesIn(p.start, tz)} epochMin={epochMin} startIso={p.start} tz={tz} label="Nap sleep stages" />
    </div>
  ))}</>;
}

export default function NightPage() {
  const { id, date } = useParams<{ id: string; date: string }>();
  const router = useRouter();
  const toast = useToast();
  const [deleting, setDeleting] = useState('');
  const q = useApi<NightDetail>(`/devices/${id}/nights/${date}`);
  const list = useApi<NightsResponse>(`/devices/${id}/nights?days=90`);
  const dev = useApi<DeviceDetail>(`/devices/${id}`);
  const tz = list.data?.device.tz || dev.data?.tz;
  const place = list.data?.device.place ?? dev.data?.place ?? null;
  const dates = (list.data?.nights || []).map((n) => n.sleepDate); // newest first
  const i = dates.indexOf(date);
  const earlier = i >= 0 ? dates[i + 1] : undefined;
  const later = i > 0 ? dates[i - 1] : undefined;
  // Session management: the owner (or, on a vendor sensor in use, someone with settings.edit) may delete
  const dd = dev.data;
  const canDelete = !!dd && (dd.isOwner || (dd.access === 'vendor' && dd.myPermissions.includes('settings.edit')));
  const deleteSession = async (sid: string, label: string, last: boolean) => {
    if (!confirm(`Delete the session ${label}? Its sleep data is removed for good.`)) return;
    setDeleting(sid);
    try {
      await del(`/devices/${id}/sessions/${sid}`);
      toast('Session deleted');
      if (last) router.replace(`/history/${id}`); else { q.reload(); list.reload(); }
    } catch (e) { toast(errText(e)); } finally { setDeleting(''); }
  };

  const nav = <>
    {earlier ? <Link className="btn ghost sm" href={`/history/${id}/${earlier}`}><Icon name="back" size={16} /> Earlier</Link> : <button className="btn ghost sm" disabled><Icon name="back" size={16} /> Earlier</button>}
    {later ? <Link className="btn ghost sm" href={`/history/${id}/${later}`}>Later <Icon name="chev" size={16} /></Link> : <button className="btn ghost sm" disabled>Later <Icon name="chev" size={16} /></button>}
  </>;

  return (
    <Async q={q}>{(raw) => {
      if (!tz) return <Loading />;
      const devName = dev.data?.name || '';
      if (!isMain(raw)) return (
        // A date with only naps has no main sleep (API.md §4): no score, no totals.
        <div className="wrap dash">
          <Head title={<>{sleepDateLabel(raw.sleepDate)}<TzTag tz={tz} place={place} /></>} sub={`${devName ? devName + ' · ' : ''}naps only`} actions={nav} back={[`/history/${id}`, 'Sleep history']} />
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
      const sm = n.stageMin;
      const sleep = sm.deep + sm.light;
      const pct = (v: number) => (sleep ? Math.round((v / sleep) * 100) : 0);
      const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
      const nSess = n.sessions.length;
      const firstSleep = n.hyp.search(/[DL]/);
      const onset = firstSleep < 0 ? null : (firstSleep * n.epochS) / 60;
      return (
        <div className="wrap dash">
          <Head title={<>{devName || 'Sleep history'}<TzTag tz={tz} place={place} /></>} sub={sleepDateLabel(n.sleepDate)}
            actions={nav} back={[`/history/${id}`, 'Sleep history']} />
          <div className="dcard">
            <div className="sess-head">
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 10 }}>
                  <h1>Session: {n.sleepDate}{nSess > 1 ? ` · ${nSess} joined` : ''}</h1>
                  <button className="btn sm tint-emerald" onClick={() => downloadCsv(n.hyp, n.start, n.epochS, tz, `${devName || 'argus'}-${n.sleepDate}`)} title="One row per stage change"><Icon name="upload" size={15} /> Download CSV</button>
                  <button className="btn sm ghost" onClick={() => downloadCsv(n.hyp, n.start, n.epochS, tz, `${devName || 'argus'}-${n.sleepDate}`, false)} title="One row per minute">Per-minute CSV</button>
                  {canDelete && nSess === 1 && n.sessions[0].id && <button className="btn sm tint-rose" disabled={!!deleting}
                    onClick={() => deleteSession(n.sessions[0].id!, `${timeIn(n.sessions[0].start, tz)} → ${timeIn(n.sessions[0].end, tz)}`, n.naps.length === 0)}><Icon name="trash" size={15} /> Delete session</button>}
                </div>
                <span className="tw">Time window: <b>{when(n.start)}</b> to <b>{when(n.end)}</b></span>
              </div>
              <div className="sess-score"><b>{n.score}</b><span>Session score</span></div>
            </div>
          </div>

          <div className="dash-tiles5">
            <Tile l="Asleep time" v={short(n.totalSleepMin)} s={`${n.totalSleepMin} total sleep minutes`} />
            <Tile l="In bed time" v={short(n.inBedMin)} s={`${n.inBedMin} total time in bed`} />
            <Tile l="Deep rest ratio" v={`${pct(sm.deep)}%`} s={`${short(sm.deep)} deep`} />
            <Tile l="Light rest ratio" v={`${pct(sm.light)}%`} s={`${short(sm.light)} light`} />
            <Tile l="Sleep efficiency" v={`${n.efficiencyPct}%`} s="Asleep ÷ time in bed" />
            <Tile l="Sleep onset" v={onset != null ? short(onset) : '—'} s="Time to fall asleep" />
          </div>

          <div className="dpanel"><div className="dash-stats five">
            <Tile l="Awakenings" v={n.wakeUps} s="Woken up count" />
            <Tile l="Turnovers" v={n.turns} s="Body rotation count" />
            <Tile l="Apnea events" v={n.apnea} s="Breathing pause count" />
            <Tile l="Avg heart rate" v={<>{n.hr.avg}<small> BPM</small></>} s={`Range ${n.hr.min}–${n.hr.max}`} />
            <Tile l="Avg respiration" v={<>{n.br.avg}<small> RPM</small></>} s={`Range ${n.br.min}–${n.br.max}`} />
          </div></div>

          <div className="dcard">
            <div className="dc-h"><span className="dc-t t-cyan"><Icon name="activity" size={18} /><span>Sleep Stage Timeline Graph · Session {n.sleepDate}</span></span><span className="chip">Continuous hypnogram</span></div>
            <StageTiles deep={sm.deep} light={sm.light} awake={sm.awake} />
            <StageTimeline hyp={n.hyp} startMin={minutesIn(n.start, tz)} epochMin={n.epochS / 60} startIso={n.start} tz={tz} />
            <span className="xs muted">Each step is {n.epochS / 60} minute{n.epochS === 60 ? '' : 's'}{n.epochS === 60 ? '; 1–2 minute blips are smoothed in the graph only (totals and the list below use every minute)' : ''}{nSess > 1 ? '. Shaded bands are the out-of-bed gaps between joined sessions' : ''}. Hover or touch the graph to see each stage and its time.</span>
          </div>

          {n.hyp && <StageChangeList hyp={n.hyp} start={n.start} epochMin={n.epochS / 60} tz={tz} />}

          <div className="g2">
            <div className="card"><h2 style={{ marginBottom: 14 }}>Out of bed and movement</h2><dl className="kv">
              <dt>Time out of bed</dt><dd className="num">{short(n.oobMin)}</dd>
              <dt>Bed exits</dt><dd className="num">{n.exits}</dd>
              <dt>Large / small movement</dt><dd className="num">{n.bigMvPct}% / {n.smallMvPct}%</dd>
              <dt>Abnormal struggle</dt><dd className="num">{n.struggles}</dd>
            </dl></div>
            <div className="card"><h2 style={{ marginBottom: 14 }}>Sessions</h2><div className="stack" style={{ gap: 10 }}>
              {n.sessions.map((s, k) => (
                <div key={s.start} className="stack" style={{ gap: 10 }}>
                  {k > 0 && <div className="row xs muted" style={{ paddingLeft: 12 }}><Icon name="person" size={14} /> Out of bed {mins(n.sessions[k - 1].end, s.start)} min · short gap, so it&apos;s the same night</div>}
                  <div className="between"><span className="small"><b>{timeIn(s.start, tz)} → {timeIn(s.end, tz)}</b></span>
                    <span className="row" style={{ gap: 10 }}><span className="small muted">{dur(mins(s.start, s.end))}</span>
                      {canDelete && s.id && <button className="btn sm ghost" aria-label="Delete this session" disabled={!!deleting}
                        onClick={() => deleteSession(s.id!, `${timeIn(s.start, tz)} → ${timeIn(s.end, tz)}`, nSess === 1 && n.naps.length === 0)}>
                        <Icon name="trash" size={14} /> {deleting === s.id ? 'Deleting…' : 'Delete'}</button>}</span></div>
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
        </div>
      );
    }}</Async>
  );
}
