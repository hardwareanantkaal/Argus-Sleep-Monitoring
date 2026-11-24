'use client';

// Add a device: scan the QR sticker (or type the code) → check → name it, pick time zone + place → claim.
// Used by the Add device screen and step 2 of sign-up. API.md 3.2 / 3.3.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from './Providers';
import { TzSelect } from './ui';
import { errText, post } from '@/lib/api';
import { isLive } from '@/lib/config';
import { browserTz, day, placeName, TIMEZONES } from '@/lib/format';
import type { ClaimCheck, DeviceDetail } from '@/lib/types';

/** v2: the same sticker works twice. result 'stock' = into my vendor's stock; 'owner' = I become the owner (soldBy set when from a vendor's stock). */
type Found = ClaimCheck;
type Key = { qr: string } | { claimCode: string; serial?: string };

/** Format a typed claim code as XXXX-XXXX-XXXX (dashes and lower case are fine for the server too). */
const fmtCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');

export function ClaimFlow({ onDone, onSkip }: { onDone(d: DeviceDetail): void; onSkip?: () => void }) {
  const [tab, setTab] = useState<'scan' | 'type'>('type');
  const [key, setKey] = useState<Key | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [serial, setSerial] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async (k: Key) => {
    setErr(''); setBusy(true);
    try {
      const f = await post<Found>('/devices/claim/check', k);
      setKey(k); setFound(f);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  if (found && key) return <NameStep found={found} k={key} onBack={() => { setFound(null); setKey(null); }} onDone={onDone} />;

  return (
    <>
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === 'scan'} className={tab === 'scan' ? 'on' : ''} onClick={() => setTab('scan')}><Icon name="qr" size={16} /> Scan QR</button>
        <button role="tab" aria-selected={tab === 'type'} className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>Type code</button>
      </div>
      <div className="card">
        {tab === 'scan'
          ? <QrScanner busy={busy} onResult={(qr) => check({ qr })} onTypeInstead={() => setTab('type')} />
          : (
            <form className="form" onSubmit={(e) => { e.preventDefault(); const c = code.replace(/-/g, ''); if (c.length !== 12) return setErr('The claim code has 12 letters and numbers.'); check({ claimCode: c, ...(serial.trim() ? { serial: serial.trim().toUpperCase() } : {}) }); }}>
              <div className="field">
                <label htmlFor="cl-code">Claim code</label>
                <input className="inp mono" id="cl-code" value={code} onChange={(e) => setCode(fmtCode(e.target.value))} autoCapitalize="characters" autoComplete="off" placeholder="XXXX-XXXX-XXXX" />
                <span className="hint">12 letters and numbers, printed beside the QR code.</span>
              </div>
              <div className="field">
                <label htmlFor="cl-ser">Serial number (optional)</label>
                <input className="inp mono" id="cl-ser" value={serial} onChange={(e) => setSerial(e.target.value.toUpperCase())} autoCapitalize="characters" placeholder="ARG-24A0031" />
              </div>
              <button className="btn" type="submit" style={{ alignSelf: 'flex-start' }} disabled={busy}>{busy ? 'Checking…' : 'Find device'}</button>
              {!isLive('claim') && <p className="xs muted">Sample data: try code <button type="button" className="link mono" onClick={() => { setCode('K7P2-9XQM-4HTR'); setSerial('ARG-24A0031'); }}>K7P2-9XQM-4HTR</button></p>}
            </form>
          )}
        {err && <p className="err" role="alert" style={{ marginTop: 12 }}>{err}</p>}
      </div>
      {onSkip && <button className="link small" onClick={onSkip}>Skip for now</button>}
    </>
  );
}

function NameStep({ found, k, onBack, onDone }: { found: Found; k: Key; onBack(): void; onDone(d: DeviceDetail): void }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [tz, setTz] = useState('Asia/Kolkata');
  const [place, setPlace] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // API.md 15.6: a vendor team member claims for the vendor unless they choose "for myself" (asVendor: false)
  // v2: only a factory sticker can go into stock; from a vendor's stock the scanner always becomes the owner.
  const myVendor = useAuth().user?.vendor;
  const vendor = found.result === 'owner' ? null : myVendor;
  const soldBy = found.soldBy;
  const [forVendor, setForVendor] = useState(true);
  useEffect(() => setTz(browserTz()), []); // pre-filled from this phone / browser

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setErr('Give the sensor a name');
    setErr(''); setBusy(true);
    try {
      onDone(await post<DeviceDetail>('/devices/claim', { ...k, name: name.trim(), room: room.trim() || undefined, tz, place: place.trim() || undefined, ...(vendor ? { asVendor: forVendor } : {}) }));
    } catch (e2) { setErr(errText(e2)); setBusy(false); }
  };

  // v2.1: a vendor adds a sensor to stock with scan + confirm only. Name, room and time zone come later with "Use here".
  if (vendor && forVendor) {
    const addToStock = async () => {
      setErr(''); setBusy(true);
      try { onDone(await post<DeviceDetail>('/devices/claim', { ...k, asVendor: true })); } catch (e2) { setErr(errText(e2)); setBusy(false); }
    };
    return (
      <div className="card stack" style={{ gap: 14 }}>
        <p className="small">Found {found.product === 'fall' ? 'fall detector ' : ''}<span className="mono">{found.serial}</span> · registered {day(found.registeredAt)}.</p>
        <div className="note"><Icon name="info" /><span>It goes into the <b>stock of {vendor.name}</b>. Keep the sticker on it: to sell it, the customer scans the same sticker and becomes the owner. To use it yourself, pick <b>Use here</b> on the Stock &amp; devices page.</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" onClick={addToStock} disabled={busy}>{busy ? 'Adding…' : 'Add to stock'}</button><button className="btn ghost" type="button" onClick={onBack}>Back</button></div>
        <details className="small muted"><summary style={{ cursor: 'pointer' }}>More</summary>
          <button className="link small" style={{ marginTop: 8 }} onClick={() => setForVendor(false)}>Claim it for myself instead (my own account, not {vendor.name})</button>
        </details>
      </div>
    );
  }

  return (
    <div className="card">
      <p className="small" style={{ marginBottom: 14 }}>Found {found.product === 'fall' ? 'fall detector ' : ''}<span className="mono">{found.serial}</span> · registered {day(found.registeredAt)}. It will appear under this name.</p>
      {soldBy && <div className="note" style={{ marginBottom: 14 }}><Icon name="tag" /><span>Sold by <b>{soldBy.name}</b>. You will be the owner and can share it with family. {soldBy.name} keeps only a record of the sale and can&apos;t see your data.</span></div>}
      <form className="form" onSubmit={submit}>
        <div className="field"><label htmlFor="cl-name">Name</label><input className="inp" id="cl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nani's room" /><span className="hint">Tip: use the person&apos;s name or the room.</span></div>
        <div className="field"><label htmlFor="cl-room">Room (optional)</label><input className="inp" id="cl-room" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Ground floor bedroom" /></div>
        <div className="fields2">
          <div className="field"><label htmlFor="cl-tz">Time zone where the sensor is</label><TzSelect id="cl-tz" value={tz} onChange={setTz} options={TIMEZONES} /><span className="hint">Filled in from this device. Change it if the sensor is in another place.</span></div>
          <div className="field"><label htmlFor="cl-place">Town or city (optional)</label><input className="inp" id="cl-place" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Surat" /><span className="hint">Shown as “{place.trim() || 'Surat'} time” to family in other time zones. Leave empty to show “{placeName(tz, null)} time”.</span></div>
        </div>
        {vendor && <button className="link small" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setForVendor(true)}>Add it to the stock of {vendor.name} instead</button>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add device'}</button><button className="btn ghost" type="button" onClick={onBack}>Back</button></div>
      </form>
    </div>
  );
}

