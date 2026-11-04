'use client';

// Register devices (API.md 8.4). Three ways in:
// - USB: Web Serial + esptool-js reads the chip and MAC from the ROM bootloader, then hard-resets.
//   NOTHING is written to the board (MAC-only MQTT login, so there is no secret to flash).
// - Type the MAC (e.g. from a label), or
// - CSV bulk: one board per line.
// Each registration returns the serial + claim code once; we show printable QR stickers (ARG1:<code>).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { printStickers, Sticker, type StickerData } from '@/components/admin';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { errText, post, qs } from '@/lib/api';
import { timeIn, browserTz } from '@/lib/format';
import type { AdminDeviceRow, List, RegisterResult } from '@/lib/types';

const CHIPS = ['ESP32-S3', 'ESP32', 'ESP32-C3', 'ESP32-C6', 'ESP8266'];
const HW_MODELS = ['ARG-S1 rev B', 'ARG-S1 rev A'];
const todayIso = () => new Date().toISOString().slice(0, 10);

/** "3485 18a1 0f22", "34-85-18-A1-0F-22" → "34:85:18:A1:0F:22"; null if it isn't 12 hex digits. */
function normMac(s: string): string | null {
  const h = s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return h.length === 12 ? h.match(/../g)!.join(':') : null;
}

interface Details { mac: string; chip: string; hwModel: string; batch: string; manufacturedAt: string; fwOnBoard: string }
type Done = StickerData & { id: string };

export default function RegisterPage() {
  return <RequireStaff perm="devices.register"><Inner /></RequireStaff>;
}

function Inner() {
  const [mode, setMode] = useState<'usb' | 'type' | 'csv'>('usb');
  const [reload, setReload] = useState(0);
  return (
    <div className="wrap narrow">
      <Head title="Register devices" sub="Read a new sensor's MAC and chip, register it, then print its QR sticker." />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={mode === 'usb'} className={mode === 'usb' ? 'on' : ''} onClick={() => setMode('usb')}><Icon name="usb" size={16} /> USB</button>
        <button role="tab" aria-selected={mode === 'type'} className={mode === 'type' ? 'on' : ''} onClick={() => setMode('type')}>Type MAC</button>
        <button role="tab" aria-selected={mode === 'csv'} className={mode === 'csv' ? 'on' : ''} onClick={() => setMode('csv')}>CSV (many)</button>
      </div>
      {mode === 'csv' ? <Bulk onDone={() => setReload((n) => n + 1)} /> : <Single key={mode} usb={mode === 'usb'} onDone={() => setReload((n) => n + 1)} />}
      <Today key={reload} />
    </div>
  );
}

/* ---------------- one device: USB read or typed MAC ---------------- */

