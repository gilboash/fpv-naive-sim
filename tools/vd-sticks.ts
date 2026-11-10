/**
 * Planned sticks (learn-lap's sticks.csv, flown in the simulator) -> a stick
 * program for the ESP32 in Velocidrone.
 *
 *   node --experimental-strip-types tools/vd-sticks.ts <learned dir> <out.csv> [--release 1.55]
 *
 * - Roll and yaw: the same number (both are the game's own stick, -1..1).
 * - Pitch: negated. The planner speaks Betaflight's convention (forward is
 *   positive); the board, like the radio, reads forward as negative.
 * - Throttle: not the same number. Each simulator throttle is a thrust, and
 *   the game's stick that gives that thrust is found from the two measured
 *   curves. Velocidrone's quad, punched out from the pad on 2026-11-08
 *   (vdrun/env, HUD speed): specific thrust = (8.3 u + 0.8)^2 m/s^2 up to
 *   ~85, hover (9.81) at u = 0.28.
 * - Time: the game ignores the sticks for ~1.55 s after the GO tone, so the
 *   output's t is seconds after GO, and the program starts when the quad is
 *   released. Play it with: vd-play.ts <dir> --sent --go 0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2]!;
const out = process.argv[3]!;
// The first moments of a simulated run carry a startup transient (the tracker
// reacting to the reset state: roll -0.45, yaw -0.47 for 0.15 s) that would
// throw the real quad off the pad. Roll, pitch and yaw stay neutral until then.
const QUIET = process.argv.includes('--quiet') ? Number(process.argv[process.argv.indexOf('--quiet') + 1]) : 0.25;
const release = process.argv.includes('--release') ? Number(process.argv[process.argv.indexOf('--release') + 1]) : 1.55;

const env = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')).envelope as { alpha: number; beta: number; maxAccel: number };
const VD = { alpha: 8.3, beta: 0.8, max: 85 };
const simThrust = (u: number): number => Math.min(env.maxAccel, Math.max(0, env.alpha * u + env.beta) ** 2);
const vdThrottle = (T: number): number => Math.min(1, Math.max(0, (Math.sqrt(Math.min(VD.max, T)) - VD.beta) / VD.alpha));

const rows = readFileSync(join(dir, 'sticks.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
const lines = ['t,thr,roll,pitch,yaw'];
// Before release: zeros (the game drops them anyway).
lines.push('0.0000,0.0000,0.0000,0.0000,0.0000');
for (const [t, thr, roll, pitch, yaw] of rows) {
  const q = t! < QUIET ? 0 : 1;
  lines.push(`${(t! + release).toFixed(4)},${vdThrottle(simThrust(thr!)).toFixed(4)},${(q * roll!).toFixed(4)},${(-q * pitch!).toFixed(4)},${(q * yaw!).toFixed(4)}`);
}
writeFileSync(out, lines.join('\n') + '\n');
const hover = vdThrottle(9.81);
console.log(`${rows.length} rows, ${rows[rows.length - 1]![0]!.toFixed(1)} s; sim envelope alpha ${env.alpha.toFixed(2)} beta ${env.beta.toFixed(2)} max ${env.maxAccel.toFixed(0)}; game hover stick ${hover.toFixed(3)}`);
