'use client';

// Manufacturing (docs/MANUFACTURING.md, API.md §9b): ONE screen for the factory person.
//   Board + code (connect, flash)  ·  Serial log + bench checks  ·  Register + sticker
// Register unlocks as soon as the code is flashed and at least one check has passed (owner, 13 Nov 2026);
// the test can keep running and is finished with Pass / Fail afterwards.
// The browser does all the USB work (Web Serial + esptool-js); the server stores images and results.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { printStickers, Sticker, type StickerData } from '@/components/admin';
import { FLASH_BYTES, macUpper, ResultPill, sha256Hex } from '@/components/factory';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Head } from '@/components/ui';
import { ApiError, errText, get, patch, post, qs, refreshSession } from '@/lib/api';
import { CHECKS, createChecker, type Checker } from '@/lib/checks';
import { ago, bytes } from '@/lib/format';
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

// idle: no board · ready: board in bootloader, choose flash or test · testing: serial monitor running · done: run saved
type Phase = 'idle' | 'ready' | 'testing' | 'done';
interface BoardInfo { chip: string; desc: string; mac: string }
interface Hist { runs: FactoryRun[]; serial: string | null }

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

function Inner() {
  const { can } = useAuth();
  const canFlash = can('factory.flash');
  const canRegister = can('devices.register');

  const [phase, setPhase] = useState<Phase>('idle');
  const [bench, setBench] = useState('Bench 1');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [hist, setHist] = useState<Hist | null>(null);
  const [releases, setReleases] = useState<FactoryRelease[]>([]);
  const [relId, setRelId] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ phase: string; pct: number } | null>(null);
  const [run, setRun] = useState<FactoryRun | null>(null);
  const [note, setNote] = useState('');
  const [paused, setPaused] = useState(false);
  const [reg, setReg] = useState<(StickerData & { id: string }) | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [regErr, setRegErr] = useState('');
  const [hw, setHw] = useState(HW_MODELS[0]);
  const [batch, setBatch] = useState('');
  const [today, setToday] = useState<FactoryRunList | null>(null);
  const [, setTick] = useState(0);
  const [sendLine, setSendLine] = useState('');

  const conn = useRef<Board | null>(null);   // esptool-js connection while in the bootloader
  const mon = useRef<Monitor | null>(null);  // serial monitor while testing
  const lines = useRef<[string, string][]>([]);
  const partial = useRef('');
  const checker = useRef<Checker | null>(null);
  const t0 = useRef(0);
  const runRef = useRef<FactoryRun | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  runRef.current = run;

  useEffect(() => {
    setBench(store.get('bench', 'Bench 1'));
    setHw(store.get('hwModel', HW_MODELS[0]));
    setBatch(store.get('batch', ''));
  }, []);
  useEffect(() => {
    if (canFlash) get<{ items: FactoryRelease[] }>('/admin/factory/releases').then((r) => setReleases(r.items)).catch((e) => setErr(errText(e)));
  }, [canFlash]);

  const loadToday = useCallback(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    get<FactoryRunList>(`/admin/factory/runs${qs({ limit: 8, station: bench, from: from.toISOString() })}`).then(setToday).catch(() => {});
  }, [bench]);
  useEffect(() => { loadToday(); }, [loadToday]);

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

  // 4×/s while testing: apply the time limits and repaint
  useEffect(() => {
    if (phase !== 'testing') return undefined;
    const id = setInterval(() => { checker.current?.tick(sec()); setTick((x) => x + 1); }, 250);
    return () => clearInterval(id);
  }, [phase]);
  useEffect(() => { if (!paused && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; });

  const logText = () => lines.current.map((l) => l[0]).join('\n') + (partial.current ? `\n${partial.current}` : '');

  const finish = useCallback(async (result: 'pass' | 'fail' | 'aborted', reason?: string) => {
    const r = runRef.current;
    if (!r || r.result !== 'running') return;
    const c = checker.current;
    const body = {
      result,
      checks: c ? c.toList() : [],
      logTail: logText().slice(-LOG_TAIL),
      ...(note.trim() ? { notes: note.trim() } : {}),
      ...(result !== 'pass' ? { failReason: reason || c?.firstFailed() || (result === 'aborted' ? 'aborted' : 'manual') } : {}),
    };
    setBusy('Saving…');
    try {
      const saved = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, body);
      setRun(saved); runRef.current = saved;
      await mon.current?.close(); mon.current = null;
      setPhase('done');
      loadToday();
    } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, loadToday]);

  // Board unplugged during a run → saved as aborted
  useEffect(() => {
    if (!serialSupported()) return undefined;
    const serial = (navigator as unknown as { serial: EventTarget }).serial;
    const onGone = () => { if (runRef.current?.result === 'running') finish('aborted', 'unplugged'); };
    serial.addEventListener('disconnect', onGone);
    return () => serial.removeEventListener('disconnect', onGone);
  }, [finish]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (runRef.current?.result === 'running') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => () => { mon.current?.close(); if (conn.current) releaseBoard(conn.current); }, []);

  async function nextBoard() {
    if (runRef.current?.result === 'running') await finish('aborted', 'operator');
    await mon.current?.close();
    if (conn.current) await releaseBoard(conn.current);
    setPhase('idle'); setBoard(null); setHist(null); setFlash(null); setRun(null); setNote('');
    setReg(null); setRegErr(''); setPaused(false); setErr('');
    lines.current = []; partial.current = ''; checker.current = null; conn.current = null; mon.current = null;
    loadToday();
  }

  async function connect() {
    setErr(''); setBusy('Reading the board: bootloader mode, chip and MAC…');
    store.set('bench', bench);
    try {
      const b = await connectBoard(() => {});
      conn.current = b;
      setBoard({ chip: b.chip, desc: b.desc, mac: b.mac });
      const h = await get<FactoryRunList>(`/admin/factory/runs${qs({ q: b.mac, limit: 5 })}`).catch(() => null);
      setHist(h ? { runs: h.items, serial: h.items.find((r) => r.serial)?.serial || null } : null);
      const mine = releases.filter((r) => r.chipModel === b.chip);
      setRelId((mine.find((r) => r.isDefault) || mine[0])?.id ?? null);
      setPhase('ready');
    } catch (e) {
      if (conn.current) await releaseBoard(conn.current);
      conn.current = null;
      const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setErr(/NotFoundError|No port selected/i.test(m) ? 'No port was picked. Press Connect again and choose the board (often “USB Serial”, “CP210x” or “CH340”).'
        : /already open|Failed to open|InvalidStateError|NetworkError/i.test(m) ? 'The port is busy. Close Arduino IDE or any serial monitor, unplug and replug the board, then try again.'
          : `Couldn't read the board (${m}). Hold BOOT, press RESET, let go of BOOT, then try again.`);
    } finally { setBusy(''); }
  }

  async function startRun(releaseId: number | null) {
    const r = await post<{ run: FactoryRun }>('/admin/factory/runs', { mac: board!.mac, chip: board!.chip, station: bench || undefined, ...(releaseId ? { releaseId } : {}) });
    setRun(r.run); runRef.current = r.run;
    return r.run;
  }

  async function startMonitor(flashedVersion: string | null) {
    const port = conn.current!.port;
    await releaseBoard(conn.current!);
    conn.current = null;
    lines.current = []; partial.current = '';
    checker.current = createChecker({ version: flashedVersion, mac: board!.mac });
    const m = new Monitor(port, onSerialText);
    await m.open(115200);
    mon.current = m;
    t0.current = performance.now();
    await m.reset();
    addLine('--- board reset, watching serial output at 115200 baud ---', 'a');
    setPhase('testing');
  }

  async function doFlash() {
    const rel = releases.find((r) => r.id === relId);
    if (!rel || !board) return;
    setErr('');
    const flog: string[] = [];
    let r: FactoryRun | null = null;
    const t = performance.now();
    const flashBytes = FLASH_BYTES[rel.factory.flashSize || '4MB'];
    try {
      r = await startRun(rel.id);
      let image = imageCache.get(rel.id);
      if (!image) {
        setFlash({ phase: `Downloading ${rel.version} (${bytes(rel.factory.fileSize)})`, pct: 0 });
        image = await download(rel.id);
        if ((await sha256Hex(image)) !== rel.factory.sha256) throw new Error('The downloaded image is damaged (sha256 mismatch). Try again.');
        imageCache.set(rel.id, image);
      }
      flog.push(`image ${rel.version}: ${image.length} bytes, sha256 OK`);
      setFlash({ phase: image.length >= flashBytes ? 'Writing (whole flash)' : 'Erasing, then writing', pct: 0 });
      await flashImage(conn.current!, image, flashBytes, (w, total) => setFlash({ phase: 'Writing', pct: Math.round((w / total) * 100) }));
      const ms = Math.round(performance.now() - t);
      flog.push(`flashed in ${(ms / 1000).toFixed(1)} s, hard reset`);
      const upd = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, { flashed: true, flashMs: ms });
      setRun(upd); runRef.current = upd;
      setFlash(null);
      await startMonitor(rel.version);
    } catch (e) {
      setFlash(null);
      const msg = errText(e);
      if (r) {
        const saved = await patch<FactoryRun>(`/admin/factory/runs/${r.id}`, { result: 'fail', failReason: 'flash', notes: msg.slice(0, 500), logTail: flog.join('\n') }).catch(() => null);
        if (saved) { setRun(saved); runRef.current = saved; }
      }
      if (conn.current) await releaseBoard(conn.current);
      conn.current = null;
      setPhase('done');
      setErr(`Flash failed: ${msg}. Unplug and reconnect the board, then press Next board and try again.`);
    }
  }

  async function testOnly() {
    setErr('');
    try {
      await startRun(null);
      await leaveBootloader(conn.current!);
      await startMonitor(null);
    } catch (e) { setErr(errText(e)); }
  }

  const c = checker.current;
  const anyPassed = !!c && c.toList().some((x) => x.ok === true);
  const flashed = !!run?.flashed;
  const registered = reg?.serial || hist?.serial || null;
  const canReg = canRegister && flashed && anyPassed && !registered;

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!board || !run || !canReg) return;
    store.set('hwModel', hw); store.set('batch', batch);
    setRegBusy(true); setRegErr('');
    try {
      // Save the checks so far: the server checks "flashed + at least one passed" on the run itself.
      if (run.result === 'running' && c) await patch(`/admin/factory/runs/${run.id}`, { checks: c.toList() });
      const r = await post<RegisterResult>('/admin/devices', {
        mac: board.mac, chip: board.chip, hwModel: hw, batch: batch.trim() || undefined,
        fwOnBoard: run.fwVersion || undefined, factoryRunId: run.id,
      });
      setReg({ id: r.device.id, serial: r.serial, claimCode: r.claimCode, qrPayload: r.qrPayload, qrPngBase64: r.qrPngBase64, mac: macUpper(board.mac) });
      loadToday();
    } catch (ex) { setRegErr(errText(ex)); } finally { setRegBusy(false); }
  }

  if (!serialSupported()) {
    return <div className="wrap"><Head title="Manufacturing" />
      <div className="card lock"><Icon name="usb" size={30} /><h2>Use Chrome or Edge on a PC</h2>
        <p>This browser can&apos;t talk to USB serial ports (Web Serial). Open this page in Chrome or Edge on the bench PC.</p></div></div>;
  }

  const ck = c?.ck;
  const vals = c?.vals || {};
  const mine = board ? releases.filter((r) => r.chipModel === board.chip) : [];
  const req = (ok: boolean, text: string) => <span className={`small ${ok ? '' : 'muted'}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <span style={{ color: ok ? 'var(--ok)' : 'var(--muted)', display: 'inline-flex' }}>{ok ? <Icon name="check" size={16} /> : '○'}</span>{text}</span>;

  return (
    <div className="wrap">
      <Head title="Manufacturing" sub="Flash the code, watch the serial log and register the board, all on this screen. One board at a time."
        actions={phase !== 'idle' && <button className="btn ghost" onClick={nextBoard} disabled={!!busy || !!flash}><Icon name="usb" /> Next board</button>} />
      {err && <div className="banner" role="alert"><Icon name="alert" /><span>{err}</span></div>}

      {/* ---------- 1 · Board and code ---------- */}
      <div className="card stack" style={{ gap: 14, marginBottom: 18 }}>
        <div className="between"><h2>1 · Board and code</h2>{board && <span className="xs muted mono">{board.desc}</span>}</div>
        {!board ? <>
          <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
            <div className="field" style={{ width: 200 }}><label htmlFor="bench">This bench</label>
              <input className="inp" id="bench" value={bench} onChange={(e) => setBench(e.target.value)} maxLength={40} /></div>
            <button className="btn" onClick={connect} disabled={!!busy}><Icon name="usb" /> {busy ? 'Reading…' : 'Connect board'}</button>
          </div>
          {busy && <div className="note"><span className="dot pulse" style={{ color: 'var(--live)', marginTop: 6 }} /><span>{busy}</span></div>}
          <p className="xs muted">Plug the board in by USB and pick its port. Close Arduino IDE or any serial monitor first. If it fails: hold <b>BOOT</b>, press <b>RESET</b>, let go of BOOT, then try again.</p>
        </> : <>
          <div className="row small">
            <span className="pill acc"><Icon name="chip" size={14} /> <span className="mono">{board.chip}</span></span>
            <span className="pill"><span className="mono">{macUpper(board.mac)}</span></span>
            {hist && (hist.serial ? <span className="pill warn">Already registered as {hist.serial}</span>
              : hist.runs.length ? <span className="pill warn">Tested {hist.runs.length}× before, last {hist.runs[0].result.toUpperCase()}{hist.runs[0].failReason ? ` (${hist.runs[0].failReason})` : ''}</span>
                : <span className="pill ok">New board</span>)}
            {run?.flashed && <span className="pill ok"><Icon name="check" size={14} /> Flashed {run.fwVersion}{run.flashMs ? ` in ${Math.round(run.flashMs / 1000)} s` : ''}</span>}
            {run && !run.flashed && phase !== 'ready' && <span className="pill">Not flashed (test only)</span>}
          </div>
          {phase === 'ready' && <>
            {canFlash ? (mine.length ? <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
              <div className="field" style={{ minWidth: 260 }}><label htmlFor="rel">Code to flash</label>
                <select className="inp mono" id="rel" value={relId ?? ''} onChange={(e) => setRelId(Number(e.target.value))} disabled={!!flash}>
                  {mine.map((r) => <option key={r.id} value={r.id}>{r.version} · {r.channel}{r.isDefault ? ' · default' : ''}</option>)}
                </select></div>
              {!flash && <button className="btn" onClick={doFlash}><Icon name="bolt" /> Erase and flash</button>}
              {!flash && <button className="btn ghost" onClick={testOnly}>Skip, test only</button>}
            </div> : <div className="row"><div className="banner warn" style={{ margin: 0 }}><Icon name="alert" /><span>No factory image for {board.chip} yet. An admin adds one on the Firmware screen.</span></div>
              <button className="btn ghost" onClick={testOnly}>Test only</button></div>)
              : <div className="row"><span className="xs muted">Flashing needs the factory.flash permission.</span><button className="btn ghost" onClick={testOnly}>Test only</button></div>}
            {!flash && <p className="xs muted">Flashing writes the whole image from 0x0 (bootloader, partitions, app) and erases saved Wi-Fi and old data.</p>}
          </>}
          {flash && <div className="stack" style={{ gap: 8 }}>
            <div className="between small"><b>{flash.phase}</b><span className="num muted">{flash.pct}%</span></div>
            <div className="progress"><i style={{ width: `${flash.pct}%`, background: 'var(--accent)' }} /></div>
            <p className="xs muted">Don&apos;t unplug the board.</p></div>}
        </>}
      </div>

      <div className="g21">
        {/* ---------- 2 · Serial log ---------- */}
        <div className="stack" style={{ gap: 18 }}>
          <div className="card">
            <div className="ch"><div className="t"><h2>2 · Serial log</h2><span className="xs muted">115200 baud{run ? ` · ${run.flashed ? `flashed ${run.fwVersion}` : 'not flashed'}` : ''}</span></div>
              {phase === 'testing' && <div className="row" style={{ gap: 6 }}>
                {paused ? <span className="pill warn">Paused</span> : <span className="pill live"><span className="dot pulse" />Live</span>}
                <button className="btn ghost sm" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
                <button className="btn ghost sm" onClick={() => { lines.current = []; setTick((x) => x + 1); }}>Clear</button>
                <button className="btn ghost sm" onClick={async () => { addLine('--- board reset by operator ---', 'a'); await mon.current?.reset(); }}>Reset board</button>
              </div>}</div>
            <div className="term big" ref={termRef} aria-label="Serial output">
              {lines.current.length ? lines.current.map((l, i) => <div key={i} className={l[1]}>{l[0] || ' '}</div>)
                : <div className="m">{phase === 'idle' ? 'Connect a board to start.' : phase === 'ready' ? 'Flash the code (or test only) and the board’s output appears here.' : 'No output.'}</div>}
            </div>
            {phase === 'testing' && <form className="sendrow" onSubmit={async (e) => { e.preventDefault(); if (!sendLine) return; addLine(`> ${sendLine}`, 'a'); const v = sendLine; setSendLine(''); await mon.current?.write(`${v}\n`); }}>
              <input className="inp mono" value={sendLine} onChange={(e) => setSendLine(e.target.value)} placeholder="Send a line to the board" aria-label="Send a line to the board" />
              <button className="btn ghost" type="submit">Send</button></form>}
            {c && <div className="stiles" style={{ marginTop: 14 }}>
              {([['Radar', vals.radar ? <span style={{ color: vals.radar === 'OK' ? 'var(--ok)' : 'var(--warn)' }}>{vals.radar}</span> : '—'],
                ['Presence', vals.pr === undefined ? '—' : vals.pr ? 'Yes' : 'No'],
                ['Heart rate', vals.hr ? <>{vals.hr}<small className="xs muted"> bpm</small></> : '—'],
                ['Breathing', vals.br ? <>{vals.br}<small className="xs muted"> /min</small></> : '—'],
                ['Free heap', vals.heap ? <>{Math.round(vals.heap / 1024)}<small className="xs muted"> KB</small></> : '—'],
                ['MQTT', vals.mqtt || '—']] as [string, React.ReactNode][]).map(([l, v]) => (
                <div className="stile" key={l}><span className="xs muted">{l}</span><b>{v}</b></div>))}
            </div>}
          </div>
          <div className="card">
            <div className="ch"><div className="t"><h2>{bench || 'This bench'} today</h2>
              {today && <span className="xs muted">{today.summary.pass} passed · {today.summary.fail} failed</span>}</div>
              {can('devices.view') && <Link className="link small" href="/admin/factory">Factory log</Link>}</div>
            {today?.items.length ? today.items.map((r) => (
              <div key={r.id} className="between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="stack" style={{ gap: 0 }}><span className="mono small">{macUpper(r.mac)}</span>
                  <span className="xs muted">{ago(r.startedAt)} · {r.serial || 'not registered'}</span></span>
                <ResultPill r={r} />
              </div>)) : <p className="small muted">No boards yet today.</p>}
          </div>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          {/* ---------- 3 · Checks ---------- */}
          <div className="card"><div className="between" style={{ marginBottom: 6 }}><h2>3 · Checks</h2>{run && run.result !== 'running' && <ResultPill r={run} />}</div>
            {CHECKS.map((k) => { const s = ck?.[k.id]; const state = s?.state || 'wait'; return (
              <div key={k.id} className={`ck ${state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : state === 'run' && phase === 'testing' ? 'run' : ''}`}>
                <span className="st">{state === 'ok' ? <Icon name="check" size={14} /> : state === 'bad' ? '✕' : state === 'run' && phase === 'testing' ? <span className="dot pulse" /> : state === 'skip' ? '–' : ''}</span>
                <span className="stack" style={{ gap: 0 }}><b className="small">{k.label}</b><span className="xs muted">{k.hint}</span></span>
                {k.id === 'presence' && state === 'wait' && phase === 'testing' && c
                  ? <span className="row" style={{ gap: 4 }}>
                    <button className="btn ghost sm" disabled={ck?.radar.state !== 'ok'} title={ck?.radar.state !== 'ok' ? 'Waits for the radar link' : ''} onClick={() => c.startPresence(sec())}>Start</button>
                    <button className="btn ghost sm" onClick={() => c.skipPresence()}>Skip</button></span>
                  : <span className="v">{s?.value}</span>}
              </div>); })}
            {phase === 'testing' && c && <div className="stack" style={{ gap: 12, marginTop: 14 }}>
              <div className="field"><label htmlFor="note">Note (optional)</label>
                <input className="inp" id="note" placeholder="e.g. radar cable loose" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
              {c.firstFailed() && <div className="banner" style={{ margin: 0 }}><Icon name="alert" /><span>Failed: {CHECKS.find((k) => k.id === c.firstFailed())?.label}.</span></div>}
              <div className="row">
                <button className="btn" disabled={!c.allPassed() || !!busy} onClick={() => finish('pass')}><Icon name="check" /> Pass</button>
                <button className="btn danger" disabled={!!busy} onClick={() => finish('fail')}>Fail</button>
                <button className="btn ghost" disabled={!!busy} onClick={() => finish('aborted', 'operator')}>Abort</button>
              </div>
            </div>}
          </div>

          {/* ---------- 4 · Register ---------- */}
          <div className="card stack" style={{ gap: 12 }}>
            <h2>4 · Register</h2>
            {reg ? <>
              <div className="banner ok" style={{ margin: 0 }}><Icon name="check" /><span>Registered <b>{reg.serial}</b>. The claim code is shown only now: print the sticker.</span></div>
              <div id="stk-station"><Sticker s={reg} /></div>
              <div className="row"><button className="btn" onClick={() => printStickers(['stk-station'])}>Print sticker</button>
                <Link className="btn ghost" href={`/admin/devices/${reg.id}`}>Open device</Link></div>
              {run?.result === 'running' && <p className="xs muted">The test is still running. Finish it with Pass or Fail, then press Next board.</p>}
            </> : hist?.serial ? <p className="small muted">This board is already registered as <b>{hist.serial}</b>. Reprint its sticker from the device page.</p>
              : !canRegister ? <p className="small muted">Registering needs the devices.register permission.</p> : <>
                <div className="stack" style={{ gap: 6 }}>
                  {req(flashed, 'Code flashed on this bench')}
                  {req(anyPassed, 'At least one check passed')}
                </div>
                <form className="form" onSubmit={register}>
                  <div className="fields2">
                    <div className="field"><label htmlFor="st-hw">Hardware model</label>
                      <select className="inp" id="st-hw" value={hw} onChange={(e) => setHw(e.target.value)}>{HW_MODELS.map((m) => <option key={m}>{m}</option>)}</select></div>
                    <div className="field"><label htmlFor="st-batch">Batch</label>
                      <input className="inp" id="st-batch" value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={40} placeholder="B-2026-11-A" /></div>
                  </div>
                  {regErr && <p className="err" role="alert">{regErr}</p>}
                  <button className="btn" type="submit" disabled={!canReg || regBusy}>{regBusy ? 'Registering…' : 'Register and make sticker'}</button>
                </form>
                <p className="xs muted">Board without USB, or many at once? <Link className="link" href="/admin/register">Type the MAC or upload a CSV</Link>.</p>
              </>}
          </div>
        </div>
      </div>
    </div>
  );
}