function Single({ usb, onDone }: { usb: boolean; onDone(): void }) {
  const toast = useToast();
  const [step, setStep] = useState(usb ? 1 : 2);
  const [reading, setReading] = useState(false);
  const [log, setLog] = useState('');
  const [readErr, setReadErr] = useState('');
  const [chipDesc, setChipDesc] = useState('');
  const [f, setF] = useState<Details>({ mac: '', chip: 'ESP32-S3', hwModel: HW_MODELS[0], batch: '', manufacturedAt: todayIso(), fwOnBoard: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const read = async () => {
    setReadErr(''); setLog(''); setReading(true);
    try {
      const r = await readBoard((line) => setLog((l) => (l + line + '\n').slice(-4000)));
      setF((x) => ({ ...x, mac: r.mac, chip: r.chip }));
      setChipDesc(r.description);
      setStep(2);
    } catch (e) { setReadErr(serialHint(e)); } finally { setReading(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const mac = normMac(f.mac);
    if (!mac) return setErr('The MAC must be 12 hex digits, e.g. 34:85:18:A1:0F:22');
    setErr(''); setBusy(true);
    try {
      const r = await post<RegisterResult>('/admin/devices', {
        mac, chip: f.chip, hwModel: f.hwModel, batch: f.batch.trim() || undefined,
        manufacturedAt: f.manufacturedAt || undefined, fwOnBoard: f.fwOnBoard.trim() || undefined,
      });
      setDone({ id: r.device.id, serial: r.serial, claimCode: r.claimCode, qrPayload: r.qrPayload, qrPngBase64: r.qrPngBase64, mac });
      setStep(3); onDone(); toast(`Registered ${r.serial}`);
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  const again = () => { setDone(null); setF((x) => ({ ...x, mac: '' })); setLog(''); setStep(usb ? 1 : 2); };

  const st = (n: number, l: string) => <span className={`s ${step === n ? 'on' : step > n ? 'done' : ''}`}><b>{step > n ? <Icon name="check" size={14} /> : n}</b>{l}</span>;
  return <>
    <div className="stepper">{usb && st(1, 'Connect')}{st(2, 'Details')}{st(3, 'Sticker')}</div>
    {step === 1 && (
      <div className="card stack" style={{ gap: 16 }}>
        <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', gap: 14 }}>
          <div className="avatar" style={{ borderRadius: 12 }}><Icon name="usb" /></div>
          <div className="stack" style={{ gap: 4 }}><h2>Connect the board</h2>
            <p className="small muted">Works in Chrome or Edge on a laptop. <b>Close Arduino IDE</b> or any serial monitor first, because only one program can open the port. Nothing is written to the board.</p></div>
        </div>
        {reading && <div className="note"><span className="dot pulse" style={{ color: 'var(--live)', marginTop: 6 }} /><span>Reading board… resetting into the bootloader, reading the chip and MAC, then resetting back.</span></div>}
        {readErr && <div className="banner" role="alert"><Icon name="alert" /><span>{readErr}</span></div>}
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={read} disabled={reading}><Icon name="usb" /> {reading ? 'Reading…' : 'Connect over USB'}</button>
        <p className="xs muted">If it fails: hold <b>BOOT</b>, press <b>RESET</b>, let go of BOOT, then try again. Some boards need a USB driver (CP210x or CH340).</p>
        {log && <div className="term" aria-label="Serial log">{log}</div>}
      </div>
    )}
    {step === 2 && (
      <div className="card">
        {usb && <div className="banner ok" style={{ marginBottom: 16 }}><Icon name="check" /><span>Board read. MAC <b className="mono">{f.mac}</b> · chip <b className="mono">{chipDesc || f.chip}</b></span></div>}
        <form className="form" onSubmit={submit}>
          <div className="fields2">
            <div className="field"><label htmlFor="rg-mac">MAC address</label><input className="inp mono" id="rg-mac" value={f.mac} readOnly={usb} onChange={(e) => setF({ ...f, mac: e.target.value.toUpperCase() })} placeholder="34:85:18:A1:0F:22" autoComplete="off" />
              {!usb && <span className="hint">The base (Wi-Fi station) MAC. Colons optional.</span>}</div>
            <div className="field"><label htmlFor="rg-chip">Chip</label>
              {usb ? <input className="inp mono" id="rg-chip" value={f.chip} readOnly />
                : <select className="inp mono" id="rg-chip" value={f.chip} onChange={(e) => setF({ ...f, chip: e.target.value })}>{CHIPS.map((c) => <option key={c}>{c}</option>)}</select>}</div>
            <div className="field"><label htmlFor="rg-hw">Hardware model</label><select className="inp" id="rg-hw" value={f.hwModel} onChange={(e) => setF({ ...f, hwModel: e.target.value })}>{HW_MODELS.map((h) => <option key={h}>{h}</option>)}</select></div>
            <div className="field"><label htmlFor="rg-batch">Batch (optional)</label><input className="inp" id="rg-batch" value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })} placeholder="B-2026-11-A" /></div>
            <div className="field"><label htmlFor="rg-date">Made on</label><input className="inp" type="date" id="rg-date" value={f.manufacturedAt} onChange={(e) => setF({ ...f, manufacturedAt: e.target.value })} /></div>
            <div className="field"><label htmlFor="rg-fw">Firmware on board (optional)</label><input className="inp mono" id="rg-fw" value={f.fwOnBoard} onChange={(e) => setF({ ...f, fwOnBoard: e.target.value })} placeholder="1.4.2" /><span className="hint">The bootloader can&apos;t report this; the sensor sends it once online.</span></div>
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register and make sticker'}</button>
            {usb && <button className="btn ghost" type="button" onClick={again}>Start over</button>}</div>
        </form>
      </div>
    )}
    {step === 3 && done && (
      <div className="card stack" style={{ gap: 16 }}>
        <div className="stack" style={{ gap: 4 }}><h2>Registered {done.serial}</h2><p className="small muted">Print the sticker and put it on the back of the sensor. The customer scans it to add the device. The claim code is shown only now.</p></div>
        <div id="stk-single"><Sticker s={done} /></div>
        <p className="xs muted">QR content: <span className="mono">{done.qrPayload}</span></p>
        <div className="row">
          <button className="btn" onClick={() => printStickers(['stk-single'])}>Print sticker</button>
          <button className="btn ghost" onClick={again}><Icon name={usb ? 'usb' : 'plus'} /> Register the next one</button>
          <Link className="btn ghost" href={`/admin/devices/${done.id}`}>Open device</Link>
        </div>
      </div>
    )}
  </>;
}

/* ---------------- Web Serial + esptool-js ---------------- */

async function readBoard(out: (line: string) => void): Promise<{ mac: string; chip: string; description: string }> {
  const serial = (navigator as unknown as { serial?: { requestPort(): Promise<unknown> } }).serial;
  if (!serial) throw new Error('NO_SERIAL');
  const port = await serial.requestPort(); // the browser shows its port picker
  // Loaded only here: esptool-js is large and only this screen needs it.
  const { ESPLoader, Transport } = await import('esptool-js');
  const transport = new Transport(port as never, false);
  const terminal = { clean() {}, writeLine: (d: string) => out(d), write: (d: string) => out(d) };
  const loader = new ESPLoader({ transport, baudrate: 115200, terminal });
  try {
    await loader.detectChip('default_reset');
    const chip = loader.chip.CHIP_NAME;
    let description = chip;
    try { description = await loader.chip.getChipDescription(loader); } catch { /* secure download mode */ }
    const mac = normMac(await loader.chip.readMac(loader));
    if (!mac) throw new Error('Could not read the MAC address');
    out(`MAC: ${mac}`);
    try { await loader.after('hard_reset'); out('Hard reset: the board is running its firmware again.'); } catch { /* board may already have reset */ }
    return { mac, chip, description };
  } finally {
    try { await transport.disconnect(); } catch { /* already closed */ }
  }
}

function serialHint(e: unknown): string {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/NO_SERIAL/.test(m)) return 'This browser has no Web Serial. Use Chrome or Edge on a laptop, or type the MAC instead.';
  if (/NotFoundError|No port selected/i.test(m)) return 'No port was picked. Click Connect again and choose the board (often “USB Serial” or “CP210x”).';
  if (/NetworkError|Failed to open|already open|InvalidStateError/i.test(m)) return 'The port is busy. Close Arduino IDE, PlatformIO or any serial monitor, unplug and replug the board, then try again.';
  if (/timeout|Timed out|Failed to connect|wrong boot mode/i.test(m)) return 'The board did not answer. Hold BOOT, press RESET, let go of BOOT, then try again.';
  return `Could not read the board (${m}). Hold BOOT and press RESET, then try again.`;
}

/* ---------------- CSV bulk ---------------- */

interface BulkRow { line: number; mac: string; chip: string; hwModel: string; batch?: string; manufacturedAt?: string; fwOnBoard?: string }
type BulkResult = { row: BulkRow; ok: true; s: Done } | { row: BulkRow; ok: false; error: string };

function parseCsv(text: string): { rows: BulkRow[]; errors: string[] } {
  const rows: BulkRow[] = [], errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const c = line.split(/[,;\t]/).map((x) => x.trim());
    if (i === 0 && /mac/i.test(c[0])) return; // header row
    const mac = normMac(c[0] || '');
    if (!mac) return errors.push(`Line ${i + 1}: “${c[0]}” is not a MAC address`);
    const chip = c[1] || 'ESP32-S3';
    rows.push({ line: i + 1, mac, chip, hwModel: c[2] || HW_MODELS[0], batch: c[3] || undefined, manufacturedAt: c[4] || undefined, fwOnBoard: c[5] || undefined });
  });
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.mac)) errors.push(`Line ${r.line}: ${r.mac} appears twice`); seen.add(r.mac); }
  return { rows, errors };
}

