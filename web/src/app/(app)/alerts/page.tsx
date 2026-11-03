'use client';

// Alerts: in-app only in v1 (no push, no SMS, no unread badge). Recent alerts + my own settings
// (API.md 2.5/2.6): "Show me alerts from" switches (= mutedDeviceIds) and quiet hours.
// Rule editing comes in a later stage.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { Async, Head, useApi } from '@/components/ui';
import { errText, patch } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AlertItem, DeviceCard, NotificationPrefs } from '@/lib/types';
const ICON: Record<string, string> = { breath_low: 'wind', hr_out_of_range: 'heart', out_of_bed: 'person', no_movement: 'activity', device_offline: 'off' };

export default function AlertsPage() {
  const [tab, setTab] = useState<'recent' | 'settings'>('recent');
  const toast = useToast();
  const alerts = useApi<{ items: AlertItem[] }>('/alerts?limit=50');
  const prefs = useApi<NotificationPrefs>(tab === 'settings' ? '/me/notification-prefs' : null);
  const devs = useApi<{ items: DeviceCard[] }>(tab === 'settings' ? '/devices' : null);

  const save = async (b: Partial<NotificationPrefs>) => {
    prefs.setData((x) => x && { ...x, ...b });
    try { prefs.setData(await patch<NotificationPrefs>('/me/notification-prefs', b)); alerts.reload(); }
    catch (e) { toast(errText(e)); prefs.reload(); }
  };

  return (
    <div className="wrap narrow">
      <Head title="Alerts" sub="When something at night needs attention. Alerts show here in the app." />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Recent</button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>My alert settings</button>
      </div>
      {tab === 'recent' ? (
        <Async q={alerts}>{(r) => r.items.length ? (
          <div className="card">
            {r.items.map((a) => (
              <div className="alert" key={a.id}>
                <div className={`ico ${a.severity === 'critical' ? 'bad' : 'warn'}`}><Icon name={ICON[a.type] || 'alert'} /></div>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                  <div className="between" style={{ alignItems: 'flex-start' }}><b>{a.title}</b><span className="xs muted" style={{ whiteSpace: 'nowrap' }}>{ago(a.startedAt)}</span></div>
                  <span className="small">{a.deviceName}{!a.endedAt && <> · <span className="pill bad xs">Still happening</span></>}</span>
                  <span className="xs muted">{a.detail}</span>
                </div>
              </div>
            ))}
          </div>
        ) : <div className="card empty"><Icon name="bell" size={30} /><h2>No alerts</h2><p>Nothing needed attention recently.</p></div>}</Async>
      ) : (
        <Async q={prefs}>{(p) => {
          const list = (devs.data?.items || []).filter((d) => d.myPermissions.includes('alerts.receive'));
          return <>
            <div className="card"><h2 style={{ marginBottom: 6 }}>Show me alerts from</h2>
              <p className="xs muted" style={{ marginBottom: 6 }}>Just for you. The alert rules are shared by everyone on the sensor.</p>
              {devs.data === undefined ? <p className="small muted">Loading…</p> : list.length ? list.map((d) => (
                <label className="tog" key={d.id}><span className="t"><span>{d.name}</span><span className="xs muted">{d.room || d.serial}</span></span>
                  <input type="checkbox" className="sw" checked={!p.mutedDeviceIds.includes(d.id)}
                    onChange={(e) => save({ mutedDeviceIds: e.target.checked ? p.mutedDeviceIds.filter((x) => x !== d.id) : [...p.mutedDeviceIds, d.id] })} /></label>
              )) : <p className="small muted">No sensors send you alerts.</p>}
            </div>
            <div className="card"><h2 style={{ marginBottom: 6 }}>Quiet hours</h2>
              <label className="tog"><span className="t"><span>Only critical alerts during quiet hours</span><span className="xs muted">Warnings (out of bed, offline…) wait until the morning</span></span>
                <input type="checkbox" className="sw" checked={p.quietEnabled} onChange={(e) => save({ quietEnabled: e.target.checked })} /></label>
              <div className="fields2" style={{ marginTop: 10 }}>
                <div className="field"><label htmlFor="qh-from">From</label><input className="inp" type="time" id="qh-from" value={p.quietFrom} disabled={!p.quietEnabled} onChange={(e) => save({ quietFrom: e.target.value })} /></div>
                <div className="field"><label htmlFor="qh-to">To</label><input className="inp" type="time" id="qh-to" value={p.quietTo} disabled={!p.quietEnabled} onChange={(e) => save({ quietTo: e.target.value })} /></div>
              </div>
            </div>
          </>;
        }}</Async>
      )}
      <div className="note"><Icon name="info" /><span>Alerts appear only in the app in this version: no phone notifications or SMS. Editing the alert rules arrives in a later stage.</span></div>
    </div>
  );
}
