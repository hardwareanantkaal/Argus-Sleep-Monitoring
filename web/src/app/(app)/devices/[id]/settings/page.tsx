'use client';

// Device settings (API.md 3.4–3.10).
// General = backend-only fields (name, room, tz, place, "a new night starts at").
// Sensor = DEVICE-DATA §5 fields, sent to the sensor (retained, versioned; "Saved on device ✓").

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { Async, ErrorBox, Head, Locked, PH, TzSelect, useApi } from '@/components/ui';
import { del, errText, patch, post } from '@/lib/api';
import { placeName, TIMEZONES, uptime } from '@/lib/format';
import { getSocket } from '@/lib/socket';
import { useLive } from '@/lib/useLive';
import type { DeviceDetail, SensorSettings } from '@/lib/types';

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<DeviceDetail>(`/devices/${id}`);
  const d = q.data;
  if (q.error) return <div className="wrap narrow"><ErrorBox error={q.error} retry={q.reload} /></div>;
  const canEdit = !!d?.myPermissions.includes('settings.edit');
  return (
    <div className="wrap narrow">
      <Head title="Device settings" sub={d ? <>{d.name} · <span className="mono">{d.serial}</span></> : undefined} back={[`/devices/${id}`, d?.name || 'Device']} />
      <Async q={q}>{(d) => canEdit ? <>
        <General d={d} onSaved={(x) => q.setData(x)} />
        <Sensor id={d.id} online={d.status.online} />
        <WifiFirmware d={d} onSaved={(x) => q.setData(x)} />
        <Danger d={d} />
      </> : <>
        <Locked msg="Only people with “Change device settings” on this sensor can change its settings." home={`/devices/${id}`} />
        {!d.isOwner && <Danger d={d} />}
      </>}</Async>
    </div>
  );
}

function General({ d, onSaved }: { d: DeviceDetail; onSaved(d: DeviceDetail): void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: d.name, room: d.room || '', tz: d.tz, place: d.place || '', sleepCutoff: d.sleepCutoff || '12:00' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return setErr('Give the sensor a name');
    setErr(''); setBusy(true);
    try {
      onSaved(await patch<DeviceDetail>(`/devices/${d.id}`, { name: f.name.trim(), room: f.room.trim() || null, tz: f.tz, place: f.place.trim() || null, sleepCutoff: f.sleepCutoff }));
      toast('Saved');
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  return (
    <div className="card"><h2 style={{ marginBottom: 14 }}>General</h2>
      <form className="form" onSubmit={save}>
        <div className="fields2">
          <div className="field"><label htmlFor="ds-name">Name</label><input className="inp" id="ds-name" value={f.name} onChange={set('name')} /></div>
          <div className="field"><label htmlFor="ds-room">Room</label><input className="inp" id="ds-room" value={f.room} onChange={set('room')} /></div>
        </div>
        <div className="fields2">
          <div className="field"><label htmlFor="ds-tz">Time zone</label><TzSelect id="ds-tz" value={f.tz} onChange={(tz) => setF({ ...f, tz })} options={TIMEZONES} /><span className="hint">All times for this sensor are shown in this zone. A change applies to new nights only.</span></div>
          <div className="field"><label htmlFor="ds-place">Town or city (optional)</label><input className="inp" id="ds-place" value={f.place} onChange={set('place')} placeholder="Surat" /><span className="hint">Used in labels like “{f.place.trim() || 'Surat'} time”. If empty, the time zone is used (“{placeName(f.tz, null)} time”).</span></div>
        </div>
        <div className="field"><label htmlFor="ds-cut">A new night starts at</label><input className="inp" type="time" id="ds-cut" value={f.sleepCutoff} onChange={set('sleepCutoff')} style={{ maxWidth: 160 }} /><span className="hint">Sleep before this time counts toward the night before. Noon (12:00) suits most people; change it for night-shift workers.</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" type="submit" style={{ alignSelf: 'flex-start' }} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  );
}

const SYNC: Record<SensorSettings['sync'], [string, string]> = {
  applied: ['Saved on device ✓', 'ok'],
  sending: ['Sending to the sensor…', 'acc'],
  queued_offline: ['Waiting: sensor offline, sent when it reconnects', 'warn'],
};

function Sensor({ id, online }: { id: string; online: boolean }) {
  const toast = useToast();
  const q = useApi<SensorSettings>(`/devices/${id}/sensor-settings`);
  const [f, setF] = useState<SensorSettings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setSensor = q.setData;
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);

  // "Saved on device ✓" arrives over Socket.IO when the sensor acks (settings:sync)
  useEffect(() => {
    const s = getSocket();
    const fn = (m: { deviceId: string; version: number; appliedVersion: number; sync: SensorSettings['sync'] }) => {
      if (m.deviceId === id) setSensor((x) => (x ? { ...x, version: m.version, appliedVersion: m.appliedVersion, sync: m.sync } : x));
    };
    s.on('settings:sync', fn);
    s.emit('devices:subscribe', { deviceIds: [id] }, () => {});
    return () => s.off('settings:sync', fn);
  }, [id, setSensor]);

  if (q.error) return <ErrorBox error={q.error} retry={q.reload} />;
  if (!f || !q.data) return <div className="card"><h2>Sensor</h2></div>;
  const num = (k: 'exitS' | 'liveS' | 'idleS' | 'unattMin') => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const exitMin = Math.round(f.exitS / 60 * 10) / 10;
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const { exitS, liveS, idleS, struggle, unattended, unattMin } = f;
      const r = await patch<{ settings: SensorSettings }>(`/devices/${id}/sensor-settings`, { exitS, liveS, idleS, struggle, unattended, unattMin });
      q.setData(r.settings);
      toast(online ? 'Sent to the sensor' : 'Saved. The sensor gets it when it reconnects.');
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const sync = SYNC[q.data.sync];
  return (
    <div className="card">
      <div className="ch"><div className="t"><h2>Sensor</h2><span className="xs muted">Sent to the sensor and kept there</span></div><span className={`pill ${sync[1]}`}>{sync[0]}</span></div>
      <div className="form">
        <div className="field"><label htmlFor="ss-exit">Bed-exit timeout</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp num" id="ss-exit" type="number" min={30} max={3600} step={30} value={f.exitS} onChange={num('exitS')} style={{ maxWidth: 120 }} /><span className="muted small">seconds ({exitMin} min)</span></div>
          <span className="hint">Getting up for less than this keeps the same session going. 30–3600 s, default 300 (5 min).</span></div>
        <div className="fields2">
          <div className="field"><label htmlFor="ss-live">Live rate while in bed</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}><span className="muted small">every</span><input className="inp num" id="ss-live" type="number" min={1} max={60} value={f.liveS} onChange={num('liveS')} style={{ maxWidth: 90 }} /><span className="muted small">s</span></div>
            <span className="hint">Default 5 s.</span></div>
          <div className="field"><label htmlFor="ss-idle">Live rate while the bed is empty</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}><span className="muted small">every</span><input className="inp num" id="ss-idle" type="number" min={10} max={600} value={f.idleS} onChange={num('idleS')} style={{ maxWidth: 90 }} /><span className="muted small">s</span></div>
            <span className="hint">Default 60 s.</span></div>
        </div>
        <div>
          <label className="tog"><span className="t"><span>Abnormal struggle detection</span><span className="xs muted">The radar flags unusual struggling movement in bed</span></span>
            <input type="checkbox" className="sw" checked={f.struggle} onChange={(e) => setF({ ...f, struggle: e.target.checked })} /></label>
          <label className="tog"><span className="t"><span>Unattended detection</span><span className="xs muted">The radar flags when nobody has been seen for a while</span></span>
            <input type="checkbox" className="sw" checked={f.unattended} onChange={(e) => setF({ ...f, unattended: e.target.checked })} /></label>
        </div>
        <div className="field"><label htmlFor="ss-unatt">Unattended after <PH /></label>
          <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp num" id="ss-unatt" type="number" min={1} value={f.unattMin} disabled={!f.unattended} onChange={num('unattMin')} style={{ maxWidth: 100 }} /><span className="muted small">minutes</span></div>
          <span className="hint">Default 30 min. The range is still to be checked on the Sensor.</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save sensor settings'}</button>
      </div>
    </div>
  );
}