function Bulk({ onDone }: { onDone(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<BulkResult[]>([]);
  const parsed = parseCsv(text);

  const run = async () => {
    setBusy(true); setResults([]); setProgress(0);
    const out: BulkResult[] = [];
    // One request per board: there is no bulk endpoint, and this keeps each serial under the server's lock.
    for (const row of parsed.rows) {
      try {
        const r = await post<RegisterResult>('/admin/devices', { mac: row.mac, chip: row.chip, hwModel: row.hwModel, batch: row.batch, manufacturedAt: row.manufacturedAt, fwOnBoard: row.fwOnBoard });
        out.push({ row, ok: true, s: { id: r.device.id, serial: r.serial, claimCode: r.claimCode, qrPayload: r.qrPayload, qrPngBase64: r.qrPngBase64, mac: row.mac } });
      } catch (e) { out.push({ row, ok: false, error: errText(e) }); }
      setProgress(out.length); setResults([...out]);
    }
    setBusy(false); onDone();
  };
  const ok = results.filter((r): r is Extract<BulkResult, { ok: true }> => r.ok);

  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 4 }}><h2>Register many at once</h2>
        <p className="small muted">One board per line: <span className="mono">mac, chip, hwModel, batch, madeOn, fw</span>. Only the MAC is required (chip defaults to ESP32-S3). A header line is fine.</p></div>
      <div className="field"><label htmlFor="csv-file">CSV file</label>
        <input className="inp" type="file" id="csv-file" accept=".csv,text/csv,text/plain" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} /></div>
      <div className="field"><label htmlFor="csv-text">Or paste the lines</label>
        <textarea className="inp mono" id="csv-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'mac,chip,hwModel,batch\n34:85:18:A1:20:01,ESP32-S3,ARG-S1 rev B,B-2026-11-A\n348518A12002'} /></div>
      {parsed.errors.length > 0 && <div className="banner warn"><Icon name="alert" /><span>{parsed.errors.slice(0, 5).join(' · ')}{parsed.errors.length > 5 ? ` · and ${parsed.errors.length - 5} more` : ''}</span></div>}
      <div className="row">
        <button className="btn" onClick={run} disabled={busy || !parsed.rows.length || parsed.errors.length > 0}>{busy ? `Registering ${progress} of ${parsed.rows.length}…` : `Register ${parsed.rows.length || ''} device${parsed.rows.length === 1 ? '' : 's'}`}</button>
        {ok.length > 0 && !busy && <button className="btn ghost" onClick={() => printStickers(ok.map((r) => `stk-${r.s.id}`))}>Print {ok.length} sticker{ok.length === 1 ? '' : 's'}</button>}
      </div>
      {results.length > 0 && <>
        <div className="tbl" style={{ margin: 0 }}><table>
          <thead><tr><th>Line</th><th>MAC</th><th>Result</th></tr></thead>
          <tbody>{results.map((r) => <tr key={r.row.line}><td className="num">{r.row.line}</td><td className="mono">{r.row.mac}</td>
            <td>{r.ok ? <span className="pill ok">{r.s.serial}</span> : <span className="pill bad" title={r.error}>{r.error}</span>}</td></tr>)}</tbody>
        </table></div>
        {ok.length > 0 && <>
          <p className="hint">Claim codes are shown only now. Print the stickers before leaving this page.</p>
          <div className="stack" style={{ gap: 10 }}>{ok.map((r) => <div key={r.s.id} id={`stk-${r.s.id}`}><Sticker s={r.s} /></div>)}</div>
        </>}
      </>}
    </div>
  );
}

/* ---------------- registered today ---------------- */

function Today() {
  const router = useRouter();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const q = useApi<List<AdminDeviceRow>>(`/admin/devices${qs({ registeredFrom: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`, limit: 100 })}`);
  const tz = browserTz();
  return (
    <div className="card"><h2 style={{ marginBottom: 12 }}>Registered today</h2>
      <Async q={q}>{(r) => r.items.length ? (
        <div className="tbl"><table><thead><tr><th>Serial</th><th>Chip</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>{[...r.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((d) => (
            <tr key={d.id} className="click" onClick={() => router.push(`/admin/devices/${d.id}`)}>
              <td className="mono">{d.serial}</td><td className="mono">{d.chip}</td><td>{d.owner ? 'Claimed' : <span className="muted">Not claimed</span>}</td><td className="muted">{timeIn(d.createdAt, tz)}</td>
            </tr>
          ))}</tbody></table></div>
      ) : <p className="small muted">Nothing registered yet today.</p>}</Async>
    </div>
  );
}
