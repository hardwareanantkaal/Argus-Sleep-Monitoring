'use client';

// Subscribe to live values + online status for some devices (API.md §10).
// Live values are shown and thrown away; nothing is stored.

import { useEffect, useState } from 'react';
import { getSocket } from './socket';
import type { LiveValues } from './types';

export interface LiveMsg extends LiveValues { deviceId: string; serial: string }
export interface StatusMsg { deviceId: string; online: boolean; lastSeenAt: string | null }

/** `liveIds`: devices to get live values for (needs live.view). `statusIds`: devices to watch online/offline. */
export function useLive(statusIds: string[], liveIds: string[], onLive?: (m: LiveMsg) => void) {
  const [live, setLive] = useState<Record<string, LiveMsg>>({});
  const [status, setStatus] = useState<Record<string, StatusMsg>>({});
  const sKey = statusIds.join(','), lKey = liveIds.join(',');

  useEffect(() => {
    const ids = sKey ? sKey.split(',') : [];
    const lids = lKey ? lKey.split(',') : [];
    if (!ids.length && !lids.length) return;
    const s = getSocket();
    const onL = (m: LiveMsg) => { if (lids.includes(m.deviceId)) { setLive((x) => ({ ...x, [m.deviceId]: m })); onLive?.(m); } };
    const onS = (m: StatusMsg) => { if (ids.includes(m.deviceId)) setStatus((x) => ({ ...x, [m.deviceId]: m })); };
    s.on('device:live', onL);
    s.on('device:status', onS);
    if (ids.length) s.emit('devices:subscribe', { deviceIds: ids }, (r: { status?: StatusMsg[] }) => {
      if (r?.status) setStatus((x) => { const n = { ...x }; for (const st of r.status!) n[st.deviceId] = st; return n; });
    });
    for (const id of lids) s.emit('live:subscribe', { deviceId: id }, () => {});
    return () => {
      s.off('device:live', onL);
      s.off('device:status', onS);
      for (const id of lids) s.emit('live:unsubscribe', { deviceId: id });
    };
    // onLive is intentionally not a dependency (callers pass inline functions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sKey, lKey]);

  return { live, status };
}
