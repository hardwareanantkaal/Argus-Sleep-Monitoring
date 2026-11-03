'use client';

// Firmware & OTA (API.md 9.1–9.8). Upload .bin (firmware.upload), start / pause / resume / cancel / retry
// rollouts (firmware.rollout), live progress from Socket.IO rollout:progress.

import { useState } from 'react';
import { useAdminSocket } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { del, errText, post } from '@/lib/api';
import { ago, bytes, day } from '@/lib/format';
import type { FirmwareRelease, Rollout } from '@/lib/types';

const MAX = 4 * 1024 * 1024;

export default function FirmwarePage() {
  return <RequireStaff perm="firmware.view"><Inner /></RequireStaff>;
}

function Inner() {
  const { can } = useAuth();
  const toast = useToast();
  const rel = useApi<{ items: FirmwareRelease[] }>('/admin/firmware');
  const ro = useApi<{ items: Rollout[] }>('/admin/ota/rollouts');
  const [newRollout, setNewRollout] = useState(false);
  const canRoll = can('firmware.rollout');

  useAdminSocket(['rollouts'], {
    'rollout:progress': (m: { rolloutId: string; counts: Rollout['counts']; status?: Rollout['status'] }) =>
      ro.setData((x) => x && { items: x.items.map((r) => (r.id === m.rolloutId ? { ...r, counts: m.counts, status: m.status || r.status } : r)) }),
  });

  const act = async (r: Rollout, a: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (a === 'cancel' && !confirm(`Cancel the ${r.version} rollout? Devices still waiting are skipped; updated ones keep the new version.`)) return;
    try { await post(`/admin/ota/rollouts/${r.id}/${a}`); toast({ pause: 'Rollout paused', resume: 'Rollout resumed', cancel: 'Rollout cancelled', retry: 'Retrying failed devices' }[a]); ro.reload(); }
    catch (e) { toast(errText(e)); }
  };

  return (
    <div className="wrap">
      <Head title="Firmware and OTA" sub="Upload builds, then roll them out to devices over the air"
        actions={canRoll && <button className="btn" onClick={() => setNewRollout(!newRollout)}><Icon name="upload" /> New rollout</button>} />
      {newRollout && rel.data && <NewRollout releases={rel.data.items} onDone={() => { setNewRollout(false); ro.reload(); }} onCancel={() => setNewRollout(false)} />}

      <div className="card"><div className="ch"><h2>Rollouts</h2></div>
        <Async q={ro}>{(d) => d.items.length ? (
          <div className="stack" style={{ gap: 18 }}>
            {d.items.map((r, i) => {
              const c = r.counts, tot = c.done + c.downloading + c.waiting + c.failed || 1;
              return (
                <div key={r.id} className="stack" style={{ gap: 8 }}>
                  {i > 0 && <div className="divider" style={{ marginBottom: 10 }} />}
                  <div className="between" style={{ alignItems: 'flex-start' }}>
                    <div className="stack" style={{ gap: 2 }}><b><span className="mono">{r.version}</span> → {r.target}</b><span className="xs muted">{r.id} · started {ago(r.createdAt).toLowerCase()} by {r.createdBy}</span></div>
                    {r.status === 'running' ? <span className="pill live"><span className="dot pulse" />Running</span>
                      : r.status === 'paused' ? <span className="pill warn">Paused</span>
                        : r.status === 'cancelled' ? <span className="pill bad">Cancelled</span> : <span className="pill">Finished</span>}
                  </div>
                  <div className="progress" aria-label={`${c.done} of ${tot} updated`}>
                    <i style={{ width: `${(c.done / tot) * 100}%`, background: 'var(--ok)' }} />
                    <i style={{ width: `${(c.downloading / tot) * 100}%`, background: 'var(--accent)' }} />
                    <i style={{ width: `${(c.failed / tot) * 100}%`, background: 'var(--bad)' }} />
                  </div>
                  <div className="legend">
                    <span><i style={{ background: 'var(--ok)' }} />Updated {c.done}</span>
                    <span><i style={{ background: 'var(--accent)' }} />Downloading {c.downloading}</span>
                    <span><i style={{ background: 'var(--panel-2)', border: '1px solid var(--line)' }} />Waiting {c.waiting}</span>
                    <span><i style={{ background: 'var(--bad)' }} />Failed {c.failed}</span>
                    {canRoll && <><span className="sp" style={{ flex: 1 }} />
                      {r.status === 'running' && <button className="btn ghost sm" onClick={() => act(r, 'pause')}>Pause</button>}
                      {r.status === 'paused' && <button className="btn ghost sm" onClick={() => act(r, 'resume')}>Resume</button>}
                      {c.failed > 0 && r.status !== 'cancelled' && <button className="btn ghost sm" onClick={() => act(r, 'retry')}>Retry failed</button>}
                      {(r.status === 'running' || r.status === 'paused') && <button className="btn danger sm" onClick={() => act(r, 'cancel')}>Cancel</button>}
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <p className="small muted">No rollouts yet.</p>}</Async>
      </div>

      <div className="g21">
        <div className="card"><h2 style={{ marginBottom: 12 }}>Versions</h2>
          <Async q={rel}>{(d) => (
            <div className="tbl"><table>
              <thead><tr><th>Version</th><th>Channel</th><th>Chip</th><th>Uploaded</th><th>Size</th><th>On devices</th><th>sha256</th><th>Notes</th>{can('firmware.upload') && <th />}</tr></thead>
              <tbody>{d.items.map((f) => (
                <tr key={f.id}>
                  <td className="mono"><b>{f.version}</b></td>
                  <td>{f.channel === 'beta' ? <span className="pill warn">beta</span> : <span className="pill ok">stable</span>}</td>
                  <td className="mono">{f.chipModel}</td>
                  <td className="muted">{day(f.createdAt)} · {f.uploadedBy}</td>
                  <td>{bytes(f.fileSize)}</td><td className="num">{f.deviceCount}</td>
                  <td className="mono xs muted" title={f.sha256}>{f.sha256.slice(0, 12)}</td>
                  <td className="muted" style={{ whiteSpace: 'normal', minWidth: 200 }}>{f.notes}</td>
                  {can('firmware.upload') && <td><button className="btn danger sm" onClick={async () => {
                    if (!confirm(`Delete firmware ${f.version}?`)) return;
                    try { await del(`/admin/firmware/${f.id}`); toast('Deleted'); rel.reload(); } catch (e) { toast(errText(e)); }
                  }}>Delete</button></td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}</Async>
        </div>
        <Upload onDone={() => rel.reload()} />
      </div>
    </div>
  );
}

function Upload({ onDone }: { onDone(): void }) {
  const { can } = useAuth();
  const toast = useToast();
  const up = can('firmware.upload');
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState('beta');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!file) return setErr('Choose a .bin file');
    if (file.size > MAX) return setErr(`The file is ${bytes(file.size)}; the limit is 4 MB.`);
    // An ESP app image always starts with the magic byte 0xE9 (the server checks this too).
    const first = new Uint8Array(await file.slice(0, 1).arrayBuffer())[0];
    if (first !== 0xe9) return setErr('This is not an ESP32 app image (it should start with byte 0xE9). Upload the app .bin, not the merged or bootloader file.');
    if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version.trim())) return setErr('Enter a version like 1.4.4 or 1.4.4-beta');
    const fd = new FormData();
    fd.append('file', file); fd.append('version', version.trim()); fd.append('channel', channel); fd.append('notes', notes.trim());
    setBusy(true);
    try { await post('/admin/firmware', fd); toast(`Uploaded ${version.trim()}`); setFile(null); setVersion(''); setNotes(''); setKey((k) => k + 1); onDone(); }
    catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };

  return (
    <div className="card"><h2 style={{ marginBottom: 14 }}>Upload a build</h2>
      <form className="form" onSubmit={submit}>
        <div className="field"><label htmlFor="fw-file">Firmware file (.bin, max 4 MB)</label><input key={key} className="inp" type="file" id="fw-file" accept=".bin,application/octet-stream" disabled={!up} onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {file && <span className="hint">{file.name} · {bytes(file.size)}</span>}</div>
        <div className="field"><label htmlFor="fw-v">Version</label><input className="inp mono" id="fw-v" placeholder="1.4.4" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!up} /></div>
        <div className="field"><label htmlFor="fw-ch">Channel</label><select className="inp" id="fw-ch" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!up}><option>beta</option><option>stable</option></select></div>
        <div className="field"><label htmlFor="fw-n">What changed</label><textarea className="inp" id="fw-n" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!up} /></div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" type="submit" disabled={!up || busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        {!up && <p className="xs muted">Needs firmware.upload.</p>}
      </form>
    </div>
  );
}

function NewRollout({ releases, onDone, onCancel }: { releases: FirmwareRelease[]; onDone(): void; onCancel(): void }) {
  const toast = useToast();
  const [releaseId, setReleaseId] = useState(releases[0]?.id || '');
  const [target, setTarget] = useState<'percent' | 'all' | 'serials' | 'from_version'>('percent');
  const [percent, setPercent] = useState(10);
  const [serials, setSerials] = useState('');
  const [fromVersion, setFromVersion] = useState(releases[1]?.version || '');
  const [windowOn, setWindowOn] = useState(true);
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('18:00');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const list = serials.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (target === 'percent' && !(percent >= 1 && percent <= 100)) return setErr('Use 1–100 %');
    if (target === 'serials' && !list.length) return setErr('List at least one serial');
    const rel = releases.find((r) => r.id === releaseId);
    if (!confirm(`Start rolling out ${rel?.version}?`)) return;
    setBusy(true);
    try {
      const r = await post<{ rolloutId: string; devices: number }>('/admin/ota/rollouts', {
        releaseId, target, percent: target === 'percent' ? percent : undefined, serials: target === 'serials' ? list : undefined,
        fromVersion: target === 'from_version' ? fromVersion : undefined, installWindow: windowOn ? { from, to } : null,
      });
      toast(`Rollout started for ${r.devices} device${r.devices === 1 ? '' : 's'}`); onDone();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };

  return (
    <div className="card"><h2 style={{ marginBottom: 14 }}>New rollout</h2>
      <form className="form" onSubmit={submit}>
        <div className="fields2">
          <div className="field"><label htmlFor="ro-v">Version</label><select className="inp mono" id="ro-v" value={releaseId} onChange={(e) => setReleaseId(e.target.value)}>{releases.map((f) => <option key={f.id} value={f.id}>{f.version} ({f.channel})</option>)}</select></div>
          <div className="field"><label htmlFor="ro-t">Send to</label><select className="inp" id="ro-t" value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
            <option value="percent">A percentage of devices</option><option value="all">All devices</option><option value="serials">Chosen serial numbers</option><option value="from_version">Devices on a firmware version</option></select></div>
          {target === 'percent' && <div className="field"><label htmlFor="ro-p">Percentage</label><input className="inp num" id="ro-p" type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(Number(e.target.value))} /><span className="hint">Start small, check for failures, then increase.</span></div>}
          {target === 'serials' && <div className="field"><label htmlFor="ro-s">Serials</label><textarea className="inp mono" id="ro-s" rows={2} value={serials} onChange={(e) => setSerials(e.target.value)} placeholder="ARG-24A0012, ARG-24A0013" /><span className="hint">Listed devices update even if they turned automatic updates off.</span></div>}
          {target === 'from_version' && <div className="field"><label htmlFor="ro-f">Devices now on</label><select className="inp mono" id="ro-f" value={fromVersion} onChange={(e) => setFromVersion(e.target.value)}>{releases.map((f) => <option key={f.id}>{f.version}</option>)}</select></div>}
          <div className="field"><label htmlFor="ro-w">Install window (device local time)</label>
            <label className="tog" style={{ paddingTop: 0 }}><span className="t"><span className="small">Only during the day</span></span><input type="checkbox" className="sw" id="ro-w" checked={windowOn} onChange={(e) => setWindowOn(e.target.checked)} /></label>
            {windowOn && <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp" type="time" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><span className="muted">to</span><input className="inp" type="time" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></div>}
            <span className="hint">Never during sleep. Devices with automatic updates off are skipped unless listed by serial.</span></div>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="submit" disabled={busy || !releaseId}>{busy ? 'Starting…' : 'Start rollout'}</button><button className="btn ghost" type="button" onClick={onCancel}>Cancel</button></div>
      </form>
    </div>
  );
}
