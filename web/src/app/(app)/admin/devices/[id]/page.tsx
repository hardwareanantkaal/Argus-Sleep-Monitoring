'use client';

// Admin: device detail (API.md 8.3, 8.5–8.12). Hardware, connection, owner, events, commands with
// live results (command:status), uploaded logs, new claim code (+ sticker), disable / unclaim / delete.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AdminStatusPill, printStickers, Sticker, useAdminSocket, type StickerData } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useAuth, useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, ErrorBox, Head, useApi } from '@/components/ui';
import { ApiError, del, errText, get, patch, post } from '@/lib/api';
import { ago, dateTime, day, prettyPhone, uptime } from '@/lib/format';
import type { AdminDeviceDetail, CommandRow, CommandType, DeviceEvent, List } from '@/lib/types';

const CMDS: [CommandType, string][] = [
  ['reboot', 'Restart the sensor'],
  ['config_mode', 'Open Wi-Fi setup mode'],
  ['ota_check', 'Check for a firmware update now'],
  ['logs', 'Upload the last log lines'],
  ['recalibrate', 'Recalibrate radar (about 11 s)'],
  ['end_session', 'End the running sleep session now (fw 2.5.1+)'],
];
const STATUS_PILL: Record<CommandRow['status'], [string, string]> = {
  queued: ['Queued', ''], sent: ['Sent', 'warn'], acked: ['Acked', 'ok'], done: ['Done', 'ok'], failed: ['Failed', 'bad'], expired: ['Expired', 'bad'],
};

