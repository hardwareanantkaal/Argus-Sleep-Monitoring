'use client';

// Sleep stage timeline, in the style of the Firebase-era dashboard: a step line Awake / Light / Deep
// coloured by stage, a soft area under it, out-of-bed time as a shaded band, and a hover/touch
// tooltip with the stage and its time range. No REM on the C1001.
// `hyp`: one letter per epoch (D deep, L light, A awake, O out of bed).
// `startMin`: start as minutes after local midnight in the DEVICE time zone.

import { useEffect, useRef, useState } from 'react';
import { dur as longDur, pad } from '@/lib/format';

const dur = (m: number) => (m < 60 ? `${Math.round(m)}m` : longDur(m));

const hm = (m: number) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

const H = 230, L = 74, R = 22, T = 26, B = 36;
const ROW_Y: Record<string, number> = { A: T + 18, L: T + 78, D: T + 138 };
const BASE = T + 160; // bottom of the plot
const COL: Record<string, string> = { A: 'var(--amber)', L: 'var(--cyan)', D: 'var(--violet)', O: 'var(--muted)' };
const NAME: Record<string, string> = { A: 'Awake', L: 'Light', D: 'Deep', O: 'Out of bed' };

interface Run { st: string; i: number; j: number }

function runsOf(hyp: string): Run[] {
  const out: Run[] = [];
  let i = 0;
  while (i < hyp.length) {
    let j = i;
    while (j < hyp.length && hyp[j] === hyp[i]) j++;
    out.push({ st: hyp[i] in NAME ? hyp[i] : 'O', i, j });
    i = j;
  }
  return out;
}

/** Display smoothing for 1-minute data: a blip shorter than `maxMin` minutes
 *  between two stretches of the SAME stage takes that stage (L L A L L -> L L L L L).
 *  Drawing only; totals always come from the stored data. Out of bed is never changed. */
export function smoothHyp(hyp: string, epochMin: number, maxMin = 2): string {
  const maxN = Math.floor(maxMin / epochMin);
  if (maxN < 1) return hyp;
  const r = runsOf(hyp);
  for (let k = 1; k < r.length - 1; k++) {
    const a = r[k - 1], b = r[k], c = r[k + 1];
    if (b.st !== 'O' && a.st === c.st && a.st !== 'O' && b.j - b.i <= maxN) b.st = a.st;
  }
  return r.map((x) => x.st.repeat(x.j - x.i)).join('');
}

/** The stage changes of a hypnogram: one row per stretch (stage, start offset, minutes). */
export function stageChanges(hyp: string, epochMin: number) {
  return runsOf(hyp).map((r) => ({ stage: NAME[r.st], code: r.st, startMin: r.i * epochMin, minutes: (r.j - r.i) * epochMin }));
}

