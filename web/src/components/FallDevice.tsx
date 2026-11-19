'use client';

// Fall Detection device page (migration 013, API.md §4b). The device sends an
// "alive" message every 60 s (live only, not stored) and one event per FALL or
// RECOVERED (stored). Kept simple on purpose: status + the list of falls.

import { useEffect } from 'react';
import { Icon } from '@/components/Icon';
import { Async, Head, StatusPill, TzTag, useApi } from '@/components/ui';
import { ago, dateTime } from '@/lib/format';
import { getSocket } from '@/lib/socket';
import type { DeviceDetail, FallEvent, FallList, LiveValues } from '@/lib/types';

const PRESET: Record<string, string> = { LOW: 'Low (hard falls only)', MED: 'Medium', HIGH: 'High (testing)' };

/** "1 min 35 s" */
export function recoveryText(s: number | null | undefined) {
  if (s == null) return '—';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const cm = (m: number | null | undefined) => (m == null ? '—' : `${Math.round(m * 100)} cm`);

export function FallDevice({ d, online, lastSeen, lv, links, sub, back, until }: {
  d: DeviceDetail; online: boolean; lastSeen: string | null; lv: LiveValues | null;
  links: React.ReactNode; sub: string; back: [string, string]; until: React.ReactNode;
}) {
  const canHist = d.myPermissions.includes('history.view');
  const canLive = d.myPermissions.includes('live.view');
  const q = useApi<FallList>(canHist ? `/devices/${d.id}/falls?limit=50` : null);
  // A new FALL / RECOVERED arrives on the device room as device:fall → reload the list.
  useEffect(() => {
    const s = getSocket();
    const h = (m: { deviceId: string }) => { if (m.deviceId === d.id) q.reload(); };
    s.on('device:fall', h);
    return () => s.off('device:fall', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id]);

  const falls = (q.data?.items || []).filter((e) => e.kind === 'fall');
  const down = falls.filter((e) => !e.recoveredAt);
  const fw = lv?.fw || d.connection?.fw;

  return (
    <div className="wrap">
      <Head title={<>{d.name}<TzTag tz={d.tz} place={d.place} /></>} sub={sub} actions={<span className="row" style={{ gap: 8 }}>{links}</span>} back={back} />
      {until}
      {down.length > 0 && (
        <div className="dash-banner bad"><Icon name="alert" /><span><b>Fall detected {ago(down[0].at).toLowerCase()}.</b> The person has not got up yet.</span></div>
      )}
      <div className="card stack">
        <div className="between">
          <h2 className="row" style={{ gap: 8 }}><Icon name="person" /> Fall detector</h2>
          <StatusPill online={online} />
        </div>
        {canLive ? (
          <div className="vitals">
            <div className="vital"><span>Room</span><b style={{ fontSize: 15, paddingBlock: 3 }}>{!online || lv?.pr == null ? '—' : lv.pr ? 'Occupied' : 'Empty'}</b></div>
            <div className="vital"><span>Radar</span><b style={{ fontSize: 15, paddingBlock: 3 }}>{!online || lv?.radar == null ? '—' : lv.radar ? 'OK' : 'Not responding'}</b></div>
            <div className="vital"><span>Sensitivity</span><b style={{ fontSize: 15, paddingBlock: 3 }}>{lv?.preset ? PRESET[lv.preset] : '—'}</b></div>
          </div>
        ) : <div className="note"><Icon name="info" /><span>Live status isn&apos;t shared with you.</span></div>}
        <span className="xs muted">
          {online ? 'The sensor reports every minute.' : `Last seen ${ago(lastSeen).toLowerCase()}. Check that it is plugged in and on Wi-Fi.`}
          {fw ? ` Firmware v${fw}.` : ''} Serial {d.serial}.
        </span>
      </div>

      <div className="card stack">
        <div className="between">
          <h2>Falls</h2>
          {q.data && <span className="xs muted">{falls.length} shown</span>}
        </div>
        {!canHist ? <div className="note"><Icon name="shield" /><span>Fall history isn&apos;t shared with you.</span></div> : (
          <Async q={q}>{(r) => r.items.some((e) => e.kind === 'fall') ? <FallTable items={r.items} tz={d.tz} /> : (
            <div className="empty"><Icon name="check" size={28} /><p>No falls recorded.</p></div>
          )}</Async>
        )}
      </div>

      <div className="note"><Icon name="info" /><span>Only falls are saved. The sensor&apos;s live status is shown and <b>not saved</b>.</span></div>
    </div>
  );
}

function FallTable({ items, tz }: { items: FallEvent[]; tz: string }) {
  const falls = items.filter((e) => e.kind === 'fall');
  return (
    <div className="tbl"><table>
      <thead><tr><th>When</th><th>Drop</th><th>Height</th><th>Got up after</th></tr></thead>
      <tbody>{falls.map((e) => (
        <tr key={e.id}>
          <td>{dateTime(e.at, tz)}</td>
          <td>{cm(e.dropM)}{e.dropPct != null && <span className="xs muted"> ({Math.round(e.dropPct)}%)</span>}</td>
          <td title={e.emaPeak != null && e.emaNow != null ? `${cm(e.emaPeak)} → ${cm(e.emaNow)}` : undefined}>{cm(e.heightM ?? e.emaNow)}</td>
          <td>{e.recoveredAt ? recoveryText(e.recoveryS) : <span className="pill bad">Still down</span>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