export default function AdminDevicePage() {
  return <RequireStaff perm="devices.view"><Inner /></RequireStaff>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const q = useApi<AdminDeviceDetail>(`/admin/devices/${id}`);
  const cmds = useApi<List<CommandRow>>(`/admin/devices/${id}/commands?limit=20`);
  const logs = useApi<{ items: { id: string; createdAt: string; content: string }[] }>(`/admin/devices/${id}/logs`);
  const events = useApi<List<DeviceEvent>>(`/admin/devices/${id}/events?limit=20`);
  const [pending, setPending] = useState<CommandType | null>(null);
  const [sticker, setSticker] = useState<StickerData | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [unclaiming, setUnclaiming] = useState(false);
  const [reason, setReason] = useState('');

  useAdminSocket(['devices'], {
    'command:status': (m: { commandId: string; deviceId: string; status: CommandRow['status']; error: string | null; type: CommandType }) => {
      if (m.deviceId !== id) return;
      cmds.setData((x) => x && { ...x, items: x.items.map((c) => (c.id === m.commandId ? { ...c, status: m.status, error: m.error } : c)) });
      if (m.type === 'logs' && m.status === 'done') logs.reload();
    },
    'device:status': (m: { deviceId: string; online: boolean; lastSeenAt: string | null }) => {
      if (m.deviceId === id) q.setData((x) => x && { ...x, connection: { ...x.connection, online: m.online, lastSeenAt: m.lastSeenAt } });
    },
  });

  const send = async (type: CommandType) => {
    setPending(null);
    try {
      const r = await post<{ commandId: string; status: CommandRow['status'] }>(`/admin/devices/${id}/commands`, { type });
      toast(r.status === 'sent' ? `${type} sent` : r.status === 'queued' ? `${type} queued until the sensor reconnects` : `${type} expired: the sensor is offline`);
      cmds.reload();
    } catch (e) { toast(errText(e)); }
  };
  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    try { await fn(); toast(ok); q.reload(); after?.(); } catch (e) { toast(errText(e)); }
  };

  return (
    <Async q={q}>{(d) => {
      const c = d.connection;
      const cmdOk = can('devices.command');
      return (
        <div className="wrap">
          <Head title={<span className="mono">{d.serial}</span>} sub={[d.name, d.owner?.fullName].filter(Boolean).join(' · ') || 'Not claimed'}
            actions={<AdminStatusPill d={{ online: c.online, owner: d.owner, disabled: d.isDisabled }} />} back={['/admin/devices', 'Devices']} />
          {d.isDisabled && <div className="banner"><Icon name="alert" /><span>Disabled{d.disabledReason ? `: ${d.disabledReason}` : ''}. The broker refuses its MQTT login.</span></div>}
          <div className="g3">
            <div className="card"><h2 style={{ marginBottom: 12 }}>Hardware</h2><dl className="kv">
              <dt>MAC</dt><dd className="mono">{d.hardware.mac}</dd>
              <dt>Chip</dt><dd className="mono">{d.hardware.chip}</dd>
              <dt>Radar</dt><dd>{d.hardware.radar}</dd>
              <dt>Model</dt><dd>{d.hardware.hwModel}</dd>
              <dt>Batch</dt><dd>{d.hardware.batch || '—'}</dd>
              <dt>Firmware at register</dt><dd className="mono">{d.hardware.fwAtRegister || '—'}</dd>
              <dt>Registered</dt><dd>{day(d.hardware.registeredAt)} · {d.hardware.registeredBy}</dd>
            </dl></div>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Connection</h2><dl className="kv">
              <dt>Status</dt><dd>{c.online ? 'Online' : 'Offline'}</dd>
              <dt>Last seen</dt><dd>{c.online ? 'Now' : ago(c.lastSeenAt)}</dd>
              <dt>Firmware</dt><dd className="mono">{c.fw || '—'}</dd>
              <dt>Time zone</dt><dd className="mono">{d.tz || '—'}</dd>
              <dt>New night at</dt><dd className="num">{d.sleepCutoff}</dd>
              <dt>IP</dt><dd className="mono">{c.ip || '—'}</dd>
              <dt>Wi-Fi</dt><dd>{c.wifiSsid || '—'}</dd>
              <dt>Signal</dt><dd className="num">{c.rssi != null ? `${c.rssi} dBm` : '—'}</dd>
              <dt>Uptime</dt><dd>{uptime(c.uptimeS)}</dd>
              <dt>Radar</dt><dd>{c.radarOk == null ? '—' : c.radarOk ? 'OK' : 'Fault'}</dd>
            </dl></div>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Owner and access</h2>
              {d.owner ? <div className="stack" style={{ gap: 8 }}>
                {can('customers.view') ? <Link href={`/admin/customers/${d.owner.id}`}>{d.owner.fullName}</Link> : <b>{d.owner.fullName}</b>}
                <span className="xs muted">{prettyPhone(d.owner.phone)}</span>
                <span className="small">{d.shares.length} {d.shares.length === 1 ? 'person' : 'people'} shared</span>
                {d.shares.map((s) => <span key={s.phone} className="xs muted">· {s.fullName}</span>)}
              </div> : <p className="small muted">Not claimed yet. {d.claimCodeActive ? 'Its claim code is on the sticker.' : 'No active claim code: make a new one.'}</p>}
              {d.sensorSettings && <>
                <div className="divider" style={{ marginBlock: 12 }} />
                <dl className="kv xs">
                  <dt>Bed-exit timeout</dt><dd className="num">{d.sensorSettings.exitS} s</dd>
                  <dt>Live / idle rate</dt><dd className="num">{d.sensorSettings.liveS} s / {d.sensorSettings.idleS} s</dd>
                  <dt>Settings</dt><dd>v{d.sensorSettings.version} · {d.sensorSettings.sync === 'applied' ? 'on device' : d.sensorSettings.sync}</dd>
                </dl>
              </>}
            </div>
          </div>

          <div className="g2">
            <div className="card">
              <div className="ch"><div className="t"><h2>Send a command</h2><span className="xs muted">Goes to the device over MQTT</span></div></div>
              {!c.online && <div className="note" style={{ marginBottom: 12 }}><Icon name="off" /><span>Device is offline. Commands wait up to 24 h until it reconnects; <span className="mono">config_mode</span> and <span className="mono">recalibrate</span> expire after 30 s.</span></div>}
              {pending && <div className="confirm" style={{ marginBottom: 12 }}><span>Send <b className="mono">{pending}</b> to {d.serial}?</span><span className="sp" />
                <button className="btn sm" onClick={() => send(pending)}>Send</button><button className="btn ghost sm" onClick={() => setPending(null)}>Cancel</button></div>}
              <div className="cmds">{CMDS.map(([k, t]) => <button key={k} className="cmd" disabled={!cmdOk || d.isDisabled} onClick={() => setPending(k)}><b>{k}</b><span>{t}</span></button>)}</div>
              {!cmdOk && <p className="xs muted" style={{ marginTop: 10 }}>Your role cannot send commands (needs devices.command).</p>}
            </div>
            <div className="card"><h2 style={{ marginBottom: 12 }}>Command history</h2>
              <Async q={cmds}>{(r) => r.items.length ? (
                <div className="tbl"><table>
                  <thead><tr><th>Command</th><th>By</th><th>Sent</th><th>Result</th></tr></thead>
                  <tbody>{r.items.map((x) => {
                    const [l, cl] = STATUS_PILL[x.status];
                    return <tr key={x.id}><td className="mono">{x.type}</td><td>{x.requestedBy}</td><td className="muted">{ago(x.createdAt)}</td>
                      <td><span className={`pill ${cl}`}>{x.status === 'sent' && <span className="dot pulse" />}{l}</span>{x.error && <span className="xs muted"> {x.error}</span>}</td></tr>;
                  })}</tbody>
                </table></div>
              ) : <p className="small muted">No commands sent yet.</p>}</Async>
            </div>
          </div>

          {logs.data && logs.data.items.length > 0 && (
            <div className="card"><div className="ch"><h2>Latest logs</h2><span className="xs muted">Uploaded {dateTime(logs.data.items[0].createdAt)}</span></div>
              <div className="term">{logs.data.items[0].content}</div></div>
          )}

          <div className="g2">
            <div className="card"><h2 style={{ marginBottom: 12 }}>Events</h2>
              <Async q={events}>{(r) => r.items.length ? (
                <div className="tbl"><table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
                  <tbody>{r.items.map((e) => <tr key={e.id}><td className="muted">{dateTime(e.createdAt)}</td><td className="mono">{e.type}</td><td className="muted">{e.detail || ''}</td></tr>)}</tbody></table></div>
              ) : <p className="small muted">No events yet.</p>}</Async>
            </div>
            <div className="card stack" style={{ gap: 12 }}><h2>Manage</h2>
              {can('devices.register') && d.stickerAvailable && <div className="stack" style={{ gap: 8 }}>
                <span className="small"><b>Print sticker</b> <span className="muted">· the current claim code, same 50 × 30 mm label as Register</span></span>
                <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={async () => {
                  try { const r = await get<StickerData>(`/admin/devices/${id}/sticker`); setSticker({ ...r, mac: d.hardware.mac }); setTimeout(() => printStickers(['stk-detail']), 50); }
                  catch (e) { toast(e instanceof ApiError && e.code === 'NO_ACTIVE_CODE' ? 'Device already claimed. Create a new code to print a sticker.' : errText(e)); q.reload(); }
                }}><Icon name="qr" /> Print sticker</button>
              </div>}
              {can('devices.register') && <div className="stack" style={{ gap: 8 }}>
                <span className="small"><b>New claim code</b> <span className="muted">· for a lost sticker or a resold sensor. The old code stops working.</span></span>
                <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={async () => {
                  if (!confirm(`Make a new claim code for ${d.serial}? The old sticker stops working.`)) return;
                  try { const r = await post<StickerData>(`/admin/devices/${id}/claim-code`); setSticker({ ...r, mac: d.hardware.mac }); q.reload(); } catch (e) { toast(errText(e)); }
                }}><Icon name="qr" /> Make a new claim code</button>
                {sticker && <><div id="stk-detail"><Sticker s={sticker} /></div>
                  <p className="hint">The code is shown only now. Print the sticker before leaving this page.</p>
                  <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => printStickers(['stk-detail'])}>Print sticker</button></>}
              </div>}
              {cmdOk && <div className="stack" style={{ gap: 8 }}>
                <div className="divider" />
                {d.isDisabled
                  ? <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => run(() => patch(`/admin/devices/${id}`, { isDisabled: false }), 'Device enabled')}>Enable device</button>
                  : !disabling ? <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => { setDisabling(true); setReason(''); }}>Disable device</button>
                    : <form className="form" onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) return toast('Give a reason'); run(() => patch(`/admin/devices/${id}`, { isDisabled: true, disabledReason: reason.trim() }), 'Device disabled', () => setDisabling(false)); }}>
                      <div className="field"><label htmlFor="dv-reason">Why disable it?</label><input className="inp" id="dv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. returned for repair" /><span className="hint">The broker refuses its login and it is kicked off at once.</span></div>
                      <div className="row"><button className="btn danger solid" type="submit">Disable</button><button className="btn ghost" type="button" onClick={() => setDisabling(false)}>Cancel</button></div>
                    </form>}
              </div>}
              {d.owner && can('customers.edit') && <div className="stack" style={{ gap: 8 }}>
                <div className="divider" />
                {!unclaiming ? <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => { setUnclaiming(true); setReason(''); }}>Remove owner (unclaim)</button>
                  : <form className="form" onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) return toast('Give a reason'); run(() => post(`/admin/devices/${id}/unclaim`, { reason: reason.trim() }), 'Owner removed', () => setUnclaiming(false)); }}>
                    <div className="field"><label htmlFor="uc-reason">Why remove the owner?</label><input className="inp" id="uc-reason" value={reason} onChange={(e) => setReason(e.target.value)} /><span className="hint">Their shares and sleep history for this sensor are deleted. Make a new claim code afterwards.</span></div>
                    <div className="row"><button className="btn danger solid" type="submit">Remove owner</button><button className="btn ghost" type="button" onClick={() => setUnclaiming(false)}>Cancel</button></div>
                  </form>}
              </div>}
              {!d.owner && can('devices.register') && <div className="stack" style={{ gap: 8 }}>
                <div className="divider" />
                <span className="xs muted">Only for a sensor that was never claimed, e.g. a mistyped MAC.</span>
                <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={async () => {
                  if (!confirm(`Delete ${d.serial}? This cannot be undone.`)) return;
                  try { await del(`/admin/devices/${id}`); toast('Device deleted'); router.replace('/admin/devices'); } catch (e) { toast(errText(e)); }
                }}>Delete device</button>
              </div>}
              {!can('devices.register') && !cmdOk && !can('customers.edit') && <p className="small muted">Your role can only view this device.</p>}
            </div>
          </div>
          {cmds.error ? <ErrorBox error={cmds.error} retry={cmds.reload} /> : null}
        </div>
      );
    }}</Async>
  );
}