/* ---- QR camera. Chrome / Edge on Android have a built-in BarcodeDetector; Safari (iPhone, iPad, Mac) and
   Firefox don't, so there we read the frames ourselves with jsQR (loaded only when needed).
   iPhone notes: the camera needs HTTPS and a tap to start, and the <video> must be muted + playsinline or
   iOS won't play it inline. Nothing is recorded. ---- */

interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike } }

type Reader = (v: HTMLVideoElement) => Promise<string | null>;

/** The built-in detector when it exists and knows QR codes, otherwise jsQR on a scaled-down canvas frame. */
async function makeReader(): Promise<Reader> {
  try {
    const BD = window.BarcodeDetector as (Window['BarcodeDetector'] & { getSupportedFormats?: () => Promise<string[]> }) | undefined;
    if (BD && (!BD.getSupportedFormats || (await BD.getSupportedFormats()).includes('qr_code'))) {
      const det = new BD({ formats: ['qr_code'] });
      return async (v) => (await det.detect(v))[0]?.rawValue || null;
    }
  } catch { /* fall through to jsQR */ }
  const jsQR = (await import('jsqr')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth) return null;
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
  };
}

type CamState = 'idle' | 'starting' | 'on' | 'unsupported' | 'insecure' | 'denied' | 'nocam';

