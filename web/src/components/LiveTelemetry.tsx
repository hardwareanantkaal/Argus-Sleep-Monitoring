'use client';

// Live view extras from API.md §11a (firmware 2.0.0+): C1001 composite + diagnostics, and the
// current session + C1001 night stats with a live hypnogram. Live only, never stored.

import { Hypnogram } from './charts';
import { Icon } from './Icon';
import { Legend } from './ui';
import { dur, minutesIn, timeIn, uptime } from '@/lib/format';
import type { LiveValues } from '@/lib/types';

const LEVEL = ['None', 'Low', 'Medium', 'High'];
const RATING = ['—', 'Poor', 'Fair', 'Good'];
const STRUGGLE: [string, string][] = [['None', ''], ['Normal', 'ok'], ['Abnormal', 'bad']];
const STAGE = ['Deep', 'Light', 'Awake', '—'];
export const STAGE_LETTER = ['D', 'L', 'A', 'O'];

const NoSession = () => <div className="note"><Icon name="moon" /><span>No active session. These values appear while someone is in bed.</span></div>;
const m = (v: number | undefined) => (v == null ? '—' : dur(v));

export function CompositeCard({ lv, fw, rssi }: { lv: LiveValues | null; fw?: string | null; rssi?: number | null }) {
  const c = lv?.cmp;
  return (
    <div className="card">
      <div className="ch"><div className="t"><h2>Composite Telemetry &amp; Firmware Diagnostics</h2><span className="xs muted">From the C1001 radar, live only</span></div></div>
      {c ? <div className="g2" style={{ gap: '9px 32px', marginBottom: 14 }}>
        <dl className="kv">
          <dt>Disturbance</dt><dd>{LEVEL[c.dis] ?? c.dis} <span className="muted xs">({c.dis}/3)</span></dd>
          <dt>Struggle</dt><dd>{STRUGGLE[c.abn] ? <span className={`pill ${STRUGGLE[c.abn][1]}`}>{c.abn === 2 && '⚠ '}{STRUGGLE[c.abn][0]}</span> : c.abn}</dd>
          <dt>Quality rating</dt><dd>{RATING[c.rat] ?? c.rat} <span className="muted xs">({c.rat}/3)</span></dd>
          <dt>Breath avg</dt><dd className="num">{c.resp} /min</dd>
          <dt>Heart avg</dt><dd className="num">{c.hr} bpm</dd>
        </dl>
        <dl className="kv">
          <dt>Apnea events</dt><dd className="num">{c.apn}</dd>
          <dt>Turnovers</dt><dd className="num">{c.turn}</dd>
          <dt>Large movement</dt><dd className="num">{c.lg}%</dd>
          <dt>Minor movement</dt><dd className="num">{c.mn}%</dd>
        </dl>
      </div> : <div style={{ marginBottom: 14 }}><NoSession /></div>}
      <div className="divider" style={{ marginBottom: 12 }} />
      <dl className="kv">
        <dt>Node sequence</dt><dd className="num mono">{lv?.seq ?? '—'}</dd>
        <dt>Radar link</dt><dd>{lv?.radar == null ? '—' : lv.radar ? <span className="pill ok">OK</span> : <span className="pill bad">Fault</span>}</dd>
        <dt>Firmware</dt><dd className="mono">{lv?.fw || fw || '—'}</dd>
        <dt>Signal</dt><dd className="num">{lv?.rssi ?? rssi ?? '—'} dBm</dd>
        <dt>Uptime</dt><dd>{uptime(lv?.up)}</dd>
      </dl>
    </div>
  );
}

/** `stages`: one letter per minute the page has been open, built from sess.st. */
export function SessionCard({ lv, tz, stages, firstMin }: { lv: LiveValues | null; tz: string; stages: string; firstMin: number | null }) {
  const s = lv?.sess, n = lv?.ngt;
  return (
    <div className="card">
      <div className="ch"><div className="t"><h2>Nightly Session Telemetry</h2><span className="xs muted">The session running now, plus the radar&apos;s own night statistics</span></div>{s && <Legend />}</div>
      {!s ? <NoSession /> : <>
        <div className="g2" style={{ gap: '9px 32px' }}>
          <dl className="kv">
            <dt>Stage now</dt><dd><b>{STAGE[s.st] ?? '—'}</b></dd>
            <dt>Started</dt><dd className="num">{timeIn(new Date(s.start * 1000).toISOString(), tz)}</dd>
            <dt>In bed</dt><dd className="num">{m(s.bed)}</dd>
            <dt>Asleep</dt><dd className="num">{m(s.slp)}</dd>
            <dt>Deep / light / awake</dt><dd className="num">{s.dp} / {s.lt} / {s.aw} min</dd>
          </dl>
          <dl className="kv">
            <dt>Fell asleep after</dt><dd className="num">{s.on} min</dd>
            <dt>Wake-ups</dt><dd className="num">{s.wk}</dd>
            <dt>Turnovers</dt><dd className="num">{s.tn}</dd>
            <dt>Live score</dt><dd className="num"><b>{s.sc}</b></dd>
          </dl>
        </div>
        {n && <>
          <div className="divider" style={{ marginBlock: 12 }} />
          <span className="label">C1001 night statistics</span>
          <div className="g2" style={{ gap: '9px 32px', marginTop: 8 }}>
            <dl className="kv">
              <dt>Score</dt><dd className="num">{n.sc}</dd>
              <dt>Sleep</dt><dd className="num">{m(n.slp)}</dd>
              <dt>Wake</dt><dd className="num">{n.wk}</dd>
              <dt>Light / deep</dt><dd className="num">{n.sh}% / {n.dp}%</dd>
              <dt>Out of bed</dt><dd className="num">{n.oob} min</dd>
            </dl>
            <dl className="kv">
              <dt>Bed exits</dt><dd className="num">{n.ex}</dd>
              <dt>Turnovers</dt><dd className="num">{n.tn}</dd>
              <dt>Breath avg</dt><dd className="num">{n.resp} /min</dd>
              <dt>Heart avg</dt><dd className="num">{n.hr} bpm</dd>
              <dt>Apnea events</dt><dd className="num">{n.apn}</dd>
            </dl>
          </div>
        </>}
        <div className="divider" style={{ marginBlock: 12 }} />
        <span className="label">Live hypnogram · since this page opened</span>
        {stages.length >= 1 && firstMin != null
          ? <div className="chartbox"><Hypnogram hyp={stages} startMin={firstMin} epochMin={1} label="Live sleep stages" /></div>
          : <p className="small muted" style={{ marginTop: 6 }}>Building… one block per minute.</p>}
      </>}
    </div>
  );
}

/** Add one live message to the per-minute stage string. */
export function pushStage(acc: { first: number | null; mins: string[] }, lv: LiveValues, tz: string) {
  if (!lv.sess) return acc;
  const t = Date.now();
  const min = Math.floor(t / 60000);
  if (acc.first == null) acc.first = min;
  const idx = min - acc.first;
  const letter = lv.bed ? STAGE_LETTER[lv.sess.st] ?? 'O' : 'O';
  while (acc.mins.length < idx) acc.mins.push(acc.mins[acc.mins.length - 1] || 'O'); // fill gaps with last stage
  acc.mins[idx] = letter;
  void tz;
  return acc;
}
export const firstLocalMin = (first: number | null, tz: string) => (first == null ? null : minutesIn(new Date(first * 60000).toISOString(), tz));
