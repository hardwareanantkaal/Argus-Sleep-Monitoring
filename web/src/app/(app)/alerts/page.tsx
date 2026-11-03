'use client';

// Alerts: in-app only in v1 (no push, no SMS, no unread badge). Recent alerts + my per-device
// "Show me alerts from" switches. Rule editing comes in a later stage.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { Async, Head, useApi } from '@/components/ui';
import { errText, patch } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AlertItem } from '@/lib/types';

type Source = { deviceId: string; deviceName: string; enabled: boolean };
const ICON: Record<string, string> = { breath_low: 'wind', hr_out_of_range: 'heart', out_of_bed: 'person', no_movement: 'activity', device_offline: 'off' };

export default function AlertsPage() {
  const [tab, setTab] = useState<'recent' | 'settings'>('recent');
  const toast = useToast();
  const alerts = useApi<{ items: AlertItem[] }>('/alerts?limit=50');
  const src = useApi<{ items: Source[] }>(tab === 'settings' ? '/me/alert-sources' : null);

  const toggle = async (s: Source, enabled: boolean) => {
    src.setData((x) => x && { items: x.items.map((i) => (i.deviceId === s.deviceId ? { ...i, enabled } : i)) });
    try { await patch(`/me/alert-sources/${s.deviceId}`, { enabled }); alerts.reload(); }
    catch (e) { toast(errText(e)); src.reload(); }
  };

  return (
    <div className="wrap narrow">
      <Head title="Alerts" sub="When something at night needs attention. Alerts show here in the app." />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Recent</button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Show me alerts from</button>
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
        <Async q={src}>{(r) => (
          <div className="card"><h2 style={{ marginBottom: 6 }}>Show me alerts from</h2>
            <p className="xs muted" style={{ marginBottom: 6 }}>Just for you. The alert rules are shared by everyone on the sensor.</p>
            {r.items.length ? r.items.map((s) => (
              <label className="tog" key={s.deviceId}><span className="t"><span>{s.deviceName}</span></span>
                <input type="checkbox" className="sw" checked={s.enabled} onChange={(e) => toggle(s, e.target.checked)} /></label>
            )) : <p className="small muted">No sensors send you alerts.</p>}
          </div>
        )}</Async>
      )}
      <div className="note"><Icon name="info" /><span>Alerts appear only in the app in this version: no phone notifications or SMS. Editing the alert rules arrives in a later stage.</span></div>
    </div>
  );
}
