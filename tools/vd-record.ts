/**
 * Record a human flight in Velocidrone: the radio's sticks (via a headless
 * Chrome's Gamepad API, which keeps reading while the game has focus), the
 * game audio (GO tone and gate beeps, through BlackHole) and the screen.
 *
 *   node --experimental-strip-types tools/vd-record.ts <out-dir> [--seconds 120] [--match TX16S] [--through]
 *
 * --through: the radio's sticks are forwarded live to the ESP32 and logged
 * as sent.csv. DOES NOT WORK as intended (2026-11-08): with the TX16S plugged
 * in as a joystick Velocidrone flies the radio, whatever controller is
 * selected, so sent.csv is not what the game received and replaying it
 * climbs away. Kept for a radio that is not a HID joystick (EdgeTX serial).
 *
 * Writes pad.csv (t, axes..., buttons) on the performance clock shared with
 * audio.wav's start, plus screen.mp4. Stop early with Ctrl-C.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStick, type Sticks } from './stick-port.ts';

// Radio raw -> ESP32 raw so the game's sticks move as they do with the radio
// (both measured against the game's stick overlay, see vd-play.ts).
const TXC = { roll: [0.519, 0.045], pitch: [0.546, 0.014], thr: [0.674, 0.088], yaw: [0.514, 0.019] } as const;
const ESPC = { roll: [0.68, 0.046], pitch: [0.714, 0.015], thr: [0.71, 0.03], yaw: [0.731, 0.029] } as const;
const conv = (a: number, k: keyof typeof TXC): number => Math.max(-1, Math.min(1, (TXC[k][0] * a + TXC[k][1] - ESPC[k][1]) / ESPC[k][0]));

const argv = process.argv.slice(2);
const out = argv[0]!;
const seconds = argv.includes('--seconds') ? Number(argv[argv.indexOf('--seconds') + 1]) : 120;
const match = (argv.includes('--match') ? argv[argv.indexOf('--match') + 1]! : '').toLowerCase();
mkdirSync(out, { recursive: true });

const prof = mkdtempSync(join(tmpdir(), 'vd-record-'));
const port = 9341;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'http://localhost:5180/vd-map.html',
], { stdio: 'ignore' });

const t0 = performance.now();
// Audio through a pipe, timestamped on arrival, so the GO tone and the gate
// beeps land on the same clock as the stick samples.
const SR = 22050;
const audio = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':BlackHole 2ch', '-t', String(seconds), '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] });
const chunks: Buffer[] = [];
let audioBytes = 0;
let audioStart = NaN; // seconds on our clock of sample 0
audio.stdout.on('data', (c: Buffer) => {
  const now = (performance.now() - t0) / 1000;
  audioBytes += c.length;
  if (!Number.isFinite(audioStart)) audioStart = now - c.length / 2 / SR;
  chunks.push(c);
});
const screen = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'uyvy422', '-framerate', '30', '-i', 'Capture screen 0:none', '-t', String(seconds), '-vf', 'fps=30,scale=960:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', join(out, 'screen.mp4')], { stdio: ['pipe', 'ignore', 'inherit'] });

let list: { type: string; webSocketDebuggerUrl: string }[] = [];
for (let k = 0; k < 40 && !list.some((x) => x.type === 'page'); k++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof list;
  } catch {
    // not up yet
  }
}
const ws = new WebSocket(list.find((x) => x.type === 'page')!.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data)) as { id: number; result?: { result?: { value?: unknown } } };
  pending.get(d.id)?.(d.result?.result?.value);
  pending.delete(d.id);
};
const ev = (expression: string): Promise<unknown> =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

// Sample in the page every 2 ms into a buffer; drain it from here.
await ev(`
  window.__rec = []; window.__pads = '';
  setInterval(() => {
    const ps = [...navigator.getGamepads()].filter(Boolean);
    window.__pads = ps.map(p => p.id).join(' | ');
    const radios = ps.filter(p => !/espressif/i.test(p.id)); // never our own board: forwarding it to itself latches
    const p = radios.find(p => !${JSON.stringify(match)} || p.id.toLowerCase().includes(${JSON.stringify(match)})) || radios[0];
    if (p) window.__rec.push([performance.timeOrigin + performance.now(), ...p.axes.map(a => +a.toFixed(4)), p.buttons.reduce((m, b, i) => m | (b.pressed ? 1 << i : 0), 0)]);
  }, 2);
  'ok'`);
const rows: number[][] = [];
const through = argv.includes('--through');
const stick = through ? openStick(process.env.STICK_PORT) : null;
const sent: string[] = ['t,thr,roll,pitch,yaw,buttons'];
let current: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let btn = 0;
let startRace: (() => void) | null = null;
if (stick) {
  // The board fails safe after 250 ms without a frame; resend the latest.
  setInterval(() => stick.send(btn ? { ...current, buttons: btn } : current), 4);
  // The replay starts Reset, Recharge, Race Start from the board (vd-play.ts);
  // the recording must start the same way or the two flights begin from
  // different states — a human's lap on a part-used battery replayed on a
  // fresh one climbed into the sky. The pilot just flies from GO.
  const press = (ms: number, b: number): void => {
    setTimeout(() => (btn = b), ms);
    setTimeout(() => (btn = 0), ms + (b === 4 ? 300 : 150));
  };
  // Not until the radio is actually being read: Chrome lists it only after a
  // stick moves, and a race started before that is flown with nothing.
  startRace = (): void => {
    console.log('radio seen; Reset, Recharge, Race Start');
    press(500, 1); // Reset
    press(1100, 4); // Recharge
    press(2800, 2); // Race Start
    setTimeout(() => console.log('race started — fly from GO'), 2800);
  };
  // Forwarding needs the samples as they happen, not in 200 ms batches.
  setInterval(async () => {
    const v = (await ev(`(() => { const r = window.__rec; return r.length ? r[r.length - 1] : null; })()`)) as number[] | null;
    if (!v) return;
    if (startRace) {
      startRace();
      startRace = null;
    }
    const b = v[v.length - 1]!;
    current = { roll: conv(v[1]!, 'roll'), pitch: conv(v[2]!, 'pitch'), throttle: (conv(v[3]!, 'thr') + 1) / 2, yaw: conv(v[4]!, 'yaw') }; // sticks only: a radio switch forwarded as button 1 would hold Reset
    sent.push(`${((performance.now() - t0) / 1000).toFixed(4)},${current.throttle.toFixed(4)},${current.roll.toFixed(4)},${current.pitch.toFixed(4)},${current.yaw.toFixed(4)},${b & 0xff}`);
  }, 4);
}
const wallAtT0 = Date.now() - (performance.now() - t0);
let lastPads = '';
console.log('recording — fly when ready (Ctrl-C to stop)');
const drain = setInterval(async () => {
  const r = (await ev(`(() => { const r = window.__rec; window.__rec = []; return [window.__pads, r]; })()`)) as [string, number[][]];
  if (r[0] !== lastPads) {
    lastPads = r[0];
    console.log(`gamepads: ${r[0] || '(none yet — move a stick)'}`);
  }
  for (const row of r[1]) rows.push([(row[0]! - wallAtT0) / 1000, ...row.slice(1)]);
}, 200);

const finish = (): void => {
  clearInterval(drain);
  audio.kill('SIGINT');
  const pcm = Buffer.concat(chunks);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(join(out, 'audio.wav'), Buffer.concat([hdr, pcm]));
  writeFileSync(join(out, 'clock.json'), JSON.stringify({ audioStart, sampleRate: SR, note: 'pad.csv t and audioStart are seconds on the same clock' }));
  screen.stdin.write('q');
  const n = rows[0] ? rows[0].length - 2 : 0;
  const head = ['t', ...Array.from({ length: n }, (_, i) => `a${i}`), 'buttons'].join(',');
  if (through) writeFileSync(join(out, 'sent.csv'), sent.join('\n') + '\n');
  writeFileSync(join(out, 'pad.csv'), [head, ...rows.map((r) => r.map((v, i) => (i === 0 ? v.toFixed(4) : String(v))).join(','))].join('\n') + '\n');
  console.log(`${rows.length} samples, ${rows.length ? (rows[rows.length - 1]![0]! - rows[0]![0]!).toFixed(1) : 0} s -> ${out}`);
  chrome.kill();
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', finish);
setTimeout(finish, seconds * 1000);
