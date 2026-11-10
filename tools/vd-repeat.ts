/**
 * Repeat a flight's sticks 1:1 from the same start: Reset, Race Start, the
 * countdown held at zero throttle, then the logged sticks on the logged
 * clock. The question it answers: is Velocidrone deterministic enough that a
 * sequence that once got through a gate gets through again?
 *
 *   node --experimental-strip-types tools/vd-repeat.ts <fly.csv> [--until seconds] [--record out.mp4]
 *
 * <fly.csv> is vd-fly.ts's log: one row per frame with the sticks it held
 * until the next frame (columns thr, rs, ps, ys), time t from take-off.
 * The start sequence mirrors vd-fly.ts so t = 0 lands at the same moment
 * after the countdown.
 */

import { readFileSync } from 'node:fs';
import { frames } from './vd-frames.ts';
import { openStick, type Sticks } from './stick-port.ts';

const argv = process.argv.slice(2);
const csv = argv[0]!;
const until = argv.includes('--until') ? Number(argv[argv.indexOf('--until') + 1]) : Infinity;
const record = argv.includes('--record') ? argv[argv.indexOf('--record') + 1] : undefined;

const lines = readFileSync(csv, 'utf8').trim().split('\n');
const head = lines[0]!.split(',');
const col = (n: string): number => head.indexOf(n);
const rows = lines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[col('t')]),
  s: { throttle: Number(c[col('thr')]), roll: Number(c[col('rs')]), pitch: Number(c[col('ps')]), yaw: Number(c[col('ys')]) },
})).filter((r) => r.t <= until);
console.log(`${rows.length} rows, ${rows[rows.length - 1]!.t.toFixed(2)} s`);

const port = openStick(process.env.STICK_PORT);
const z: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let sticks: Sticks = z;
const feed = setInterval(() => port.send(sticks), 4);
const stopRec = record ? frames(() => {}, { record }) : null;

const t0 = performance.now();
const at = (ms: number, f: () => void): void => {
  setTimeout(f, ms);
};
// Same start as vd-fly: Reset, Race Start at 1.5 s, zero throttle, fly at 5.33 s
// (vd-fly waits 5.0 s, then 10 frames to find the level horizon).
at(0, () => (sticks = { ...z, buttons: 1 }));
at(150, () => (sticks = z));
at(600, () => (sticks = { ...z, buttons: 4 })); // button 3: Recharge Battery
at(900, () => (sticks = z));
at(1500, () => (sticks = { ...z, buttons: 2 }));
at(1900, () => (sticks = z));
at(5330, () => {
  const start = performance.now();
  let i = 0;
  const play = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    while (i < rows.length - 1 && rows[i + 1]!.t <= t) i++;
    if (i >= rows.length - 1 && t > rows[rows.length - 1]!.t + 0.05) {
      clearInterval(play);
      console.log('replayed; holding a hover 2 s, then reset');
      sticks = { ...z, throttle: rows[rows.length - 1]!.s.throttle };
      at(2000, () => (sticks = { ...z, buttons: 1 }));
      at(2600, () => {
        sticks = z;
        setTimeout(() => {
          clearInterval(feed);
          stopRec?.();
          port.close();
          console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
          setTimeout(() => process.exit(0), 800);
        }, 300);
      });
      return;
    }
    sticks = rows[i]!.s;
  }, 2);
});