function WifiFirmware({ d, onSaved }: { d: DeviceDetail; onSaved(d: DeviceDetail): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [recal, setRecal] = useState<'' | 'running' | 'done' | 'failed'>('');
  const [placing, setPlacing] = useState(false);
  const c = d.connection;
  // result of the recalibrate command arrives as command:status
  useEffect(() => {
    const s = getSocket();
    const fn = (m: { deviceId: string; type: string; status: string }) => {
      if (m.deviceId !== d.id || m.type !== 'recalibrate') return;
      if (m.status === 'done' || m.status === 'acked') { setRecal('done'); toast('Recalibration done'); }
      else if (m.status === 'failed' || m.status === 'expired') { setRecal('failed'); toast('Recalibration failed'); }
    };
    s.on('command:status', fn);
    return () => s.off('command:status', fn);
  }, [d.id, toast]);
  const recalibrate = async () => {
    if (!confirm('Recalibrate the radar? It restarts the radar for about 11 seconds. Do it with nobody in bed.')) return;
    try {
      // PROPOSED route, not yet in API.md (same pattern as wifi-setup)
      const r = await post<{ commandId: string; status: 'sent' | 'expired' }>(`/devices/${d.id}/recalibrate`);
      if (r.status === 'sent') setRecal('running');
      else { setRecal('failed'); toast('The sensor is offline, so it can’t recalibrate now.'); }
    } catch (e) { setRecal(''); toast(errText(e)); }
  };
  const setAuto = async (v: boolean) => {
    try { onSaved(await patch<DeviceDetail>(`/devices/${d.id}`, { autoUpdate: v })); toast(v ? 'Updates will install automatically' : 'Automatic updates off'); }
    catch (e) { toast(errText(e)); }
  };
  const wifi = async () => {
    if (!confirm('Put the sensor into Wi-Fi setup mode? It goes offline until you connect it to a network.')) return;
    setBusy(true);
    try {
      const r = await post<{ commandId: string; status: 'sent' | 'expired' }>(`/devices/${d.id}/wifi-setup`);
      toast(r.status === 'sent' ? 'Sensor is now in Wi-Fi setup mode. Connect your phone to its setup network.' : 'The sensor is offline, so it can’t be switched. Hold its button 5 times to open setup.');
    } catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card"><h2 style={{ marginBottom: 12 }}>Wi-Fi and firmware</h2>
      <dl className="kv">
        <dt>Wi-Fi network</dt><dd>{c?.wifiSsid || '—'}</dd>
        <dt>Signal</dt><dd className="num">{c?.rssi != null ? `${c.rssi} dBm` : '—'}</dd>
        <dt>Firmware</dt><dd className="mono">{c?.fw || '—'}</dd>
        <dt>Running for</dt><dd className="num">{uptime(c?.uptimeS)}</dd>
        <dt>Model</dt><dd>{d.hwModel}</dd>
      </dl>
      <div className="divider" style={{ marginBlock: 12 }} />
      <label className="tog"><span className="t"><span>Install updates automatically</span><span className="xs muted">Updates install during the day, never at night</span></span>
        <input type="checkbox" className="sw" checked={d.autoUpdate} onChange={(e) => setAuto(e.target.checked)} /></label>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={wifi} disabled={busy}><Icon name="wifi" /> Change Wi-Fi network</button>
        <button className="btn ghost" onClick={() => setPlacing(!placing)} aria-expanded={placing}><Icon name="person" /> Placement check</button>
        <button className="btn ghost" onClick={recalibrate} disabled={recal === 'running'}><Icon name="activity" /> {recal === 'running' ? 'Recalibrating…' : 'Recalibrate sensor'}</button>
        {recal === 'done' && <span className="pill ok">Recalibrated ✓</span>}
        {recal === 'failed' && <span className="pill bad">Didn’t recalibrate</span>}
      </div>
      {placing && <Placement id={d.id} online={d.status.online} recal={recal} onRecalibrate={recalibrate} />}
    </div>
  );
}

function Danger({ d }: { d: DeviceDetail }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  // Vendor devices (API.md §15.6): no "Remove device"; the team can't leave; a grant holder may leave (ends the access).
  if (d.access === 'vendor') return null;
  if (d.access === 'grant') return (
    <div className="card"><h2 style={{ marginBottom: 6 }}>Leave this device</h2>
      <p className="small muted" style={{ marginBottom: 12 }}>{d.vendor?.name || 'The vendor'} gave you access{d.accessEndsAt ? ` until ${new Date(d.accessEndsAt).toLocaleString()}` : ''}. If you leave, your access ends now.</p>
      <button className="btn danger" onClick={async () => {
        if (!confirm(`Leave ${d.name}? Your access ends now.`)) return;
        try { await del(`/devices/${d.id}/me`); toast('You left the device'); router.replace('/devices'); } catch (e) { toast(errText(e)); }
      }}>Leave {d.name}</button>
    </div>
  );
  if (!d.isOwner) return (
    <div className="card"><h2 style={{ marginBottom: 6 }}>Leave this device</h2>
      <p className="small muted" style={{ marginBottom: 12 }}>{d.sharedBy?.fullName || 'The owner'} shared it with you. If you leave, you need a new invite to see it again.</p>
      <button className="btn danger" onClick={async () => {
        if (!confirm(`Leave ${d.name}?`)) return;
        try { await del(`/devices/${d.id}/me`); toast('You left the device'); router.replace('/devices'); } catch (e) { toast(errText(e)); }
      }}>Leave {d.name}</button>
    </div>
  );
  return (
    <div className="card"><h2 style={{ marginBottom: 6 }}>Remove device</h2>
      <p className="small muted" style={{ marginBottom: 12 }}>Removes it from your account and from everyone you shared it with. <b>Sleep history is deleted.</b> To add it again you need a new claim code from support.</p>
      {!open ? <button className="btn danger" onClick={() => setOpen(true)}>Remove {d.name}</button> : (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          try { await del(`/devices/${d.id}`, { confirmName: name }); toast(`${d.name} removed`); router.replace('/devices'); } catch (e2) { setErr(errText(e2)); }
        }}>
          <div className="field"><label htmlFor="rm-name">Type <b>{d.name}</b> to confirm</label><input className="inp" id="rm-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></div>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="row"><button className="btn danger solid" type="submit" disabled={name.trim() !== d.name}>Remove for good</button><button className="btn ghost" type="button" onClick={() => { setOpen(false); setName(''); }}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

/* Placement check: live:subscribe values scored 25 per passed check. */
function Placement({ id, online, recal, onRecalibrate }: { id: string; online: boolean; recal: string; onRecalibrate(): void }) {
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
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={onRecalibrate} disabled={recal === 'running'}><Icon name="activity" /> {recal === 'running' ? 'Recalibrating…' : 'Recalibrate sensor'}</button>
    </div>
  );
}
