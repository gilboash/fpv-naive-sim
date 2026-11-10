/**
 * Play a recorded human flight back through the ESP32, from the race GO.
 *
 *   node --experimental-strip-types tools/vd-play.ts <record-dir> --go <seconds> [--seconds N] [--out dir]
 *
 * <record-dir> is vd-record.ts output (pad.csv on its own clock); --go is
 * when the GO tone started on that clock (from its audio). Here: abort a
 * running race, Reset, Recharge, Race Start, then listen to the game audio
 * live and start the sticks on our own GO tone. The replay's audio is kept so
 * its beeps can be compared with the original's.
 *
 * Channels: Velocidrone calibrates each controller separately, so the same
 * raw value from the TX16S and the ESP32 is not the same stick in the game.
 * Both were measured against the game's own stick overlay (the green dots),
 * frame by frame: raw -> overlay is a gain and a bias per axis, and the ESP32
 * value is the one that puts the dot where the radio put it. Measured
 * 2026-11-08 (human2 and its first replay); pitch is NOT inverted — the
 * first replay flipped it and climbed into the sky.
 */
import { toEsp as toEspRaw } from './vd-radio.ts';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStick, type Sticks } from './stick-port.ts';

const argv = process.argv.slice(2);
const dir = argv[0]!;
const arg = (k: string, d?: number): number => (argv.includes(`--${k}`) ? Number(argv[argv.indexOf(`--${k}`) + 1]) : d!);
const GO = arg('go');
const SECONDS = arg('seconds', 30);
// Throttle trim for a converted radio log: the overlay match is good to ~1%,
// and 1% of throttle is the difference between through gate 1 and over it.
const TRIM = arg('thr-trim', 0);
// Small constant stick biases, for searching the conversion error out (a few
// percent of a stick is the difference between through a gate and past it).
const BIAS = { roll: arg('roll-trim', 0), pitch: arg('pitch-trim', 0), yaw: arg('yaw-trim', 0) };
const cl = (v: number): number => Math.max(-1, Math.min(1, v));
const toEsp = (a0: number, a1: number, a2: number, a3: number): Sticks => {
  const s = toEspRaw(a0, a1, a2, a3, TRIM);
  return { ...s, roll: cl(s.roll + BIAS.roll), pitch: cl(s.pitch + BIAS.pitch), yaw: cl(s.yaw + BIAS.yaw) };
};
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : join(dir, 'replay');
mkdirSync(outDir, { recursive: true });

// --sent: replay a pass-through recording's sent.csv (vd-record --through),
// which is already in ESP32 units — exactly what the game received, no
// conversion. Otherwise convert the radio's pad.csv.
const SENT = argv.includes('--sent');
const lines = readFileSync(join(dir, SENT ? 'sent.csv' : 'pad.csv'), 'utf8').trim().split('\n');
const nCols = lines[0]!.split(',').length;
const rec = lines.slice(1).map((l) => l.split(',')).filter((c) => c.length === nCols).map((c) => c.map(Number))
  .map((c, i, all) => ({ t: c[0]! - GO, s: SENT ? { throttle: c[1]!, roll: c[2]!, pitch: c[3]!, yaw: c[4]! } : toEsp(c[1]!, c[2]!, i < all.findIndex((r) => r[3] !== 0) ? -0.9736 : c[3]!, c[4]!) })) // Chrome reports an axis as 0 until it first moves: that is not mid-throttle
  .filter((r) => r.t >= -0.5 && r.t <= SECONDS);
console.log(`${rec.length} samples from GO to ${SECONDS} s`);

