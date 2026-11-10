/**
 * Plan the route through a Velocidrone track with the *measured* Velocidrone
 * quad, and write the feedforward sticks that follow from it — the physics
 * inverted, no feedback and no simulator in the loop.
 *
 *   node --experimental-strip-types tools/vd-feedforward.ts <track.json> <out dir>
 *       [--aggression 0.3] [--iterations 120] [--release 1.55] [--hz 250]
 *
 * Writes <out>/plan.csv (t after GO, thr, roll, pitch, yaw — board units,
 * the file vd-play.ts --sent --go 0 flies) and <out>/times.json (when each
 * checkpoint is crossed on the plan, for comparing with the beeps).
 *
 * Velocidrone's quad: rates from measurements/velocidrone/quad-settings.json;
 * thrust (8.3 u + 0.8)^2 m/s^2 up to ~85 (punch-outs read off the HUD speed,
 * 2026-11-08); drag and inflow loss are priors until they are measured.
 * Sticks are what the trajectory asks for if the quad does exactly that: a
 * rate-mode quad integrates every error, so this is the starting point for
 * correcting from what the game does, not a lap by itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshBuilder } from '../src/render/mesh.ts';
import type { Obstacle } from '../src/flight/collision.ts';
import { AXIS_PITCH, AXIS_ROLL, AXIS_YAW, type RateProfile } from '../src/flight/rates.ts';
import { stickForRate } from '../src/flight/autopilot.ts';
import { trackFromSaved, type SavedVdTrack } from '../src/render/velocidrone.ts';
import { Planner } from '../src/pilot/planner.ts';
import { flatSample } from '../src/pilot/poly.ts';
import { attitudeFor, flatFromDrag, flatState, headingFrom, G } from '../src/pilot/flatness.ts';
import { type Envelope, throttleFor } from '../src/pilot/envelope.ts';
import { applyRates } from '../src/flight/rates.ts';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k: string, d: number): number => (argv.includes(`--${k}`) ? Number(argv[argv.indexOf(`--${k}`) + 1]) : d);
const trackFile = argv[0]!;
const out = argv[1]!;
mkdirSync(out, { recursive: true });

const q = JSON.parse(readFileSync('measurements/velocidrone/quad-settings.json', 'utf8')).rates as Record<'roll' | 'pitch' | 'yaw', { rcRate: number; rate: number; rcExpo: number }>;
const ax = [q.roll, q.pitch, q.yaw] as const;
const rates: RateProfile = {
  type: 'betaflight',
  rcRate: ax.map((a) => a.rcRate * 100) as [number, number, number],
  rate: ax.map((a) => a.rate * 100) as [number, number, number],
  expo: ax.map((a) => a.rcExpo * 100) as [number, number, number],
};
const envelope: Envelope = {
  alpha: 8.3,
  beta: 0.8,
  maxAccel: 85,
  inflowLoss: 0.019,
  twr: 85 / G,
  drag: { k1: 0.014, k2: 0.022 },
  points: [],
};

const imp = trackFromSaved(JSON.parse(readFileSync(trackFile, 'utf8')) as SavedVdTrack);
const course = imp.track.course!;
const obstacles: Obstacle[] = [];
imp.track.build(new MeshBuilder(), obstacles);
const aggression = opt('aggression', 0.3);
const planner = new Planner(course, obstacles, { envelope, rates, aggression }, 1);
// The optimised plan is expensive (minutes) and the rest is cheap, so it is cached.
const xFile = join(out, 'plan-x.json');
const x0 = existsSync(xFile) && !argv.includes('--replan') ? Float64Array.from(JSON.parse(readFileSync(xFile, 'utf8')) as number[]) : planner.initial(10);
const plan = planner.optimise(x0, { iterations: existsSync(xFile) && !argv.includes('--replan') ? 0 : opt('iterations', 120) });
writeFileSync(xFile, JSON.stringify(Array.from(plan.x)));
console.log(`planned: ${plan.report.lapTime.toFixed(1)} s lap, ${plan.report.time.toFixed(1)} s run at ${(aggression * 100).toFixed(0)}% of the envelope`);

// Sample the reference at radio rate and invert it.
const hz = opt('hz', 250);
const release = opt('release', 1.55);
const lead = 0.03;
const ref = flatSample();
const ff = flatSample();
const want = flatState();
const ffState = flatState();
// The quad's attitude as the game will have it: a rate-mode quad integrates
// the rates it is given, starting level on the pad. The reference leans
// forward from the first instant; the catch-up rates that get a level quad
// to that lean are part of the program (the tracker's attitude loop, run on
// this model instead of on measurements).
// On the pad the ground holds the quad level, so a pitch-over commanded there
// is lost (flown: no lean after 0.1 s of -0.47). Attitude commands wait until
// it has lifted off; throttle does not.
const LAUNCH = opt('launch', 0.3);
const KATT = opt('katt', 14);
const KYAW = opt('kyaw', 6);
const RADS = 180 / Math.PI;
const half = plan.startYaw / 2;
let mq = { w: Math.cos(half), x: 0, y: 0, z: Math.sin(half) };
const lines = ['t,thr,roll,pitch,yaw', '0.0000,0.0000,0.0000,0.0000,0.0000'];
const att = ['t,rollDeg,pitchDownDeg,yawDeg,speed'];
const times: Record<string, number> = {};
const cps = course.checkpoints;
let k = 0;
let prev: [number, number, number] | null = null;
const T = plan.report.time;
for (let i = 0; i * (1 / hz) <= T; i++) {
  const tau = i / hz;
  plan.traj.sample(tau, ref);
  plan.traj.sample(tau + lead, ff);
  const hd = headingFrom(ff.v, ff.a, plan.startYaw);
  const sp = Math.hypot(ref.v[0], ref.v[1], ref.v[2]);
  const kd = envelope.drag.k1 + envelope.drag.k2 * sp;
  // The wanted acceleration if the quad is exactly on the reference.
  const aN = ff.a[0] + kd * ref.v[0];
  const aE = ff.a[1] + kd * ref.v[1];
  const aD = ff.a[2] + kd * ref.v[2];
  flatFromDrag(ff.a, ff.j, ff.v, envelope.drag, hd.yaw, hd.yawRate, ffState);
  attitudeFor(aN, aE, aD - G, hd.yaw, want);
  const zb = want.zb;
  const inflow = -(ref.v[0] * zb[0] + ref.v[1] * zb[1] + ref.v[2] * zb[2]);
  const RAD = 180 / Math.PI;
  const thr = throttleFor(envelope, want.c, inflow);
  const qd = want.q;
  const ew = mq.w * qd.w + mq.x * qd.x + mq.y * qd.y + mq.z * qd.z;
  const ex = mq.w * qd.x - mq.x * qd.w - mq.y * qd.z + mq.z * qd.y;
  const ey = mq.w * qd.y + mq.x * qd.z - mq.y * qd.w - mq.z * qd.x;
  const ez = mq.w * qd.z - mq.x * qd.y + mq.y * qd.x - mq.z * qd.w;
  const sgn = ew < 0 ? -2 : 2;
  const wp = ffState.omega[0] + KATT * sgn * ex;
  const wq = ffState.omega[1] + KATT * sgn * ey;
  const wr = ffState.omega[2] + KYAW * sgn * ez;
  const grounded = tau < LAUNCH;
  const roll = grounded ? 0 : stickForRate(rates, AXIS_ROLL, wp * RADS);
  const pitch = grounded ? 0 : stickForRate(rates, AXIS_PITCH, -wq * RADS);
  const yaw = grounded ? 0 : stickForRate(rates, AXIS_YAW, wr * RADS);
  // The rates the game will actually deliver for those sticks (the stick is
  // clamped to the stops), integrated into the model attitude.
  {
    const P = applyRates(rates, AXIS_ROLL, roll) / RADS;
    const Q = -applyRates(rates, AXIS_PITCH, pitch) / RADS;
    const R = applyRates(rates, AXIS_YAW, yaw) / RADS;
    const dt = 1 / hz;
    const dw = 0.5 * dt * (-mq.x * P - mq.y * Q - mq.z * R);
    const dx = 0.5 * dt * (mq.w * P + mq.y * R - mq.z * Q);
    const dy = 0.5 * dt * (mq.w * Q - mq.x * R + mq.z * P);
    const dz = 0.5 * dt * (mq.w * R + mq.x * Q - mq.y * P);
    const n = Math.hypot(mq.w + dw, mq.x + dx, mq.y + dy, mq.z + dz);
    mq = { w: (mq.w + dw) / n, x: (mq.x + dx) / n, y: (mq.y + dy) / n, z: (mq.z + dz) / n };
  }
  // Where the plan says the quad is pointing (for comparing with the game).
  {
    const { w, x, y, z } = mq;
    const D = 180 / Math.PI;
    att.push([(tau + release).toFixed(3), (Math.asin(Math.max(-1, Math.min(1, 2 * (y * z + w * x)))) * D).toFixed(2), (Math.asin(Math.max(-1, Math.min(1, 2 * (x * z - w * y)))) * D).toFixed(2), (Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z)) * D).toFixed(2), sp.toFixed(2)].join(','));
  }
  // Board: forward is negative on pitch.
  lines.push(`${(tau + release).toFixed(4)},${thr.toFixed(4)},${roll.toFixed(4)},${(-pitch).toFixed(4)},${yaw.toFixed(4)}`);
  // Checkpoint crossing on the plan.
  const p: [number, number, number] = [ref.p[0], ref.p[1], -ref.p[2]];
  if (prev && k < cps.length) {
    const c = cps[k]!;
    const du = c.kind === 'gate' ? (c.dirU ?? 0) : 0;
    const cu = c.kind === 'gate' ? c.up : 0;
    const f = (s: readonly number[]): number => (s[0]! - c.north) * c.dirN + (s[1]! - c.east) * c.dirE + (s[2]! - cu) * du;
    if (f(prev) < 0 && f(p) >= 0) {
      times[String(k + 1)] = +(tau + release).toFixed(2);
      k++;
    }
  }
  prev = p;
}
writeFileSync(join(out, 'plan.csv'), lines.join('\n') + '\n');
writeFileSync(join(out, 'att.csv'), att.join('\n') + '\n');
writeFileSync(join(out, 'times.json'), JSON.stringify(times));
console.log(`${lines.length - 2} rows; checkpoints on the plan: ${Object.entries(times).slice(0, 10).map(([a, b]) => `${a}:${b}`).join(' ')}`);
