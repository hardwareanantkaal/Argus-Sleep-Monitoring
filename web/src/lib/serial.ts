// USB side of the manufacturing station. Runs only in Chrome/Edge (Web Serial API).
//  - connectBoard(): puts the board in bootloader mode with esptool-js, reads chip + MAC
//  - flashImage():   writes the factory image at 0x0, then hard-resets
//  - Monitor:        plain 115200-baud serial monitor with a board reset (EN via RTS)
// esptool-js is imported only when needed: it is large and only this screen uses it.

/* eslint-disable @typescript-eslint/no-explicit-any */
type SerialPortLike = any;
type Loader = any;

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Board { port: SerialPortLike; transport: any; loader: Loader; desc: string; chip: string; mac: string }

/** Bootloader mode + chip + MAC. Pass `port` to reuse a port already picked (no picker shown). */
export async function connectBoard(log: (l: string) => void, reuse?: SerialPortLike): Promise<Board> {
  const port = reuse || await (navigator as any).serial.requestPort();
  const { ESPLoader, Transport } = await import('esptool-js');
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600, // flashing speed once the stub runs; use 460800 if a USB cable is flaky
    romBaudrate: 115200,
    terminal: { clean() {}, writeLine: (l: string) => log(l), write: (d: string) => log(d) },
  } as any);
  const desc = await loader.main(); // e.g. "ESP32-D0WD-V3 (revision v3.1)"
  const mac: string = await loader.chip.readMac(loader);
  return { port, transport, loader, desc, chip: loader.chip.CHIP_NAME, mac: mac.toLowerCase() };
}

/** image is written at 0x0. A merged image (ESP32) covers the whole flash; a smaller
 *  image (ESP8266 .bin) gets a full erase first so old Wi-Fi settings and data are gone. */
export async function flashImage(board: Board, image: Uint8Array, flashBytes: number, onProgress: (written: number, total: number) => void) {
  await board.loader.writeFlash({
    fileArray: [{ data: image, address: 0 }],
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll: image.length < flashBytes,
    compress: true,
    reportProgress: (_i: number, written: number, total: number) => onProgress(written, total),
  });
  await board.loader.after('hard_reset');
}

export async function leaveBootloader(board: Board) {
  try { await board.loader.after('hard_reset'); } catch { /* already running */ }
}

export async function releaseBoard(board: Board) {
  try { await board.transport.disconnect(); } catch { /* port already closed */ }
}

export class Monitor {
  private reader: any = null;
  private closed = false;
  constructor(private port: SerialPortLike, private onText: (t: string) => void) {}

  async open(baudRate = 115200) {
    await this.port.open({ baudRate });
    // DTR/RTS low = run mode on the usual ESP32 auto-reset circuit
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    void this.loop();
  }

  private async loop() {
    const decoder = new TextDecoder();
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.onText(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (!this.closed) this.onText(`\n[station] serial error: ${(err as Error).message}\n`);
        break;
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  /** Pulse EN low through RTS, like pressing RESET. */
  async reset() {
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  async write(text: string) {
    const w = this.port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
  }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}
