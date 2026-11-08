/**
 * Play a recorded stick trace into Velocidrone, open loop, from the race GO.
 *
 *   node --experimental-strip-types tools/vd-replay.ts <trace.csv> <window-id> [--flip-pitch] [--out log.csv]
 *
 * Presses Race Start (button 2), watches the game window for the green
 * countdown digits to appear and then vanish, and starts the trace at that
 * moment — the trace's t = 0 is the race clock's zero. Then Reset (button 1)
 * and throttle down.
 *
 * This is an experiment, not a pilot: a chaotic system flown blind on a
 * different pilot's rates diverges, and the question is how far it gets.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { openStick, type Sticks } from './stick-port.ts';

const args = process.argv.slice(2);
const [csvPath, winId] = args as [string, string];
const flipPitch = args.includes('--flip-pitch');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

// ---- the trace: t, throttle, roll, pitch, yaw; gaps held from the last good row
const rows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const tr: { t: number; s: Sticks }[] = [];
let last: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
for (const r of rows) {
  const t = Number(r[0]);
  if (r[1] !== '' && r[1] !== undefined) {
    last = {
      throttle: Number(r[1]),
      roll: Number(r[2]),
      pitch: Number(r[3]) * (flipPitch ? -1 : 1),
      yaw: Number(r[4]),
    };
  }
  tr.push({ t, s: { ...last } });
}
const duration = tr[tr.length - 1]!.t;
function at(t: number): Sticks {
  if (t <= tr[0]!.t) return tr[0]!.s;
  let i = Math.min(tr.length - 2, Math.floor((t / duration) * (tr.length - 1)));
  while (i > 0 && tr[i]!.t > t) i--;
  while (i < tr.length - 2 && tr[i + 1]!.t < t) i++;
  const a = tr[i]!;
  const b = tr[i + 1]!;
  const w = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const m = (x: number, y: number): number => x + (y - x) * w;
  return { throttle: m(a.s.throttle, b.s.throttle), roll: m(a.s.roll, b.s.roll), pitch: m(a.s.pitch, b.s.pitch), yaw: m(a.s.yaw, b.s.yaw) };
}

const port = openStick(process.env.STICK_PORT);
const idle: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
const busy = (ms: number, s: Sticks): void => {
  const until = performance.now() + ms;
  let next = performance.now();
  while (performance.now() < until) {
    if (performance.now() >= next) {
      port.send(s);
      next += 4;
    }
  }
};

// ---- countdown watch: green digit pixels in the middle-top of the window
const shot = '/tmp/vd-replay-countdown.jpg';
// screencapture cannot crop a window capture, so read pixels with sips-free
// python: count saturated green in the countdown band.
function greenCount(): number {
  port.send(idle);
  execFileSync('screencapture', ['-x', '-o', '-r', `-l${winId}`, '-t', 'jpg', shot], { stdio: 'ignore' });
  port.send(idle);
  const out = execFileSync('python3', ['-c', `
import numpy as np
from PIL import Image
im = np.asarray(Image.open('${shot}').convert('RGB').resize((1440, 900))).astype(int)
band = im[400:490, 600:860]
r, g, b = band[..., 0], band[..., 1], band[..., 2]
print(int(((g > 170) & (r < 140) & (b < 140)).sum()))
`]).toString();
  return Number(out.trim());
}

busy(500, idle);
console.log('race start');
busy(600, { ...idle, buttons: 2 });
busy(200, idle);
let seen = false;
const deadline = performance.now() + 8000;
for (;;) {
  const g = greenCount();
  if (!seen && g > 150) {
    seen = true;
    console.log(`countdown visible (${g} px)`);
  }
  if (seen && g < 30) break;
  if (performance.now() > deadline) {
    console.log('no countdown seen; starting anyway');
    break;
  }
}
// The capture that saw "gone" took ~80 ms; the GO was somewhere in it.
const t0 = performance.now() - 60;
console.log('GO — playing', duration.toFixed(1), 's');
const log: string[] = ['t,throttle,roll,pitch,yaw'];
let next = performance.now();
for (;;) {
  const t = (performance.now() - t0) / 1000;
  if (t > duration + 0.5) break;
  const s = at(t);
  port.send(s);
  if (log.length < 1e6 && Math.round(t * 250) % 4 === 0) log.push(`${t.toFixed(3)},${s.throttle.toFixed(3)},${s.roll.toFixed(3)},${s.pitch.toFixed(3)},${s.yaw.toFixed(3)}`);
  next += 4;
  while (performance.now() < next) {
    // busy-wait
  }
}
busy(500, idle);
console.log('reset');
busy(600, { ...idle, buttons: 1 });
busy(300, idle);
if (outPath) writeFileSync(outPath, log.join('\n') + '\n');
port.close();
