'use client';

// Manufacturing (docs/MANUFACTURING.md, API.md §9b). One board on USB, three options the factory person
// can use in any order:  Flash firmware · Serial monitor & test · Register (+ sticker).
// The board connection is shared: connect once, then switch tabs freely.
// The browser does all the USB work (Web Serial + esptool-js); the server stores images and results.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { printStickers, Sticker, type StickerData } from '@/components/admin';
import { FLASH_BYTES, macUpper, sha256Hex } from '@/components/factory';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Head } from '@/components/ui';
import { ApiError, errText, get, patch, post, qs, refreshSession } from '@/lib/api';
import { CHECKS, createChecker, type Checker } from '@/lib/checks';
import { bytes } from '@/lib/format';
import { connectBoard, flashImage, leaveBootloader, Monitor, releaseBoard, serialSupported, type Board } from '@/lib/serial';
import type { FactoryRelease, FactoryRun, FactoryRunList, RegisterResult } from '@/lib/types';

const LOG_TAIL = 16384;
const MAX_LINES = 1500;
const HW_MODELS = ['ARG-S1 rev B', 'ARG-S1 rev A'];

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(`argus.${k}`) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`argus.${k}`, v); } catch { /* private mode */ } },
};
const imageCache = new Map<number, Uint8Array>(); // releaseId -> image, kept for the next boards

type Tab = 'flash' | 'monitor' | 'register';
// none: no board · boot: esptool connection (bootloader) · monitor: plain serial monitor running · off: port closed
type Link_ = 'none' | 'boot' | 'monitor' | 'off';
interface BoardInfo { chip: string; desc: string; mac: string }

export default function ManufacturingPage() {
  return <RequireStaff perm="factory.monitor"><Inner /></RequireStaff>;
}