// ---- is a race running? (same check as vd-fly)
function raceRunning(): boolean {
  const win = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import("CoreGraphics"); const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)); let id = "";
    for (let i = 0; i < arr.count; i++) { const w = arr.objectAtIndex(i);
      if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) === "velocidrone" && ObjC.unwrap(w.objectForKey("kCGWindowName")) === "velocidrone") id = ObjC.unwrap(w.objectForKey("kCGWindowNumber")); }
    id`]).toString().trim();
  const a = join(tmpdir(), 'vd-play-btn.png');
  const b = join(tmpdir(), 'vd-play-btn-c.png');
  execFileSync('screencapture', ['-x', '-o', '-r', `-l${win}`, '-t', 'png', a]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-vf', 'crop=iw*0.094:ih*0.04:iw*0.453:ih*0.873,negate', b]);
  const txt = execFileSync('tesseract', [b, '-', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().toUpperCase();
  console.log(`race button reads "${txt.trim()}"`);
  return txt.includes('BORT');
}
const running = raceRunning();

const port = openStick(process.env.STICK_PORT);
const z: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let sticks: Sticks = z;
let goAt = 0; // our clock, seconds
let playing = false;
let i = 0;
const sent: string[] = ['t,thr,roll,pitch,yaw'];
const t0 = performance.now();
const now = (): number => (performance.now() - t0) / 1000;
const feed = setInterval(() => {
  if (playing) {
    const t = now() - goAt;
    while (i < rec.length - 1 && rec[i + 1]!.t <= t) i++;
    sticks = rec[i]!.t <= t ? rec[i]!.s : z;
    sent.push(`${t.toFixed(4)},${sticks.throttle.toFixed(4)},${sticks.roll.toFixed(4)},${sticks.pitch.toFixed(4)},${sticks.yaw.toFixed(4)}`);
    if (t > SECONDS) stopAll('done');
  }
  port.send(sticks);
}, 2);

// ---- live audio: find the GO tone (the long one after three short beeps)
const SR = 22050;
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':BlackHole 2ch', '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] });
const pcm: Buffer[] = [];
let audioStart = NaN;
let carry = Buffer.alloc(0);
const WIN = Math.round(0.05 * SR);
let base = 0.0005;
let on = false;
let onsetAt = 0;
let shorts = 0;
const events: [number, number][] = [];
ff.stdout.on('data', (c: Buffer) => {
  const tn = now();
  if (!Number.isFinite(audioStart)) audioStart = tn - c.length / 2 / SR;
  pcm.push(c);
  carry = Buffer.concat([carry, c]);
  const total = pcm.reduce((a, b) => a + b.length, 0) / 2 - carry.length / 2;
  let off = 0;
  let k = total;
  while (carry.length - off >= WIN * 2) {
    let s = 0;
    for (let j = 0; j < WIN; j++) {
      const v = carry.readInt16LE(off + j * 2) / 32768;
      s += v * v;
    }
    const rms = Math.sqrt(s / WIN);
    const at = audioStart + k / SR;
    if (!on && rms > Math.max(4 * base, 0.003)) {
      on = true;
      onsetAt = refine(carry, off, at, Math.max(4 * base, 0.003));
    } else if (on && rms < Math.max(2 * base, 0.0015)) {
      on = false;
      const len = at - onsetAt;
      events.push([onsetAt, len]);
      if (!playing && armed) {
        if (len < 0.5) shorts++;
        else if (shorts >= 2) {
          // GO starts at the onset of the long tone
          goAt = onsetAt;
          playing = true;
          console.log(`GO heard at ${goAt.toFixed(3)} s (after ${shorts} beeps); playing`);
        }
      }
    }
    if (!on) base += (rms - base) * 0.01;
    off += WIN * 2;
    k += WIN;
  }
  carry = carry.subarray(off);
});

// The 50 ms window says which window a tone began in; the start itself is
// the first 2 ms slice of that window loud enough, or the replay starts up to
// 50 ms out from the original.
function refine(buf: Buffer, off: number, at: number, thr: number): number {
  const S = Math.round(0.002 * SR);
  for (let j = 0; j + S <= WIN; j += S) {
    let s = 0;
    for (let q = 0; q < S; q++) {
      const v = buf.readInt16LE(off + (j + q) * 2) / 32768;
      s += v * v;
    }
    if (Math.sqrt(s / S) > thr) return at + j / SR;
  }
  return at;
}

// ---- start sequence
let armed = false;
const at = (ms: number, f: () => void): void => {
  setTimeout(f, ms);
};
// After the board (re)connects the game reads an axis only once it changes:
// held at zero from the start, throttle showed mid-stick. Nudge it first.
at(100, () => (sticks = { ...z, throttle: 0.1 }));
at(200, () => (sticks = z));
at(300, () => (sticks = { ...z, buttons: 1 })); // Reset
at(450, () => (sticks = z));
at(900, () => (sticks = { ...z, buttons: 4 })); // Recharge
at(1200, () => (sticks = z));
if (running) {
  at(1600, () => (sticks = { ...z, buttons: 2 })); // abort
  at(1900, () => (sticks = z));
}
at(2600, () => {
  armed = true;
  sticks = { ...z, buttons: 2 }; // Race Start
});
at(3000, () => (sticks = z));
at(12000, () => {
  if (!playing) stopAll('no GO heard');
});

let stopped = false;
function stopAll(why: string): void {
  if (stopped) return;
  stopped = true;
  playing = false;
  sticks = z;
  console.log(`end: ${why}`);
  setTimeout(() => {
    sticks = { ...z, buttons: 1 };
    setTimeout(() => {
      sticks = z;
      clearInterval(feed);
      ff.kill('SIGINT');
      port.close();
      const all = Buffer.concat(pcm);
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + all.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
      hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24);
      hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(all.length, 40);
      writeFileSync(join(outDir, 'audio.wav'), Buffer.concat([hdr, all]));
      writeFileSync(join(outDir, 'sent.csv'), sent.join('\n') + '\n');
      writeFileSync(join(outDir, 'events.json'), JSON.stringify({ goAt, events: events.map(([a, l]) => [a - goAt, l]) }));
      const ev = events.filter(([a]) => a > goAt + 0.9).map(([a, l]) => `${(a - goAt).toFixed(2)}${l > 0.5 ? 'L' : ''}`);
      console.log(`sounds after GO: ${ev.join(' ')}`);
      setTimeout(() => process.exit(0), 500);
    }, 600);
  }, 400);
}
process.on('SIGINT', () => stopAll('interrupted'));
