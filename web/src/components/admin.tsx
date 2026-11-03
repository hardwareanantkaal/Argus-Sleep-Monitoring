'use client';

// Bits shared by the admin screens: the printable QR sticker, admin socket topics, small formatters.

import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'react';
import { getSocket } from '@/lib/socket';

/** The QR holds only `ARG1:<12-char code>` (API.md 3 "QR and claim code"); serial + typed code are printed beside it. */
export function QrSvg({ text, size = 132 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  // upper case + ':' fits alphanumeric mode, so the QR stays small; anything else falls back to bytes
  qr.addData(text, /^[0-9A-Z $%*+\-./:]*$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount(), m = 2, dim = n + m * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label={`QR code ${text}`} style={{ flex: 'none', background: '#fff' }}>
      <path d={path} fill="#000" />
    </svg>
  );
}

export const fmtCode = (c: string) => c.replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1-');

export interface StickerData { serial: string; claimCode: string; qrPayload: string; mac?: string; qrPngBase64?: string | null }

/** White in both themes: it's printed on white label paper. */
export function Sticker({ s }: { s: StickerData }) {
  return (
    <div className="sticker">
      {s.qrPngBase64
        ? <img src={`data:image/png;base64,${s.qrPngBase64}`} width={132} height={132} alt={`QR code for ${s.serial}`} style={{ imageRendering: 'pixelated', flex: 'none' }} />
        : <QrSvg text={s.qrPayload} />}
      <div className="mono">
        <b style={{ fontSize: 16 }}>{s.serial}</b><br />
        Code: {fmtCode(s.claimCode)}<br />
        {s.mac && <>MAC: {s.mac}<br /></>}
        Scan in the app to add
      </div>
    </div>
  );
}

/** Opens a print window with just the stickers (50 × 30 mm labels). */
export function printStickers(ids: string[]) {
  const els = ids.map((id) => document.getElementById(id)?.outerHTML || '').join('');
  const w = window.open('', '_blank', 'width=600,height=700');
  if (!w) return;
  w.document.write(`<!doctype html><title>Stickers</title><style>
    @page{size:50mm 30mm;margin:0}body{margin:0;font-family:monospace}
    .sticker{width:50mm;height:30mm;box-sizing:border-box;padding:2mm;display:flex;gap:2mm;align-items:center;page-break-after:always;background:#fff;color:#000}
    .sticker svg,.sticker img{width:26mm!important;height:26mm!important}.mono{font-size:7pt;line-height:1.5}.mono b{font-size:9pt!important}
  </style>${els}<script>onload=()=>{print()}</script>`);
  w.document.close();
}

/** Join admin Socket.IO topics ("devices", "rollouts") and listen to events while mounted. */
export function useAdminSocket(topics: string[], handlers: Record<string, (p: any) => void>) {
  const key = topics.join(',');
  const evs = Object.keys(handlers).join(',');
  useEffect(() => {
    const s = getSocket();
    s.emit('admin:subscribe', { topics: key.split(',') }, () => {});
    const hs = Object.entries(handlers);
    for (const [ev, fn] of hs) s.on(ev, fn);
    return () => { for (const [ev, fn] of hs) s.off(ev, fn); };
    // handlers are re-bound only when the topic/event list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, evs]);
}

export function AdminStatusPill({ d }: { d: { online: boolean; owner: unknown; disabled?: boolean } }) {
  if (d.disabled) return <span className="pill bad"><span className="dot" />Disabled</span>;
  if (!d.owner && !d.online) return <span className="pill acc"><span className="dot" />Not claimed</span>;
  return d.online ? <span className="pill ok"><span className="dot" />Online</span> : <span className="pill bad"><span className="dot" />Offline</span>;
}

/** Debounce a text input so search doesn't call the API on every key. */
export function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