/** Download the factory image (cookie login; refresh once if the access cookie expired). */
async function download(id: number): Promise<Uint8Array> {
  const go = () => fetch(`/api/v1/admin/factory/releases/${id}/image`, { credentials: 'include' });
  let r = await go();
  if (r.status === 401 && (await refreshSession())) r = await go();
  if (!r.ok) throw new ApiError(r.status, `HTTP_${r.status}`, `Download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

function portHint(e: unknown) {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/NotFoundError|No port selected/i.test(m)) return 'No port was picked. Press Connect again and choose the board (often “USB Serial”, “CP210x” or “CH340”).';
  if (/already open|Failed to open|InvalidStateError|NetworkError/i.test(m)) return 'The port is busy. Close Arduino IDE or any serial monitor, unplug and replug the board, then try again.';
  return `Couldn't talk to the board (${m}). Hold BOOT, press RESET, let go of BOOT, then try again.`;
}

function Inner() {
  const { can } = useAuth();
  const canFlash = can('factory.flash');
  const canRegister = can('devices.register');

  const [tab, setTab] = useState<Tab>(canFlash ? 'flash' : 'monitor');
  const [link, setLink] = useState<Link_>('none');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [regSerial, setRegSerial] = useState<string | null>(null); // registered before this session
  const [releases, setReleases] = useState<FactoryRelease[]>([]);
  const [relId, setRelId] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ phase: string; pct: number } | null>(null);
  const [run, setRun] = useState<FactoryRun | null>(null);
  const [paused, setPaused] = useState(false);
  const [reg, setReg] = useState<(StickerData & { id: string }) | null>(null);
  const [hw, setHw] = useState(HW_MODELS[0]);
  const [batch, setBatch] = useState('');
  const [, setTick] = useState(0);
  const [sendLine, setSendLine] = useState('');

  const port = useRef<unknown>(null);        // the picked USB port, reused for every mode
  const conn = useRef<Board | null>(null);   // esptool-js connection while in the bootloader
  const mon = useRef<Monitor | null>(null);  // serial monitor
  const lines = useRef<[string, string][]>([]);
  const partial = useRef('');
  const checker = useRef<Checker | null>(null);
  const t0 = useRef(0);
  const runRef = useRef<FactoryRun | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  runRef.current = run;

  useEffect(() => { setHw(store.get('hwModel', HW_MODELS[0])); setBatch(store.get('batch', '')); }, []);
  useEffect(() => {
    if (canFlash) get<{ items: FactoryRelease[] }>('/admin/factory/releases').then((r) => setReleases(r.items)).catch((e) => setErr(errText(e)));
  }, [canFlash]);

  const sec = () => (performance.now() - t0.current) / 1000;
  const addLine = useCallback((text: string, cls = '') => {
    lines.current.push([text, cls]);
    if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
    if (cls === '' && checker.current) checker.current.feed(text, sec());
  }, []);
  const onSerialText = useCallback((chunk: string) => {
    const parts = (partial.current + chunk).split(/\r?\n/);
    partial.current = parts.pop() || '';
    for (const p of parts) addLine(p);
  }, [addLine]);

  // 4×/s while the monitor runs: apply the time limits and repaint
  useEffect(() => {
    if (link !== 'monitor') return undefined;
    const id = setInterval(() => { checker.current?.tick(sec()); setTick((x) => x + 1); }, 250);
    return () => clearInterval(id);
  }, [link]);
  useEffect(() => { if (!paused && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; });

  const logText = () => lines.current.map((l) => l[0]).join('\n') + (partial.current ? `\n${partial.current}` : '');

  /** Close the bench record of this board: pass if every test passed, fail if one failed, else aborted. */
  const closeRun = useCallback(async (forced?: 'fail' | 'aborted', reason?: string) => {
    const r = runRef.current;
    if (!r || r.result !== 'running') return;
    const c = checker.current;
    const result = forced || (c?.allPassed() ? 'pass' : c?.firstFailed() ? 'fail' : 'aborted');
    try {
      const saved = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, {
        result, checks: c ? c.toList() : [], logTail: logText().slice(-LOG_TAIL),
        ...(result !== 'pass' ? { failReason: reason || c?.firstFailed() || (result === 'aborted' ? 'aborted' : 'manual') } : {}),
      });
      setRun(saved); runRef.current = saved;
    } catch { /* the next board matters more than this record */ }
  }, []);

  // Board unplugged → close the record as aborted and forget the port
  useEffect(() => {
    if (!serialSupported()) return undefined;
    const serial = (navigator as unknown as { serial: EventTarget }).serial;
    const onGone = async () => {
      if (!port.current) return;
      await closeRun('aborted', 'unplugged');
      await mon.current?.close(); mon.current = null; conn.current = null; port.current = null;
      setLink('none'); setBoard(null); setErr('The board was unplugged.');
    };
    serial.addEventListener('disconnect', onGone);
    return () => serial.removeEventListener('disconnect', onGone);
  }, [closeRun]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (runRef.current?.result === 'running') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => () => { mon.current?.close(); if (conn.current) releaseBoard(conn.current); }, []);

  // ---- connection modes ----
  async function enterBoot() {   // esptool connection (needed to flash)
    if (link === 'boot' && conn.current) return conn.current;
    if (mon.current) { await mon.current.close(); mon.current = null; }
    const b = await connectBoard(() => {}, port.current || undefined);
    conn.current = b; port.current = b.port; setLink('boot');
    return b;
  }
  async function enterMonitor(expect: { version: string | null; from: 'flashed' | 'selected' }) {   // plain serial monitor, board running its code
    if (link === 'monitor' && mon.current) return;
    if (conn.current) { await leaveBootloader(conn.current); await releaseBoard(conn.current); conn.current = null; }
    lines.current = []; partial.current = '';
    checker.current = createChecker({ ...expect, mac: board!.mac });
    const m = new Monitor(port.current, onSerialText);
    await m.open(115200);
    mon.current = m;
    t0.current = performance.now();
    await m.reset();
    addLine('--- board reset, watching serial output at 115200 baud ---', 'a');
    setLink('monitor');
  }

  async function connect() {
    setErr(''); setBusy('Reading the board (chip and MAC)…');
    try {
      const b = await connectBoard(() => {});
      conn.current = b; port.current = b.port; setLink('boot');
      setBoard({ chip: b.chip, desc: b.desc, mac: b.mac });
      const h = await get<FactoryRunList>(`/admin/factory/runs${qs({ q: b.mac, limit: 5 })}`).catch(() => null);
      setRegSerial(h?.items.find((r) => r.serial)?.serial || null);
      const mine = releases.filter((r) => r.chipModel === b.chip);
      setRelId((mine.find((r) => r.isDefault) || mine[0])?.id ?? null);
    } catch (e) {
      if (conn.current) await releaseBoard(conn.current);
      conn.current = null; port.current = null;
      setErr(portHint(e));
    } finally { setBusy(''); }
  }

  async function nextBoard() {
    setBusy('Saving…');
    await closeRun();
    await mon.current?.close(); mon.current = null;
    if (conn.current) await releaseBoard(conn.current);
    conn.current = null; port.current = null;
    setLink('none'); setBoard(null); setRegSerial(null); setFlash(null); setRun(null);
    setReg(null); setPaused(false); setErr(''); setBusy('');
    lines.current = []; partial.current = ''; checker.current = null;
  }

  async function newRun(releaseId: number | null) {
    const r = await post<{ run: FactoryRun }>('/admin/factory/runs', { mac: board!.mac, chip: board!.chip, ...(releaseId ? { releaseId } : {}) });
    setRun(r.run); runRef.current = r.run;
    return r.run;
  }

  async function doFlash() {
    const rel = releases.find((r) => r.id === relId);
    if (!rel || !board) return;
    setErr('');
    let r: FactoryRun | null = null;
    const t = performance.now();
    const flashBytes = FLASH_BYTES[rel.factory.flashSize || '4MB'];
    try {
      await closeRun();                       // a new flash starts a new bench record
      setFlash({ phase: 'Connecting…', pct: 0 });
      const b = await enterBoot();
      r = await newRun(rel.id);
      let image = imageCache.get(rel.id);
      if (!image) {
        setFlash({ phase: `Downloading ${rel.version} (${bytes(rel.factory.fileSize)})`, pct: 0 });
        image = await download(rel.id);
        if ((await sha256Hex(image)) !== rel.factory.sha256) throw new Error('The downloaded image is damaged (sha256 mismatch). Try again.');
        imageCache.set(rel.id, image);
      }
      setFlash({ phase: image.length >= flashBytes ? 'Writing (whole flash)' : 'Erasing, then writing', pct: 0 });
      await flashImage(b, image, flashBytes, (w, total) => setFlash({ phase: 'Writing', pct: Math.round((w / total) * 100) }));
      const upd = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, { flashed: true, flashMs: Math.round(performance.now() - t) });
      setRun(upd); runRef.current = upd;
      // flashImage hard-resets the board: free the bootloader connection (the port stays picked)
      await releaseBoard(b); conn.current = null; setLink('off');
      lines.current = []; partial.current = ''; checker.current = null;
      setFlash(null);
    } catch (e) {
      setFlash(null);
      const msg = errText(e);
      if (r) {
        const saved = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, { result: 'fail', failReason: 'flash', notes: msg.slice(0, 500) }).catch(() => null);
        if (saved) { setRun(saved); runRef.current = saved; }
      }
      setErr(`Flash failed: ${msg}. Unplug and replug the board, press Next board, then try again.`);
    }
  }

  async function openMonitor() {
    setErr(''); setBusy('Opening the serial monitor…');
    try {
      // Same board record as the flash just before; otherwise a new "test only" record
      if (!runRef.current || runRef.current.result !== 'running') await newRun(null);
      // Flashed on this screen: must boot that version. Otherwise compare with the release picked on the Flash tab.
      const r = runRef.current;
      await enterMonitor(r?.flashed && r.fwVersion ? { version: r.fwVersion, from: 'flashed' }
        : { version: releases.find((x) => x.id === relId)?.version ?? null, from: 'selected' });
    } catch (e) { setErr(portHint(e)); } finally { setBusy(''); }
  }

  const c = checker.current;
  const anyPassed = !!c && c.toList().some((x) => x.ok === true);
  const tested = !!run?.flashed && anyPassed;   // this board was flashed and tested here

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!board || !canRegister || regSerial || reg) return;
    store.set('hwModel', hw); store.set('batch', batch);
    setBusy('Registering…'); setErr('');
    try {
      // Link the bench record when the board was flashed and tested here (saves the tests so far first)
      if (tested && run?.result === 'running' && c) await patch(`/admin/factory/runs/${run.id}`, { checks: c.toList() });
      const r = await post<RegisterResult>('/admin/devices', {
        mac: board.mac, chip: board.chip, hwModel: hw, batch: batch.trim() || undefined,
        fwOnBoard: run?.flashed ? run.fwVersion || undefined : undefined,
        ...(tested && run ? { factoryRunId: run.id } : {}),
      });
      setReg({ id: r.device.id, serial: r.serial, claimCode: r.claimCode, qrPayload: r.qrPayload, qrPngBase64: r.qrPngBase64, mac: macUpper(board.mac) });
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(''); }
  }

  if (!serialSupported()) {
    return <div className="wrap"><Head title="Manufacturing" />
      <div className="card lock"><Icon name="usb" size={30} /><h2>Use Chrome or Edge on a PC</h2>
        <p>This browser can&apos;t talk to USB (Web Serial). Open this page in Chrome or Edge on the laptop the board is plugged into.</p></div></div>;
  }

  const ck = c?.ck;
  const vals = c?.vals || {};
  const mine = board ? releases.filter((r) => r.chipModel === board.chip) : [];
  const tabs: [Tab, string, boolean][] = [['flash', 'Flash firmware', canFlash], ['monitor', 'Serial monitor & test', true], ['register', 'Register', canRegister]];

  return (
    <div className="wrap">
      <Head title="Manufacturing" sub="Connect a board by USB, then flash it, test it on the serial monitor, or register it." />
      {err && <div className="banner" role="alert"><Icon name="alert" /><span>{err}</span></div>}

      {/* ---------- the board on USB (shared by all three) ---------- */}
      <div className="card" style={{ marginBottom: 18 }}>
        {!board ? <div className="row" style={{ alignItems: 'center', gap: 14 }}>
          <button className="btn" onClick={connect} disabled={!!busy}><Icon name="usb" /> {busy ? 'Reading…' : 'Connect board'}</button>
          <span className="small muted">Plug the board in by USB and pick its port. Close Arduino IDE first. If it fails: hold <b>BOOT</b>, press <b>RESET</b>, let go, try again.</span>
        </div> : <div className="between" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="row small">
            <span className="pill acc"><Icon name="chip" size={14} /> <span className="mono">{board.chip}</span></span>
            <span className="pill"><span className="mono">{macUpper(board.mac)}</span></span>
            {(reg?.serial || regSerial) && <span className="pill warn">Registered as {reg?.serial || regSerial}</span>}
            {run?.flashed && <span className="pill ok"><Icon name="check" size={14} /> Firmware {run.fwVersion} flashed</span>}
            {c && <span className="pill">{c.allPassed() ? 'All tests passed' : c.firstFailed() ? `Test failed: ${CHECKS.find((k) => k.id === c.firstFailed())?.label}` : 'Testing…'}</span>}
          </div>
          <button className="btn ghost sm" onClick={nextBoard} disabled={!!busy || !!flash}>Next board</button>
        </div>}
      </div>

      <div className="seg" role="tablist" style={{ marginBottom: 16 }}>
        {tabs.filter((t) => t[2]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>))}
      </div>

      {/* ---------- Flash firmware ---------- */}
      {tab === 'flash' && (
        <div className="card stack" style={{ gap: 16, maxWidth: 760 }}>
          <h2>Flash firmware</h2>
          {!board ? <p className="small muted">Connect a board first (button above).</p>
            : mine.length ? <>
              <div className="field" style={{ maxWidth: 360 }}><label htmlFor="rel">Firmware</label>
                <select className="inp mono" id="rel" value={relId ?? ''} onChange={(e) => setRelId(Number(e.target.value))} disabled={!!flash}>
                  {mine.map((r) => <option key={r.id} value={r.id}>{r.version} · {r.channel}{r.isDefault ? ' · default' : ''}</option>)}
                </select></div>
              {flash ? <div className="stack" style={{ gap: 8 }}>
                <div className="between small"><b>{flash.phase}</b><span className="num muted">{flash.pct}%</span></div>
                <div className="progress"><i style={{ width: `${flash.pct}%`, background: 'var(--accent)' }} /></div>
                <p className="xs muted">Don&apos;t unplug the board.</p></div>
                : <>
                  <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={doFlash}><Icon name="bolt" /> Erase and flash</button>
                  <p className="xs muted">Writes the whole firmware from address 0x0 and erases saved Wi-Fi and old data. About 30–60 s.</p>
                  {run?.flashed && run.result === 'running' && <div className="banner ok" style={{ margin: 0 }}><Icon name="check" /><span>Flashed {run.fwVersion}. Open <b>Serial monitor &amp; test</b> to check it.</span></div>}
                </>}
            </> : <div className="banner warn" style={{ margin: 0 }}><Icon name="alert" /><span>No firmware for {board.chip} is ready to flash. Upload it on <Link className="link" href="/admin/firmware">Firmware</Link> (the .bin and the merged .bin) and press <b>Make default</b>.</span></div>}
        </div>
      )}

      {/* ---------- Serial monitor & test ---------- */}
      {tab === 'monitor' && (!board ? <div className="card"><p className="small muted">Connect a board first (button above).</p></div>
        : !c || link !== 'monitor' ? <div className="card stack" style={{ gap: 12, maxWidth: 760 }}>
          <h2>Serial monitor &amp; test</h2>
          <p className="small muted">Resets the board and shows its output at 115200 baud. The tests tick by themselves.</p>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={openMonitor} disabled={!!busy || !!flash}>{busy || 'Open serial monitor'}</button>
        </div>
          : ck && <div className="g21">
            <div className="card">
              <div className="ch"><div className="t"><h2>Serial monitor</h2><span className="xs muted">115200 baud</span></div>
                <div className="row" style={{ gap: 6 }}>
                  {paused ? <span className="pill warn">Paused</span> : <span className="pill live"><span className="dot pulse" />Live</span>}
                  <button className="btn ghost sm" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
                  <button className="btn ghost sm" onClick={() => { lines.current = []; setTick((x) => x + 1); }}>Clear</button>
                  <button className="btn ghost sm" onClick={async () => { addLine('--- board reset by operator ---', 'a'); await mon.current?.reset(); }}>Reset board</button>
                </div></div>
              <div className="term big" ref={termRef} aria-label="Serial output">
                {lines.current.map((l, i) => <div key={i} className={l[1]}>{l[0] || ' '}</div>)}
              </div>
              <form className="sendrow" onSubmit={async (e) => { e.preventDefault(); if (!sendLine) return; addLine(`> ${sendLine}`, 'a'); const v = sendLine; setSendLine(''); await mon.current?.write(`${v}\n`); }}>
                <input className="inp mono" value={sendLine} onChange={(e) => setSendLine(e.target.value)} placeholder="Send a line to the board" aria-label="Send a line to the board" />
                <button className="btn ghost" type="submit">Send</button></form>
              <div className="stiles" style={{ marginTop: 14 }}>
                {([['Radar', vals.radar ? <span style={{ color: vals.radar === 'OK' ? 'var(--ok)' : 'var(--warn)' }}>{vals.radar}</span> : '—'],
                  ['Presence', vals.pr === undefined ? '—' : vals.pr ? 'Yes' : 'No'],
                  ['Heart rate', vals.hr ? <>{vals.hr}<small className="xs muted"> bpm</small></> : '—'],
                  ['Breathing', vals.br ? <>{vals.br}<small className="xs muted"> /min</small></> : '—'],
                  ['Free heap', vals.heap ? <>{Math.round(vals.heap / 1024)}<small className="xs muted"> KB</small></> : '—'],
                  ['MQTT', vals.mqtt || '—']] as [string, React.ReactNode][]).map(([l, v]) => (
                  <div className="stile" key={l}><span className="xs muted">{l}</span><b>{v}</b></div>))}
              </div>
            </div>
            <div className="card"><h2 style={{ marginBottom: 6 }}>Tests</h2>
              {CHECKS.map((k) => { const s = ck[k.id]; return (
                <div key={k.id} className={`ck ${s.state === 'ok' ? 'ok' : s.state === 'bad' ? 'bad' : s.state === 'run' ? 'run' : ''}`}>
                  <span className="st">{s.state === 'ok' ? <Icon name="check" size={14} /> : s.state === 'bad' ? '✕' : s.state === 'run' ? <span className="dot pulse" /> : s.state === 'skip' ? '–' : ''}</span>
                  <span className="stack" style={{ gap: 0 }}><b className="small">{k.label}</b><span className="xs muted">{k.id === 'version' && c ? c.versionHint : k.hint}</span></span>
                  {k.id === 'presence' && s.state === 'wait'
                    ? <span className="row" style={{ gap: 4 }}>
                      <button className="btn ghost sm" disabled={ck.radar.state !== 'ok'} title={ck.radar.state !== 'ok' ? 'Waits for the radar link' : ''} onClick={() => c!.startPresence(sec())}>Start</button>
                      <button className="btn ghost sm" onClick={() => c!.skipPresence()}>Skip</button></span>
                    : <span className="v">{s.value}</span>}
                </div>); })}
              <p className="xs muted" style={{ marginTop: 12 }}>The result is saved with the serial log when you press <b>Next board</b>.</p>
            </div>
          </div>)}

      {/* ---------- Register ---------- */}
      {tab === 'register' && (
        <div className="card stack" style={{ gap: 16, maxWidth: 760 }}>
          <h2>Register</h2>
          {!board ? <>
            <p className="small muted">Connect a board first (button above). It reads the MAC and chip over USB.</p>
            <p className="xs muted">Board without USB, or many at once? <Link className="link" href="/admin/register">Type the MAC or upload a CSV</Link>.</p>
          </> : reg ? <>
            <div className="banner ok" style={{ margin: 0 }}><Icon name="check" /><span>Registered <b>{reg.serial}</b>. Print the sticker now: the claim code is shown only once.</span></div>
            <div id="stk-station"><Sticker s={reg} /></div>
            <div className="row"><button className="btn" onClick={() => printStickers(['stk-station'])}>Print sticker</button>
              <button className="btn ghost" onClick={nextBoard}><Icon name="usb" /> Next board</button></div>
          </> : regSerial ? <p className="small muted">This board is already registered as <b>{regSerial}</b>. Reprint its sticker from its device page.</p>
            : <form className="form" onSubmit={register}>
              <p className="small muted">{tested ? 'Flashed and tested here: the test result is saved with the device.' : 'Not flashed and tested here. You can still register it.'}</p>
              <div className="fields2">
                <div className="field"><label htmlFor="st-hw">Hardware model</label>
                  <select className="inp" id="st-hw" value={hw} onChange={(e) => setHw(e.target.value)}>{HW_MODELS.map((m) => <option key={m}>{m}</option>)}</select></div>
                <div className="field"><label htmlFor="st-batch">Batch</label>
                  <input className="inp" id="st-batch" value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={40} placeholder="B-2026-11-A" /></div>
              </div>
              <button className="btn" type="submit" disabled={!!busy} style={{ alignSelf: 'flex-start' }}>{busy || 'Register and make sticker'}</button>
            </form>}
        </div>
      )}
    </div>
  );
}