export function StageTimeline({ hyp: rawHyp, startMin, epochMin = 5, startIso, tz, label = 'Sleep stages through the session', smooth = true }: { hyp: string; startMin: number; epochMin?: number; startIso?: string; tz?: string; label?: string; smooth?: boolean }) {
  const hyp = smooth ? smoothHyp(rawHyp, epochMin) : rawHyp;
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);
  // Draw at the real pixel width (1 unit = 1 px), so labels stay readable on a phone
  const [W, setW] = useState(880);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = Math.max(1, hyp.length);
  const X = (i: number) => L + ((W - L - R) * i) / n;
  const runs = runsOf(hyp);
  const span = n * epochMin;

  // Step line, one path per stretch in bed (out-of-bed breaks the line)
  const paths: { d: string; area: string }[] = [];
  let cur: Run[] = [];
  const flush = () => {
    if (!cur.length) return;
    let d = `M ${X(cur[0].i).toFixed(1)} ${ROW_Y[cur[0].st]}`;
    for (let k = 0; k < cur.length; k++) {
      if (k > 0) d += ` V ${ROW_Y[cur[k].st]}`;
      d += ` H ${X(cur[k].j).toFixed(1)}`;
    }
    const area = `${d} V ${BASE} H ${X(cur[0].i).toFixed(1)} Z`;
    paths.push({ d, area });
    cur = [];
  };
  for (const r of runs) { if (r.st === 'O') flush(); else cur.push(r); }
  flush();

  // Time labels at the STAGE CHANGES (like the old dashboard: 12:32, 13:03, 13:40 …),
  // skipping any that would sit closer than 46 px to the previous label, plus the end.
  const perMin = (W - L - R) / span;
  const ticks: number[] = [];
  const addTick = (m: number) => { if (!ticks.length || (m - ticks[ticks.length - 1]) * perMin >= 46) ticks.push(m); };
  for (const r of runs) addTick(startMin + r.i * epochMin);
  const endM = startMin + span;
  if (ticks.length && (endM - ticks[ticks.length - 1]) * perMin >= 46) ticks.push(endM);

  const run = hover ? runs.find((r) => hover.idx >= r.i && hover.idx < r.j) : null;
  const onMove = (e: React.PointerEvent) => {
    const el = box.current?.querySelector('svg');
    if (!el) return;
    const rc = el.getBoundingClientRect();
    const sx = ((e.clientX - rc.left) / rc.width) * W;
    if (sx < L || sx > W - R) { setHover(null); return; }
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((sx - L) / (W - L - R)) * n)));
    setHover({ x: sx, idx });
  };
  const tipLeft = hover ? Math.min(Math.max(hover.x, 110), W - 110) : 0;

  return (
    <div className="stl" ref={box} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <defs>
          <linearGradient id="stlArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {(['A', 'L', 'D'] as const).map((s) => (
          <g key={s}>
            <line className="stl-grid" x1={L} x2={W - R} y1={ROW_Y[s]} y2={ROW_Y[s]} />
            <text x={L - 14} y={ROW_Y[s] + 5} textAnchor="end" className="stl-row" style={{ fill: COL[s] }}>{NAME[s]}</text>
          </g>
        ))}
        {runs.filter((r) => r.st === 'O').map((r) => (
          <g key={`o${r.i}`}>
            <rect className="stl-oob" x={X(r.i)} y={T} width={Math.max(1, X(r.j) - X(r.i))} height={BASE - T} rx={4} />
            {X(r.j) - X(r.i) > 64 && <text x={(X(r.i) + X(r.j)) / 2} y={T + 14} textAnchor="middle">out of bed</text>}
          </g>
        ))}
        {paths.map((p, k) => <path key={`a${k}`} d={p.area} fill="url(#stlArea)" />)}
        {paths.map((p, k) => <path key={`c${k}`} d={p.d} fill="none" stroke="var(--line)" strokeWidth={1.5} />)}
        {runs.filter((r) => r.st !== 'O').map((r) => (
          <line key={`s${r.i}`} x1={X(r.i)} x2={X(r.j)} y1={ROW_Y[r.st]} y2={ROW_Y[r.st]} stroke={COL[r.st]} strokeWidth={3.5} strokeLinecap="round" />
        ))}
        {/* a dot at every stage change (and the end), unless dots would overlap */}
        {runs.filter((r, k) => r.st !== 'O' && (k === 0 || X(r.i) - X(runs[k - 1].i) >= 7)).map((r) => (
          <circle key={`m${r.i}`} cx={X(r.i)} cy={ROW_Y[r.st]} r={4} fill={COL[r.st]} stroke="var(--panel)" strokeWidth={1.5} />
        ))}
        {runs.length > 0 && runs[runs.length - 1].st !== 'O' && (
          <circle cx={X(n)} cy={ROW_Y[runs[runs.length - 1].st]} r={4} fill={COL[runs[runs.length - 1].st]} stroke="var(--panel)" strokeWidth={1.5} />
        )}
        {ticks.map((m) => {
          const x = L + ((W - L - R) * (m - startMin)) / span;
          return <g key={m}><line className="stl-grid" x1={x} x2={x} y1={BASE} y2={BASE + 5} /><text x={x} y={H - 10} textAnchor="middle" className="stl-tick">{hm(m)}</text></g>;
        })}
        {hover && run && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={T} y2={BASE} stroke="var(--muted)" strokeDasharray="3 3" />
            {run.st !== 'O' && <circle cx={hover.x} cy={ROW_Y[run.st]} r={6} fill="var(--panel)" stroke={COL[run.st]} strokeWidth={3} />}
          </g>
        )}
      </svg>
      {hover && run && (
        <div className="stl-tip" style={{ left: tipLeft }}>
          <span className="stl-tip-t">{startIso && tz
            ? new Date(Date.parse(startIso) + hover.idx * epochMin * 60000).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')
            : hm(startMin + hover.idx * epochMin)}</span>
          <b><i style={{ background: COL[run.st] }} />{NAME[run.st]} · {hm(startMin + run.i * epochMin)}–{hm(startMin + run.j * epochMin)}</b>
          <span className="stl-tip-t">{dur((run.j - run.i) * epochMin)}</span>
        </div>
      )}
    </div>
  );
}

/** Minutes per stage from a hypnogram string. */
export function stageTotals(hyp: string, epochMin: number) {
  const c = { D: 0, L: 0, A: 0, O: 0 } as Record<string, number>;
  for (const ch of hyp) c[ch in c ? ch : 'O']++;
  return { deep: c.D * epochMin, light: c.L * epochMin, awake: c.A * epochMin, outOfBed: c.O * epochMin };
}

/** The four coloured tiles above the timeline: total sleep, deep, light, awake. */
export function StageTiles({ deep, light, awake }: { deep: number; light: number; awake: number }) {
  const sleep = deep + light;
  const inBed = sleep + awake;
  const pct = (v: number, of: number) => (of ? Math.round((v / of) * 100) : 0);
  return (
    <div className="stiles">
      <div className="stile2 emerald"><span>Total sleep time</span><b>{dur(sleep)}<small> ({pct(sleep, inBed)}%)</small></b><em>{sleep} min · light + deep</em></div>
      <div className="stile2 violet"><span>Deep sleep</span><b>{dur(deep)}<small> ({pct(deep, sleep)}%)</small></b><em>{deep} min · restorative stage</em></div>
      <div className="stile2 cyan"><span>Light sleep</span><b>{dur(light)}<small> ({pct(light, sleep)}%)</small></b><em>{light} min · shallow rest</em></div>
      <div className="stile2 amber"><span>Awake in bed</span><b>{dur(awake)}<small> ({pct(awake, inBed)}%)</small></b><em>{awake} min · awakenings in bed</em></div>
    </div>
  );
}
