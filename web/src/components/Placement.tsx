'use client';

// Placement check, used on the live dashboard and in device settings.
// Has its own "Recalibrate" button (resets the radar, ~11 s). While it runs
// all four checks are unchecked; afterwards each turns green on its own as
// soon as the live data confirms it, in whatever order the data arrives.

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useToast } from './Providers';
import { errText, post } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useLive } from '@/lib/useLive';

const IDEAL_MIN = 60, IDEAL_MAX = 100;   // cm, chest to sensor

type Recal = '' | 'running' | 'done' | 'failed';

/* Placement check: live:subscribe values scored 25 per passed check. */
export function Placement({ id, online }: { id: string; online: boolean }) {
  const toast = useToast();
  const { live, status } = useLive([id], [id]);
  const lv = live[id];
  const on = status[id]?.online ?? online;
  const [recal, setRecal] = useState<Recal>('');

  const raw: [string, boolean][] = [
    ['Presence detected', lv?.pr === 1],
    ['Holding still', !!lv && lv.pr === 1 && (lv.mr ?? 0) < 25],
    ['Breathing detected', (lv?.br ?? 0) > 0],
    ['Heart rate locked', (lv?.hr ?? 0) > 0],
  ];

  // result of the recalibrate command arrives as command:status
  useEffect(() => {
    const s = getSocket();
    const fn = (m: { deviceId: string; type: string; status: string }) => {
      if (m.deviceId !== id || m.type !== 'recalibrate') return;
      if (m.status === 'done' || m.status === 'acked') { setRecal('done'); toast('Recalibration done. Lie still while the checks turn green.'); }
      else if (m.status === 'failed' || m.status === 'expired') { setRecal('failed'); toast('Recalibration failed'); }
    };
    s.on('command:status', fn);
    return () => { s.off('command:status', fn); };
  }, [id, toast]);

  const recalibrate = async () => {
    if (!confirm('Recalibrate the radar? It resets the sensor for about 11 seconds. Then lie still in your normal sleeping spot.')) return;
    try {
      const r = await post<{ commandId: string; status: 'sent' | 'expired' }>(`/devices/${id}/recalibrate`);
      if (r.status === 'sent') setRecal('running');
      else { setRecal('failed'); toast('The sensor is offline, so it can’t recalibrate now.'); }
    } catch (e) { setRecal(''); toast(errText(e)); }
  };

  const running = recal === 'running';
  // while recalibrating every check is unchecked; after that each one turns
  // green on its own as soon as its data arrives (any order)
  const checks = raw.map(([l, ok]) => [l, !running && ok] as [string, boolean]);
  const score = checks.filter((c) => c[1]).length * 25;
  const msg = !on ? 'The sensor is offline.' : running ? 'Recalibrating the sensor… keep the bed empty.' : !lv ? 'Waiting for the sensor…'
    : score === 100 ? 'Perfect spot, sensor fully locked!'
      : score >= 75 ? 'Almost there. Hold still for a few seconds.' : score >= 50 ? 'Getting a signal. Adjust the angle or distance.' : 'Not locked yet. Move the sensor closer, facing the chest.';
  const r = 48, c = 2 * Math.PI * r, col = score === 100 ? 'var(--ok)' : score >= 50 ? 'var(--accent)' : 'var(--warn)';
  const dist = lv?.dist;
  const ideal = dist != null && dist >= IDEAL_MIN && dist <= IDEAL_MAX;
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
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Target distance</span><b style={{ color: dist ? (ideal ? 'var(--ok)' : 'var(--warn)') : undefined }}>{dist ? dist : '—'}<span> cm</span></b><span>Ideal: {IDEAL_MIN}–{IDEAL_MAX} cm</span></div>
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Heartbeat</span><b>{lv?.hr || '—'}<span> BPM</span></b></div>
        <div className="vital" style={{ background: 'var(--panel)' }}><span>Respiration</span><b>{lv?.br || '—'}<span> RPM</span></b></div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {checks.map(([l, ok]) => (
          <div key={l} className="row small" style={{ flexWrap: 'nowrap', color: ok ? 'var(--ok)' : 'var(--muted)' }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', background: ok ? 'var(--ok-soft)' : 'var(--panel)', flex: 'none', transition: 'background .3s' }}>{ok ? <Icon name="check" size={14} /> : null}</span>
            <span style={{ color: ok ? 'var(--ink)' : undefined }}>{l}</span>
            {!ok && on && lv && <span className="xs muted" style={{ marginLeft: 'auto' }}>{running ? 'waiting for reset…' : 'checking…'}</span>}
          </div>
        ))}
      </div>
      <p className="hint">Place the sensor {IDEAL_MIN}–{IDEAL_MAX} cm from the chest, facing it. Each check turns green as soon as its data arrives; all four green = perfect spot.</p>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn ghost" onClick={recalibrate} disabled={running || !on}><Icon name="activity" /> {running ? 'Recalibrating…' : 'Recalibrate sensor'}</button>
        {recal === 'done' && <span className="pill ok">Recalibrated ✓</span>}
        {recal === 'failed' && <span className="pill bad">Didn’t recalibrate</span>}
      </div>
    </div>
  );
}
