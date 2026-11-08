/**
 * The host end of the ESP32-S3 joystick (firmware/stick-esp32s3): sticks in,
 * 12-byte frames out over USB serial. Node only.
 *
 * No serial library: on macOS a USB CDC port is a file, and the baud rate a
 * CDC device is told means nothing to it. `stty raw` stops the tty layer
 * from translating bytes, which would otherwise corrupt every frame
 * containing a 0x0A.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';

export interface Sticks {
  /** 0..1 */
  throttle: number;
  /** -1..1, Mode 2 directions as a radio sends them. */
  roll: number;
  pitch: number;
  yaw: number;
  /** Bit mask, buttons 1-8. */
  buttons?: number;
}

const FULL = 32767;
const q = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * FULL);

/**
 * Which channel goes out on each of the joystick's four axes (X, Y, Z, Rx),
 * as four letters of T R P Y. Default AETR, "RPTY", which is what
 * Velocidrone's stick wizard ended up with.
 *
 * Velocidrone's *legacy* controller menu shows a different table (Throttle =
 * AXIS 0 = X) that the game does not fly on; swapping to match it swapped
 * throttle and roll on the live radio picture. The half-range throttle that
 * prompted it was each axis's stored calibration, fixed with DEFAULT in the
 * legacy menu's Calibrate dialog. Override with STICK_ORDER.
 */
export const AXIS_ORDER = (process.env.STICK_ORDER ?? 'RPTY').toUpperCase();

/** The frame the firmware expects. Exported for the checks. */
export function frame(s: Sticks, order = AXIS_ORDER): Uint8Array {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  b[0] = 0xa5;
  b[1] = 0x5a;
  const value = (c: string): number =>
    c === 'T' ? s.throttle * 2 - 1 : c === 'R' ? s.roll : c === 'P' ? s.pitch : s.yaw;
  for (let i = 0; i < 4; i++) dv.setInt16(2 + 2 * i, q(value(order[i] ?? 'RPTY'[i]!)), true);
  b[10] = (s.buttons ?? 0) & 0xff;
  let x = 0;
  for (let i = 2; i < 11; i++) x ^= b[i]!;
  b[11] = x;
  return b;
}

/** Candidate ports: USB modems, which is how macOS names a CDC device. */
export function candidatePorts(): string[] {
  return readdirSync('/dev')
    .filter((f) => f.startsWith('cu.usbmodem'))
    .map((f) => `/dev/${f}`);
}

export class StickPort {
  readonly path: string;
  private fd: number;

  constructor(path: string) {
    this.path = path;
    execFileSync('stty', ['-f', path, 'raw', '-echo', '115200']);
    this.fd = openSync(path, 'r+');
  }

  /** Ask the firmware what it is. Null if it is not ours or does not answer. */
  hello(timeoutMs = 600): string | null {
    // Twelve zeros first: if the firmware is part-way through a frame — the
    // last process may have been cut off mid-write — they complete it with a
    // bad checksum and return it to waiting, where it will read text.
    writeSync(this.fd, new Uint8Array(12));
    writeSync(this.fd, '\n?\n');
    const buf = Buffer.alloc(256);
    let got = '';
    const until = Date.now() + timeoutMs;
    // Reads block on a tty with no data, so poll with a short VMIN/VTIME.
    execFileSync('stty', ['-f', this.path, 'min', '0', 'time', '1']);
    while (Date.now() < until && !got.includes('\n')) {
      const n = readSync(this.fd, buf, 0, buf.length, null);
      if (n > 0) got += buf.subarray(0, n).toString('latin1');
    }
    const line = got.split('\n').find((l) => l.startsWith('fpvsim-stick'));
    return line ?? null;
  }

  send(s: Sticks): void {
    writeSync(this.fd, frame(s));
  }

  /**
   * Move the board's absolute mouse: x, y as fractions of the main display,
   * buttons bit 0 = left. Callers decide whether a click is allowed; see
   * vd-setup.ts, which only clicks inside the game's own window.
   */
  mouse(fx: number, fy: number, buttons: number): void {
    const c = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 32767);
    writeSync(this.fd, `\nm ${c(fx)} ${c(fy)} ${buttons & 7}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Restart the board as a mouse (true) or joystick (false) and return the
 * reopened port. It is one or the other — the prebuilt TinyUSB has a single
 * HID interface — so a menu click is: mouse, click, joystick. Takes ~2-3 s.
 */
export function switchMode(port: StickPort, mouse: boolean): StickPort {
  const want = mouse ? 'mouse' : 'joystick';
  if (port.hello()?.includes(`mode=${want}`)) return port;
  const path = port.path;
  writeSync((port as unknown as { fd: number }).fd, `\nM${mouse ? 1 : 0}\n`);
  try {
    port.close();
  } catch {
    // the device may already have gone
  }
  const until = Date.now() + 10000;
  // Wait for it to go and come back.
  const sleep = (ms: number): void => {
    const t = Date.now() + ms;
    while (Date.now() < t) {
      // busy
    }
  };
  sleep(800);
  while (Date.now() < until) {
    try {
      const p = new StickPort(path);
      for (let k = 0; k < 3; k++) {
        const h = p.hello(600);
        if (h?.includes(`mode=${want}`)) return p;
      }
      p.close();
    } catch {
      // not back yet
    }
    sleep(300);
  }
  throw new Error(`board did not come back as ${want}`);
}

/** The first port that answers as ours. */
export function openStick(explicit?: string): StickPort {
  const ports = explicit ? [explicit] : candidatePorts();
  for (const p of ports) {
    try {
      const sp = new StickPort(p);
      // The first answer after opening can be lost to whatever the port held.
      for (let k = 0; k < 3; k++) if (sp.hello(800)) return sp;
      sp.close();
    } catch {
      // busy or not a tty; try the next
    }
  }
  throw new Error(`no fpvsim stick found on ${ports.join(', ') || 'any /dev/cu.usbmodem*'}`);
}
