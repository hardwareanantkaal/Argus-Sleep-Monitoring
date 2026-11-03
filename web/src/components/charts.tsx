// SVG charts ported from the mockup. No chart library.

import { pad } from '@/lib/format';

const hm = (m: number) => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

/**
 * Hypnogram. `hyp` has one letter per epoch: D deep, L light, A awake, O out of bed (no REM).
 * Out-of-bed time (inside a session, or the gap between joined sessions) is a shaded full-height band.
 * `startMin` is the start as minutes after local midnight in the DEVICE time zone.
 */
export function Hypnogram({ hyp, startMin, epochMin = 5, label = 'Sleep stages through the night' }: { hyp: string; startMin: number; epochMin?: number; label?: string }) {
  const W = 680, H = 180, L = 58, R = 12, T = 10, B = 30, rh = (H - T - B) / 3;
  const ROW: Record<string, number> = { A: 0, L: 1, D: 2 };
  const n = Math.max(1, hyp.length);
  const X = (i: number) => L + ((W - L - R) * i) / n;
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < hyp.length) {
    let j = i;
    while (j < hyp.length && hyp[j] === hyp[i]) j++;
    const st = hyp[i], x = X(i), w = Math.max(1, X(j) - X(i) - 0.6);
    if (st === 'O') {
      blocks.push(<rect key={i} className="fO" x={x.toFixed(1)} y={T} width={w.toFixed(1)} height={H - T - B} rx={2} />);
      if (j - i >= 3) blocks.push(<text key={`t${i}`} x={(X(i) + X(j)) / 2} y={T + 12} textAnchor="middle">out of bed</text>);
    } else if (st in ROW) {
      blocks.push(<rect key={i} className={`f${st}`} x={x.toFixed(1)} y={(T + rh * ROW[st] + rh * 0.2).toFixed(1)} width={w.toFixed(1)} height={(rh * 0.6).toFixed(1)} rx={2} />);
    }
    i = j;
  }
  const end = startMin + n * epochMin;
  const step = n * epochMin > 180 ? 60 : 15;
  const ticks: number[] = [];
  for (let h = Math.ceil(startMin / step) * step; h < end; h += step) ticks.push(h);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {['Awake', 'Light', 'Deep'].map((lab, k) => {
        const y = T + rh * k + rh / 2;
        return <g key={lab}><line className="grid" x1={L} x2={W - R} y1={y} y2={y} strokeDasharray="2 4" /><text x={L - 10} y={y + 4} textAnchor="end">{lab}</text></g>;
      })}
      {blocks}
      {ticks.map((h) => {
        const x = X((h - startMin) / epochMin);
        return <g key={h}><line className="grid" x1={x} x2={x} y1={T} y2={H - B + 4} /><text x={x} y={H - 10} textAnchor="middle">{hm(h)}</text></g>;
      })}
    </svg>
  );
}

export function BarChart({ vals, labels, maxV, ticks, fmt, col, hi }: { vals: number[]; labels: string[]; maxV: number; ticks: number[]; fmt(v: number): string; col: string; hi?: number }) {
  const W = 680, H = 210, L = 40, R = 10, T = 12, B = 30, n = Math.max(1, vals.length), bw = (W - L - R) / n;
  const Y = (v: number) => T + (H - T - B) * (1 - Math.min(v, maxV) / maxV);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((t) => <g key={t}><line className="grid" x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} /><text x={L - 8} y={Y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
      {vals.map((v, i) => {
        const x = L + i * bw + bw * 0.18;
        return (
          <g key={i}>
            <rect x={x.toFixed(1)} y={Y(v).toFixed(1)} width={(bw * 0.64).toFixed(1)} height={(Y(0) - Y(v)).toFixed(1)} rx={3} fill={col} opacity={i === hi ? 1 : 0.55} />
            {labels[i] && <text x={(x + bw * 0.32).toFixed(1)} y={H - 10} textAnchor="middle">{labels[i]}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function Spark({ vals, min, max, col, w = 300, h = 46 }: { vals: number[]; min: number; max: number; col: string; w?: number; h?: number }) {
  if (vals.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;
  const n = vals.length, span = max - min || 1;
  const p = vals.map((v, i) => [(i / (n - 1)) * w, h - 3 - ((Math.max(min, Math.min(max, v)) - min) / span) * (h - 6)]);
  const pts = p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = p[p.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={col} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={col} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={3} fill={col} />
    </svg>
  );
}