function QrScanner({ onResult, onTypeInstead, busy }: { onResult(text: string): void; onTypeInstead(): void; busy: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CamState>('idle');
  const stream = useRef<MediaStream | null>(null);
  const done = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    done.current = true;
    if (timer.current) clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  };
  useEffect(() => stop, []);

  // Must run straight from the button tap: iOS only opens the camera from a user gesture.
  const start = async () => {
    if (!window.isSecureContext) return setState('insecure');
    if (!navigator.mediaDevices?.getUserMedia) return setState('unsupported');
    setState('starting');
    done.current = false;
    try {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        if ((e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'SecurityError') throw e;
        stream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // e.g. no back camera
      }
    } catch (e) {
      stream.current = null;
      const n = (e as Error)?.name;
      return setState(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nocam' : 'denied');
    }
    let read: Reader;
    try { read = await makeReader(); } catch { stop(); return setState('unsupported'); }
    if (done.current || !stream.current) return; // stopped while loading
    setState('on');

    const tick = async () => {
      const v = video.current;
      if (!stream.current || done.current) return;
      if (v && v.srcObject !== stream.current) {
        // Set these as properties too: React's `muted` prop doesn't always reach the element, and iOS checks it.
        v.muted = true; v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.playsInline = true;
        v.srcObject = stream.current;
        v.play().catch(() => {});
      }
      if (v && v.readyState >= 2) {
        try {
          const text = await read(v);
          if (text && !done.current) { stop(); setState('idle'); onResult(text); return; }
        } catch { /* frame not ready */ }
      }
      timer.current = setTimeout(tick, 200);
    };
    tick();
  };

  const msg = (text: string) => <><p className="small muted" style={{ maxWidth: '40ch' }}>{text}</p><div className="row" style={{ justifyContent: 'center' }}><button className="btn" onClick={onTypeInstead}>Type the code</button><button className="btn ghost" onClick={start}>Try again</button></div></>;

  return (
    <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 16 }}>
      <div className="scan">
        {state === 'on'
          ? <><video ref={video} autoPlay playsInline muted /><span className="c c1" /><span className="c c2" /><span className="c c3" /><span className="c c4" /><span className="ln" /></>
          : <span className="muted"><Icon name="cam" size={44} /></span>}
      </div>
      {busy && <p className="small muted">Checking the code…</p>}
      {state === 'starting' && <p className="small muted">Opening the camera…</p>}
      {state === 'on' && <><p className="small muted">Point at the sticker. Hold it about 15 cm away.</p><button className="btn ghost sm" onClick={() => { stop(); setState('idle'); }}>Stop camera</button></>}
      {state === 'idle' && !busy && <><p className="small muted" style={{ maxWidth: '40ch' }}>We need the camera to read the sticker. Nothing is recorded.</p><button className="btn" onClick={start}><Icon name="cam" /> Turn on camera</button></>}
      {state === 'insecure' && msg('The camera only works on a secure (https://) address. Open the site with https://, or type the code from the sticker.')}
      {state === 'unsupported' && msg('This browser can’t open the camera. If you opened the link inside WhatsApp or another app, open it in Safari or Chrome instead, or type the code from the sticker.')}
      {state === 'nocam' && msg('No camera was found on this device. Type the code from the sticker instead.')}
      {state === 'denied' && msg('The camera is blocked. On iPhone: Settings › Safari › Camera › Allow (or tap “aA” in the address bar › Website Settings). Then try again, or type the code.')}
    </div>
  );
}
