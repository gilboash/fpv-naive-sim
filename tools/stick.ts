/**
 * Drive the ESP32-S3 joystick by hand, for setting it up in a simulator.
 *
 *   npm run stick -- ping              is it there, and has it seen frames
 *   npm run stick -- calibrate [s]     both sticks round their full range, for
 *                                      the sim's calibration screen (default 30 s)
 *   npm run stick -- identify          one channel at a time, named on the
 *                                      console, for assigning axes
 *   npm run stick -- center [s]        throttle down, the rest centred
 *   npm run stick -- hold T R P Y [s]  hold a fixed position
 *   npm run stick -- press N [s]       hold button N (1-8) down for s (default
 *                                      1), sticks centred — for binding a
 *                                      button in the sim, or using one
 *
 * Frames go out at 250 Hz. When this exits the firmware's failsafe puts the
 * throttle down within 250 ms.
 */

import { openStick, type Sticks } from './stick-port.ts';

const args = process.argv.slice(2);
const mode = args[0] ?? 'ping';
const port = openStick(process.env.STICK_PORT);
console.log(`${port.path}: ${port.hello() ?? '(no answer)'}`);

const HZ = 250;
function run(seconds: number, at: (t: number) => Sticks, label?: (t: number) => string): void {
  const t0 = performance.now();
  let next = t0;
  let lastLabel = '';
  for (;;) {
    const t = (performance.now() - t0) / 1000;
    if (t > seconds) break;
    port.send(at(t));
    if (label) {
      const l = label(t);
      if (l !== lastLabel) {
        console.log(`  ${t.toFixed(1).padStart(5)} s  ${l}`);
        lastLabel = l;
      }
    }
    next += 1000 / HZ;
    while (performance.now() < next) {
      // Busy-wait: a timer-driven loop in Node jitters by milliseconds, and this
      // is the radio link.
    }
  }
}

const centre: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

if (mode === 'ping') {
  // nothing more
} else if (mode === 'center') {
  run(Number(args[1] ?? 10), () => centre);
} else if (mode === 'hold') {
  const [T, R, P, Y] = args.slice(1, 5).map(Number);
  run(Number(args[5] ?? 10), () => ({ throttle: T ?? 0, roll: R ?? 0, pitch: P ?? 0, yaw: Y ?? 0 }));
} else if (mode === 'press') {
  const n = Math.max(1, Math.min(8, Number(args[1] ?? 1)));
  const secs = Number(args[2] ?? 1);
  console.log(`  button ${n} down for ${secs} s`);
  run(secs, () => ({ ...centre, buttons: 1 << (n - 1) }));
  run(0.3, () => centre);
} else if (mode === 'calibrate') {
  // Each stick traces its square's corners and then a circle, slowly, so a
  // calibration screen sees every extreme on every axis several times.
  const period = 6;
  run(
    Number(args[1] ?? 30),
    (t) => {
      const a = (2 * Math.PI * t) / period;
      const c = Math.max(-1, Math.min(1, 1.3 * Math.cos(a)));
      const s = Math.max(-1, Math.min(1, 1.3 * Math.sin(a)));
      return { throttle: (s + 1) / 2, yaw: c, roll: c, pitch: s };
    },
    (t) => `lap ${Math.floor(t / period) + 1}`,
  );
  run(1, () => centre);
} else if (mode === 'identify') {
  // One channel at a time, full travel each way, so each can be bound by
  // watching which one moves.
  const steps: [string, (v: number) => Sticks][] = [
    ['THROTTLE up and down', (v) => ({ ...centre, throttle: (v + 1) / 2 })],
    ['YAW right and left', (v) => ({ ...centre, yaw: v })],
    ['PITCH forward (+) and back', (v) => ({ ...centre, pitch: v })],
    ['ROLL right and left', (v) => ({ ...centre, roll: v })],
  ];
  const each = 4;
  run(
    steps.length * each,
    (t) => {
      const i = Math.min(steps.length - 1, Math.floor(t / each));
      return steps[i]![1](Math.sin((2 * Math.PI * (t % each)) / 2));
    },
    (t) => steps[Math.min(steps.length - 1, Math.floor(t / each))]![0],
  );
  run(1, () => centre);
} else {
  console.error(`unknown mode "${mode}"`);
  process.exit(2);
}
console.log(port.hello() ?? '');
port.close();
