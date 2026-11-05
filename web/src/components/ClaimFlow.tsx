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

  return (
    <div className="card">
      <p className="small" style={{ marginBottom: 14 }}>Found <span className="mono">{found.serial}</span> · registered {day(found.registeredAt)}. It will appear under this name.</p>
      {soldBy && <div className="note" style={{ marginBottom: 14 }}><Icon name="tag" /><span>Sold by <b>{soldBy.name}</b>. You will be the owner and can share it with family. The {soldBy.name} team can also see this sensor, to support you.</span></div>}
      <form className="form" onSubmit={submit}>
        <div className="field"><label htmlFor="cl-name">Name</label><input className="inp" id="cl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nani's room" /><span className="hint">Tip: use the person&apos;s name or the room.</span></div>
        <div className="field"><label htmlFor="cl-room">Room (optional)</label><input className="inp" id="cl-room" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Ground floor bedroom" /></div>
        <div className="fields2">
          <div className="field"><label htmlFor="cl-tz">Time zone where the sensor is</label><TzSelect id="cl-tz" value={tz} onChange={setTz} options={TIMEZONES} /><span className="hint">Filled in from this device. Change it if the sensor is in another place.</span></div>
          <div className="field"><label htmlFor="cl-place">Town or city (optional)</label><input className="inp" id="cl-place" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Surat" /><span className="hint">Shown as “{place.trim() || 'Surat'} time” to family in other time zones. Leave empty to show “{placeName(tz, null)} time”.</span></div>
        </div>
        {vendor && (
          <div className="stack" style={{ gap: 6 }}>
            {forVendor && <div className="note"><Icon name="info" /><span>This sensor goes into the <b>stock of {vendor.name}</b>. Everyone on its team will see it. Keep the sticker on it: when you sell it, the customer scans the same sticker and becomes the owner.</span></div>}
            <label className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={!forVendor} onChange={(e) => setForVendor(!e.target.checked)} /> Claim it for myself instead (not for {vendor.name})
            </label>
          </div>
        )}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Adding…' : vendor && forVendor ? 'Add to stock' : 'Add device'}</button><button className="btn ghost" type="button" onClick={onBack}>Back</button></div>
      </form>
    </div>
  );
}

/* ---- QR camera: uses the browser's built-in BarcodeDetector (Chrome / Edge on Android, desktop Chrome).
   Where it's missing (Safari, Firefox) we say so and offer the typed code. Nothing is recorded. ---- */

interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike } }

function QrScanner({ onResult, onTypeInstead, busy }: { onResult(text: string): void; onTypeInstead(): void; busy: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'on' | 'unsupported' | 'denied'>('idle');
  const stream = useRef<MediaStream | null>(null);
  const done = useRef(false);

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  useEffect(() => stop, []);

  const start = async () => {
    if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) return setState('unsupported');
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch { return setState('denied'); }
    setState('on');
    done.current = false;
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    requestAnimationFrame(async function loop() {
      const v = video.current;
      if (!stream.current || done.current) return;
      if (v && v.srcObject !== stream.current) { v.srcObject = stream.current; v.play().catch(() => {}); }
      if (v && v.readyState >= 2) {
        try {
          const r = await det.detect(v);
          if (r[0]?.rawValue) { done.current = true; stop(); setState('idle'); onResult(r[0].rawValue); return; }
        } catch { /* frame not ready */ }
      }
      setTimeout(() => requestAnimationFrame(loop), 250);
    });
  };

  return (
    <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 16 }}>
      <div className="scan">
        {state === 'on'
          ? <><video ref={video} playsInline muted /><span className="c c1" /><span className="c c2" /><span className="c c3" /><span className="c c4" /><span className="ln" /></>
          : <span className="muted"><Icon name="cam" size={44} /></span>}
      </div>
      {busy && <p className="small muted">Checking the code…</p>}
      {state === 'on' && <><p className="small muted">Point at the sticker…</p><button className="btn ghost sm" onClick={() => { stop(); setState('idle'); }}>Stop camera</button></>}
      {state === 'idle' && !busy && <><p className="small muted" style={{ maxWidth: '40ch' }}>We need the camera to read the sticker. Nothing is recorded.</p><button className="btn" onClick={start}><Icon name="cam" /> Turn on camera</button></>}
      {state === 'unsupported' && <><p className="small muted" style={{ maxWidth: '40ch' }}>This browser can&apos;t read QR codes. Use Chrome on Android, or type the code from the sticker.</p><button className="btn" onClick={onTypeInstead}>Type the code</button></>}
      {state === 'denied' && <><p className="small muted" style={{ maxWidth: '40ch' }}>The camera is blocked. Allow it in the browser settings, or type the code from the sticker.</p><button className="btn" onClick={onTypeInstead}>Type the code</button></>}
    </div>
  );
}
