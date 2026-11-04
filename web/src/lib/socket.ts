// Socket.IO for live updates (API.md §10). Live values are pushed to the screen and never stored.
// In mock mode a small fake sends the same events, so the Live view works without a backend.

import { io, type Socket } from 'socket.io-client';
import { isLive } from './config';
import { refreshSession } from './api';
import { mockDevice, mockEmit, mockOff, mockOn, startMockRollouts } from './mock/handler';

type Listener = (payload: any) => void;
export interface LiveSocket {
  on(ev: string, fn: Listener): void;
  off(ev: string, fn: Listener): void;
  emit(ev: string, payload: unknown, ack?: (res: any) => void): void;
}

let real: Socket | null = null;

function realSocket(): LiveSocket {
  if (!real) {
    // Same origin: Next rewrites (dev) or Nginx (prod) forward /socket.io to the backend.
    // websocket first; polling only as a fallback if a proxy refuses the upgrade.
    real = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    const s = real;
    // The server says the access cookie expired: refresh it, then reconnect (Water Tank fix).
    s.on('auth:expired', async () => {
      s.disconnect();
      if (await refreshSession()) s.connect();
    });
    s.on('connect_error', async (err) => {
      if (/TOKEN_EXPIRED/.test(err.message) && (await refreshSession())) s.connect();
    });
  }
  return real as unknown as LiveSocket;
}

/* ---- mock ---- */
const timers: Record<string, ReturnType<typeof setInterval>> = {};
function startMockLive(deviceId: string) {
  const d = mockDevice(deviceId);
  if (!d || !d.online || timers[deviceId]) return;
  let hr = d.base.hr, br = d.base.br, mr = d.base.bed ? 8 : 0, seq = 1000, st = d.base.ss;
  // sample §11a session blocks: a session that started ~95 min ago
  const start = Math.floor(Date.now() / 1000) - 95 * 60;
  const sess = { st, start, bed: 95, slp: 78, dp: 26, lt: 52, aw: 17, on: 12, wk: 2, tn: 6, sc: 74 };
  timers[deviceId] = setInterval(() => {
    hr = Math.max(d.base.hr - 8, Math.min(d.base.hr + 8, hr + Math.round((Math.random() - 0.5) * 3)));
    br = Math.max(d.base.br - 3, Math.min(d.base.br + 3, br + Math.round((Math.random() - 0.5) * 1.4)));
    mr = d.base.bed ? Math.max(0, Math.min(100, Math.round(mr * 0.7 + (Math.random() < 0.15 ? Math.random() * 40 : Math.random() * 6)))) : 0;
    seq++;
    if (Math.random() < 0.12) st = [0, 1, 1, 2][Math.floor(Math.random() * 4)];
    const el = Math.round((Date.now() / 1000 - start) / 60);
    Object.assign(sess, { st, bed: el, slp: Math.round(el * 0.82), dp: Math.round(el * 0.27), lt: Math.round(el * 0.55), aw: Math.round(el * 0.18) });
    const inSession = !!d.base.bed;
    mockEmit('device:live', {
      seq, radar: 1, up: (d.uptimeS ?? 0) + seq * 2, fw: d.fw,
      ...(inSession ? {
        sess: { ...sess },
        cmp: { dis: mr > 30 ? 2 : 1, abn: 1, rat: 2, resp: d.base.br, hr: d.base.hr, apn: 0, turn: 6, lg: 4, mn: 18 },
        ngt: { sc: 74, slp: sess.slp, wk: 2, sh: 67, dp: 33, oob: 4, ex: 1, tn: 6, resp: d.base.br, hr: d.base.hr, apn: 0 },
      } : {}),
      deviceId, serial: d.serial, pr: d.base.bed ? 1 : 0, bed: d.base.bed, ss: d.base.bed ? st : 3, hr: d.base.bed ? hr : 0, br: d.base.bed ? br : 0,
      bs: 1, mv: mr > 30 ? 2 : mr > 0 ? 1 : 0, mr, dist: d.base.bed ? 85 + Math.round(Math.random() * 4) : 0,
      rssi: (d.rssi ?? -60) + Math.round((Math.random() - 0.5) * 4), at: new Date().toISOString(),
    });
  }, 2000); // the real sensor sends every 5 s in bed; faster here so the demo feels alive
}
const mockSocket: LiveSocket = {
  on: mockOn,
  off: mockOff,
  emit(ev, payload: any, ack) {
    if (ev === 'live:subscribe') { startMockLive(payload.deviceId); const d = mockDevice(payload.deviceId); ack?.({ ok: true, live: d?.online ? { pr: d.base.bed, bed: d.base.bed, ss: d.base.ss, hr: d.base.hr, br: d.base.br, at: new Date().toISOString() } : null }); }
    else if (ev === 'live:unsubscribe') { clearInterval(timers[payload.deviceId]); delete timers[payload.deviceId]; ack?.({ ok: true }); }
    else if (ev === 'devices:subscribe') ack?.({ ok: true, deviceIds: payload.deviceIds, status: (payload.deviceIds as string[]).map((id) => { const d = mockDevice(id); return { deviceId: id, online: !!d?.online, lastSeenAt: d?.lastSeenAt }; }) });
    else if (ev === 'admin:subscribe') { if ((payload.topics || []).includes('rollouts')) startMockRollouts(); ack?.({ ok: true }); }
    else ack?.({ ok: true });
  },
};

export function getSocket(): LiveSocket {
  return isLive('live') ? realSocket() : mockSocket;
}

export function closeSocket() {
  real?.disconnect();
  real = null;
}
