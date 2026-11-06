'use client';

// Placement check, used on the live dashboard and in device settings.

import { Icon } from './Icon';
import { useLive } from '@/lib/useLive';

/* Placement check: live:subscribe values scored 25 per passed check. */
export function Placement({ id, online, recal, onRecalibrate }: { id: string; online: boolean; recal?: string; onRecalibrate?: () => void }) {
  const { live, status } = useLive([id], [id]);
  const lv = live[id];
  const on = status[id]?.online ?? online;
  const checks: [string, boolean][] = [
    ['Presence detected', lv?.pr === 1],
    ['Holding still', !!lv && lv.pr === 1 && (lv.mr ?? 0) < 25],
    ['Breathing detected', (lv?.br ?? 0) > 0],
    ['Heart rate locked', (lv?.hr ?? 0) > 0],
  ];
  const score = checks.filter((c) => c[1]).length * 25;
  const msg = !on ? 'The sensor is offline.' : !lv ? 'Waiting for the sensor…' : score === 100 ? 'Perfect spot, sensor fully locked!'
    : score >= 75 ? 'Almost there. Hold still for a few seconds.' : score >= 50 ? 'Getting a signal. Adjust the angle or distance.' : 'Not locked yet. Move the sensor closer, facing the chest.';
  const r = 48, c = 2 * Math.PI * r, col = score === 100 ? 'var(--ok)' : score >= 50 ? 'var(--accent)' : 'var(--warn)';
  const dist = lv?.dist;
  const ideal = dist != null && dist >= 50 && dist <= 80;
  return (
    <div className="stack" style={{ gap: 14, marginTop: 14, padding: 16, borderRadius: 14, background: 'var(--panel-2)' }}>
      <div className="row" style={{ gap: 20 }}>
        <div className="score lg" aria-label={`Signal score ${score}`}>
          <svg viewBox="0 0 112 112"><circle cx="56" cy="56" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
            <circle cx="56" cy="56" r={r} fill="none" stroke={col} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} style={{ transition: 'stroke-dasharray .5s' }} /></svg>
          <b>{score}</b>
        </div>
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 180 }}><span className="label">Signal score</span><h2>{msg}</h2></div>
      </div>
      <div className="vitals">
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Target distance</span><b style={{ color: ideal ? 'var(--ok)' : undefined }}>{dist ? dist : '—'}<span> cm</span></b><span>Ideal: 50–80 cm</span></div>
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Heartbeat</span><b>{lv?.hr || '—'}<span> BPM</span></b></div>
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Respiration</span><b>{lv?.br || '—'}<span> RPM</span></b></div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {checks.map(([l, ok]) => (
          <div key={l} className="row small" style={{ flexWrap: 'nowrap', color: ok ? 'var(--ok)' : 'var(--muted)' }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', background: ok ? 'var(--ok-soft)' : 'var(--panel)', flex: 'none' }}>{ok ? <Icon name="check" size={14} /> : null}</span>
            <span style={{ color: ok ? 'var(--ink)' : undefined }}>{l}</span>
          </div>
        ))}
      </div>
      <p className="hint">Place the sensor ~0.5–0.8 m away, chest facing it. All four green = perfect spot.</p>
      {onRecalibrate && <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={onRecalibrate} disabled={recal === 'running'}><Icon name="activity" /> {recal === 'running' ? 'Recalibrating…' : 'Recalibrate sensor'}</button>}
    </div>
  );
}
