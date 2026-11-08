/**
 * Acceptance checks for the learning pilot (src/pilot/).
 *
 *   npm run check:pilot
 *
 * In the same spirit as check:flight: each check asserts something that must
 * be true of the method, not merely of this code. The trajectory must really
 * pass through the gates with continuous derivatives; the flatness inverse
 * must produce the attitude the *physics* uses, not one that agrees with
 * itself; the practice laps must really make the next lap better; and the
 * pilot must not be reading anything a Velocidrone pilot could not.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Trajectory, flatSample, solvePeriodic, solvePeriodicDense, knotSpeeds } from '../src/pilot/poly.ts';
import { attitudeFor, flatFrom, flatState, flatFromDrag, G } from '../src/pilot/flatness.ts';
import { FpvsimEnv } from '../src/pilot/env.ts';
import { measureEnvelope, fitDrag, throttleFor, thrustAt } from '../src/pilot/envelope.ts';
import { Correction } from '../src/pilot/ilc.ts';
import { flyRun, practise } from '../src/pilot/practice.ts';
import { obstacleDistance } from '../src/pilot/planner.ts';
import type { TrackerLog } from '../src/pilot/tracker.ts';
import { rotateBodyToWorld, vec3 } from '../src/flight/math.ts';
import { defaultRates } from '../src/flight/rates.ts';
import type { Obstacle } from '../src/flight/collision.ts';
import { circleTrack } from '../src/render/track.ts';
import { MeshBuilder } from '../src/render/mesh.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} — ${detail}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// A wobbly closed loop: not a circle, so nothing is symmetric by accident.
function loop(n: number): { knots: Float64Array; T: Float64Array; dirs: Float64Array } {
  const knots = new Float64Array(n * 3);
  const T = new Float64Array(n);
  const dirs = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    knots[k * 3] = 30 * Math.cos(th) + 2 * Math.sin(5 * k);
    knots[k * 3 + 1] = 22 * Math.sin(th);
    knots[k * 3 + 2] = -3 - Math.cos(3 * k);
    T[k] = 0.6 + 0.5 * Math.abs(Math.sin(k * 1.7));
    const dn = -30 * Math.sin(th);
    const de = 22 * Math.cos(th);
    const l = Math.hypot(dn, de);
    dirs[k * 3] = dn / l;
    dirs[k * 3 + 1] = de / l;
  }
  return { knots, T, dirs };
}

// ------------------------------------------------------------------ trajectory
section('Minimum-snap trajectory');
{
  const { knots, T, dirs } = loop(12);
  const start: [number, number, number] = [40, 0, -0.045];
  const tr = new Trajectory(knots, T, start, 2.0, dirs);
  const s = flatSample();
  const a = flatSample();
  const b = flatSample();

  let worstPass = 0;
  for (let k = 0; k < 12; k++) {
    const t = tr.launchTime + tr.cum[k]!;
    tr.sample(t + 1e-12, s);
    for (let ax = 0; ax < 3; ax++) worstPass = Math.max(worstPass, Math.abs(s.p[ax]! - knots[k * 3 + ax]!));
  }
  ok('passes through every knot', worstPass < 1e-6, `worst miss ${worstPass.toExponential(2)} m`);

  // Continuity to jerk at every joint, including the lap closing on itself and
  // the launch joining the lap.
  let worst = [0, 0, 0, 0];
  const joints: number[] = [tr.launchTime];
  for (let lap = 0; lap < 2; lap++) for (let k = 0; k < 12; k++) joints.push(tr.launchTime + lap * tr.lapTime + tr.cum[k]!);
  for (const t of joints) {
    tr.sample(t - 1e-9, a);
    tr.sample(t + 1e-9, b);
    const parts: (keyof typeof a)[] = ['p', 'v', 'a', 'j'];
    parts.forEach((key, d) => {
      for (let ax = 0; ax < 3; ax++) worst[d] = Math.max(worst[d]!, Math.abs(a[key][ax]! - b[key][ax]!));
    });
  }
  ok(
    'is continuous to jerk at every joint, lap closure and launch included',
    worst[0]! < 1e-6 && worst[1]! < 1e-5 && worst[2]! < 1e-4 && worst[3]! < 1e-2,
    `jumps p ${worst[0]!.toExponential(1)}, v ${worst[1]!.toExponential(1)}, a ${worst[2]!.toExponential(1)}, j ${worst[3]!.toExponential(1)}`,
  );

  tr.sample(0, s);
  const rest = Math.hypot(...s.v);
  ok(
    'starts from rest at the start position',
    rest < 1e-9 && Math.hypot(s.p[0] - start[0], s.p[1] - start[1], s.p[2] - start[2]) < 1e-9,
    `speed ${rest.toExponential(1)} m/s at t=0`,
  );

  // Velocity at each knot points along the gate's direction, forwards.
  const sp = knotSpeeds(tr.knotDerivs, dirs, 12);
  let worstAngle = 0;
  for (let k = 0; k < 12; k++) {
    const v = [0, 1, 2].map((ax) => tr.knotDerivs[(k * 4 + 1) * 3 + ax]!);
    const cos = (v[0]! * dirs[k * 3]! + v[1]! * dirs[k * 3 + 1]! + v[2]! * dirs[k * 3 + 2]!) / Math.hypot(...v);
    worstAngle = Math.max(worstAngle, Math.acos(Math.min(1, cos)));
  }
  ok(
    'crosses each knot along its pinned direction, forwards',
    worstAngle < 1e-6 && Math.min(...sp) > 0,
    `worst angle ${worstAngle.toExponential(1)} rad, slowest ${Math.min(...sp).toFixed(1)} m/s`,
  );

  // The phase index is invertible: corrections are stored against it.
  let worstPhase = 0;
  for (let t = 0; t < tr.launchTime + 2 * tr.lapTime; t += 0.137) worstPhase = Math.max(worstPhase, Math.abs(tr.timeAt(tr.phase(t)) - t));
  ok('phase and time invert each other', worstPhase < 1e-9, `worst round trip ${worstPhase.toExponential(1)} s`);

  for (const n of [3, 5, 41]) {
    const L = loop(n);
    for (const d of [L.dirs, undefined]) {
      const fast = solvePeriodic(L.knots, L.T, d);
      const dense = solvePeriodicDense(L.knots, L.T, d);
      let err = 0;
      let mag = 0;
      for (let i = 0; i < fast.length; i++) {
        err = Math.max(err, Math.abs(fast[i]! - dense[i]!));
        mag = Math.max(mag, Math.abs(dense[i]!));
      }
      ok(
        `block solve matches the dense one (${n} knots, ${d ? 'pinned direction' : 'free velocity'})`,
        err < 1e-8 * Math.max(1, mag),
        `worst difference ${err.toExponential(1)} against magnitude ${mag.toFixed(0)}`,
      );
    }
  }
}

// ------------------------------------------------------------------ flatness
section('Flatness inverse');
{
  const fs = flatState();
  flatFrom([0, 0, 0], [0, 0, 0], 0.7, 0, fs);
  const bodyDown = vec3();
  rotateBodyToWorld(bodyDown, fs.q, vec3(0, 0, 1));
  ok(
    'hover is thrust = g, level, at the asked heading',
    Math.abs(fs.c - G) < 1e-9 && Math.abs(bodyDown.z - 1) < 1e-9 && Math.abs(Math.atan2(fs.xb[1], fs.xb[0]) - 0.7) < 1e-9,
    `c ${fs.c.toFixed(4)}, body-down z ${bodyDown.z.toFixed(6)}`,
  );

  // The quaternion must agree with the physics' own rotation, not just with
  // the basis it was built from — a convention mismatch here draws a correct
  // picture of the wrong attitude.
  let worstQ = 0;
  let worstOrtho = 0;
  for (let i = 0; i < 200; i++) {
    const fN = Math.sin(i * 1.3) * 40;
    const fE = Math.cos(i * 0.7) * 40;
    const fD = -G - Math.abs(Math.sin(i * 0.37)) * 30;
    attitudeFor(fN, fE, fD, i * 0.31, fs);
    const zb = vec3();
    rotateBodyToWorld(zb, fs.q, vec3(0, 0, 1));
    const xb = vec3();
    rotateBodyToWorld(xb, fs.q, vec3(1, 0, 0));
    worstQ = Math.max(worstQ, Math.hypot(zb.x - fs.zb[0], zb.y - fs.zb[1], zb.z - fs.zb[2]), Math.hypot(xb.x - fs.xb[0], xb.y - fs.xb[1], xb.z - fs.xb[2]));
    // thrust (along -z_b) must point along f
    const c = Math.hypot(fN, fE, fD);
    worstOrtho = Math.max(worstOrtho, Math.abs(-zb.x * c - fN) + Math.abs(-zb.y * c - fE) + Math.abs(-zb.z * c - fD));
  }
  ok(
    'attitude quaternion rotates the body axes where the physics expects',
    worstQ < 1e-9 && worstOrtho < 1e-7,
    `worst axis error ${worstQ.toExponential(1)}, thrust direction error ${worstOrtho.toExponential(1)}`,
  );

  // Body rates from jerk against a numerical derivative of the exact attitude
  // along a real trajectory. Rotation between t and t+h: omega = vee(R^T dR)/h.
  const { knots, T, dirs } = loop(10);
  const tr = new Trajectory(knots, T, [40, 0, -0.045], 2, dirs);
  const s = flatSample();
  const f0 = flatState();
  const f1 = flatState();
  const fm = flatState();
  let worstRate = 0;
  let peak = 0;
  const h = 1e-5;
  for (let t = tr.launchTime + 0.05; t < tr.launchTime + tr.lapTime; t += 0.21) {
    const head = (tt: number): number => 0.3 * Math.sin(tt);
    const headRate = (tt: number): number => 0.3 * Math.cos(tt);
    tr.sample(t, s);
    flatFrom(s.a, s.j, head(t), headRate(t), fm);
    tr.sample(t - h, s);
    flatFrom(s.a, s.j, head(t - h), headRate(t - h), f0);
    tr.sample(t + h, s);
    flatFrom(s.a, s.j, head(t + h), headRate(t + h), f1);
    // dR/dt columns, projected onto the body axes at t: omega_x = dy_b . z_b, etc.
    const d = (u: number[], v: number[]) => [0, 1, 2].map((i) => (v[i]! - u[i]!) / (2 * h));
    const dyb = d(f0.yb, f1.yb);
    const dzb = d(f0.zb, f1.zb);
    const dxb = d(f0.xb, f1.xb);
    const dot = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    const num = [dot(dyb, fm.zb), dot(dzb, fm.xb), dot(dxb, fm.yb)];
    for (let i = 0; i < 3; i++) {
      worstRate = Math.max(worstRate, Math.abs(num[i]! - fm.omega[i]!));
      peak = Math.max(peak, Math.abs(fm.omega[i]!));
    }
  }
  ok(
    'body rates match the derivative of the attitude itself, all three axes',
    worstRate < 1e-4 * Math.max(1, peak),
    `worst ${worstRate.toExponential(2)} rad/s against peak ${peak.toFixed(2)} rad/s`,
  );

  // Drag: at steady speed with no acceleration, thrust has to cancel drag.
  flatFromDrag([0, 0, 0], [0, 0, 0], [20, 0, 0], { k1: 0.2, k2: 0.01 }, 0, 0, fs);
  const want = (0.2 + 0.01 * 20) * 20;
  ok(
    'with drag, steady flight needs thrust leaning into it',
    Math.abs(fs.c - Math.hypot(want, G)) < 1e-9 && fs.xb[2] > 0,
    `c ${fs.c.toFixed(3)} m/s^2 against ${Math.hypot(want, G).toFixed(3)}, nose down ${(Math.asin(fs.xb[2]) * 57.3).toFixed(1)} deg`,
  );
}

// ------------------------------------------------------------------ envelope
section('Measuring the quad without reading it');
const obstacles: Obstacle[] = [];
circleTrack.build(new MeshBuilder(), obstacles);
const course = circleTrack.course!;
const rates = defaultRates();
{
  const env = new FpvsimEnv({ rates, course, obstacles, laps: 2 });
  const e = measureEnvelope(env);
  // 8.1 is the Kronos model's figure from hover and full-throttle rpm (CLAUDE.md).
  ok('thrust-to-weight comes out where the model says it is', e.twr > 7.6 && e.twr < 8.6, `TWR ${e.twr.toFixed(2)} (model 8.1)`);
  ok('and thrust falls with inflow', e.inflowLoss > 0.005 && e.inflowLoss < 0.05, `${(e.inflowLoss * 100).toFixed(2)}% per m/s`);
  const hover = throttleFor(e, G);
  ok('hover throttle is plausible for an 8:1 quad', hover > 0.1 && hover < 0.35, `hover at ${(hover * 100).toFixed(0)}% stick`);
  let mono = true;
  for (let u = 0.05; u <= 1; u += 0.05) if (thrustAt(e, u) < thrustAt(e, u - 0.05) - 1e-9) mono = false;
  ok('the throttle curve is monotonic', mono, 'thrust never falls as the stick rises');

  const heavy = new FpvsimEnv({ rates, course, obstacles, laps: 2, massScale: 1.3 });
  const eh = measureEnvelope(heavy);
  ok(
    'a 30% heavier quad measures 30% weaker, though nobody told the pilot',
    Math.abs(eh.twr * 1.3 - e.twr) / e.twr < 0.04,
    `TWR ${eh.twr.toFixed(2)} x 1.3 = ${(eh.twr * 1.3).toFixed(2)} against ${e.twr.toFixed(2)}`,
  );

  // Drag fit on synthetic samples with known coefficients.
  const truth = { k1: 0.18, k2: 0.004 };
  const samples: { fb: number[]; vel: number[]; up: number }[] = [];
  for (let i = 0; i < 400; i++) {
    const sp = 3 + (i % 40);
    const dir = [Math.cos(i), Math.sin(i), 0.1 * Math.sin(3 * i)];
    const l = Math.hypot(...dir);
    const v = dir.map((x) => (x / l) * sp);
    const push = (truth.k1 + truth.k2 * sp) * sp;
    samples.push({ fb: v.map((x) => (x / sp) * push), vel: v, up: 2 });
  }
  const fit = fitDrag(samples, { k1: 0, k2: 0 });
  ok('drag fit recovers known coefficients', Math.abs(fit.k1 - truth.k1) < 1e-6 && Math.abs(fit.k2 - truth.k2) < 1e-7, `k1 ${fit.k1.toFixed(4)}, k2 ${fit.k2.toFixed(5)}`);
  const refit = fitDrag(
    samples.map((x) => ({ ...x, fb: x.fb.map(() => 0) })),
    truth,
  );
  ok('and a refit with drag already right leaves it alone', Math.abs(refit.k1 - truth.k1) < 1e-6, `k1 ${refit.k1.toFixed(4)}`);
}

// ------------------------------------------------------------------ learning
section('Learning');
{
  const c = new Correction(10, 2, 12);
  const log: TrackerLog[] = [];
  for (let ph = -1; ph < 25; ph += 0.01) {
    log.push({ t: 0, tau: 0, phase: ph, fb: [2, -1, 0.5], err: 0, up: ph < -0.5 ? 0.1 : 2, vel: [0, 0, 0], sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 } });
  }
  c.learn(log, 0.5, 2);
  const mid = c.at(10);
  ok('a constant feedback is learned as a constant correction', Math.abs(mid[0] - 1) < 1e-6 && Math.abs(mid[1] + 0.5) < 1e-6, `${mid.map((x) => x.toFixed(3)).join(', ')} (expected 1, -0.5, 0.25)`);
  const ground = c.at(-0.9);
  ok('nothing is learned while sitting on the ground', Math.abs(ground[0]) < 0.2, `correction at the start ${ground[0].toFixed(3)} (smoothing leaks a little in, not the ground)`);
}

// ------------------------------------------------------------------ boundary
section('The pilot sees what a pilot sees');
{
  // Only env.ts may touch the flight model. Everything else gets state through
  // the interface — the property that has to survive a move to Velocidrone.
  const dir = 'src/pilot';
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f === 'env.ts') continue;
    // Code only: the prose explains what is *not* read, by name.
    const src = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const line of src.split('\n')) {
      if (!line.startsWith('import ')) continue;
      if (/from '\.\.\/flight\/(sim|airframe|motor|rotor|mixer|pid|battery)\.ts'/.test(line) && !line.startsWith('import type')) {
        offenders.push(`${f}: ${line.trim()}`);
      }
    }
    if (/\.airframe\b|\.telemetry\b|kronos\(/.test(src)) offenders.push(`${f}: reads the airframe or telemetry`);
  }
  ok('nothing outside env.ts reaches into the flight model', offenders.length === 0, offenders.join('; ') || 'only env.ts imports it');
}

// ------------------------------------------------------------------ obstacles
section('Clearance');
{
  const pole: Obstacle = { kind: 'cylinder', north: 0, east: 0, radius: 0.1, height: 5 };
  const box: Obstacle = { kind: 'box', minNorth: -1, maxNorth: 1, minEast: -1, maxEast: 1, minUp: 0, maxUp: 2 };
  const tube: Obstacle = { kind: 'ring', north: 0, east: 0, up: 3, radius: 1, thickness: 0.2, halfLength: 2, axis: 'north' };
  const cases: [string, number, number][] = [
    ['beside a pole', obstacleDistance(pole, 1.1, 0, 2), 1.0],
    ['above a pole', obstacleDistance(pole, 0, 0, 6), 1.0],
    ['outside a box', obstacleDistance(box, 3, 0, 1), 2.0],
    ['inside a box', obstacleDistance(box, 0.5, 0, 1), -0.5],
    ['down the bore of a tube', obstacleDistance(tube, 0, 0, 3), 1.0],
    ['in the wall of a tube', obstacleDistance(tube, 0, 1.1, 3), -0.1],
  ];
  for (const [name, got, want] of cases) ok(`distance ${name}`, Math.abs(got - want) < 1e-9, `${got.toFixed(3)} m (expected ${want})`);
}

// ------------------------------------------------------------------ practice
section('Practice laps on the Circle');
{
  const env = new FpvsimEnv({ rates, course, obstacles, laps: 2 });
  const t0 = performance.now();
  const s = practise(env, course, obstacles, rates, { laps: 2, schedule: [0.5, 0.6], runsPerRound: 3, planIterations: 120 });
  const wall = (performance.now() - t0) / 1000;
  const best = s.best;
  ok('a session produces a clean run, by the race timer', best !== null && best.run.finished && !best.run.crashed, best ? `laps ${best.run.laps.map((t) => t.toFixed(2)).join(' / ')} in ${wall.toFixed(0)} s` : 'none');
  if (best) {
    const planned = best.plan.report.lapTime;
    const flown = Math.min(...best.run.laps);
    ok('the lap flown is the lap planned', Math.abs(flown - planned) < 0.1, `flew ${flown.toFixed(3)} s, planned ${planned.toFixed(3)} s`);
    ok('and it beats the parked bot (11.29 s)', flown < 11.29, `${flown.toFixed(2)} s`);
    let inRange = true;
    for (const { s: st } of best.run.sticks) {
      if (!(st.throttle >= 0 && st.throttle <= 1 && Math.abs(st.roll) <= 1 && Math.abs(st.pitch) <= 1 && Math.abs(st.yaw) <= 1)) inRange = false;
    }
    ok('every stick stays inside its gimbal', inRange, `${best.run.sticks.length} radio frames`);
    let mono = true;
    for (let i = 1; i < best.run.log.length; i++) if (best.run.log[i]!.tau < best.run.log[i - 1]!.tau) mono = false;
    ok('the reference clock never runs backwards', mono, 'time warp only slows it');
  }
  // Practice must actually improve tracking: same plan, a fresh correction,
  // three runs. Measured on the plan directly rather than across a session
  // round, because a round stops as soon as it is good enough and so may
  // never show the improvement it has already banked.
  if (best) {
    const corr = new Correction(best.plan.traj.n, 2);
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const r = flyRun(env, best.plan, course, s.envelope, rates, corr);
      runs.push(r);
      corr.learn(r.log, 0.6, 2);
    }
    const a = runs[0]!;
    const z = runs[2]!;
    ok(
      'practice makes the next run track better',
      z.finished && z.feedbackRms < a.feedbackRms * 0.8 && z.peakError < a.peakError,
      `feedback ${a.feedbackRms.toFixed(2)} -> ${z.feedbackRms.toFixed(2)} m/s^2, peak error ${a.peakError.toFixed(2)} -> ${z.peakError.toFixed(2)} m`,
    );
  }
}

section('A quad that is not the one expected');
{
  const env = new FpvsimEnv({ rates, course, obstacles, laps: 2, massScale: 1.3 });
  const s = practise(env, course, obstacles, rates, { laps: 2, schedule: [0.5], runsPerRound: 3, planIterations: 120 });
  ok(
    '30% heavier, and it still learns a clean lap',
    s.best !== null,
    s.best ? `laps ${s.best.run.laps.map((t) => t.toFixed(2)).join(' / ')}, TWR measured ${s.envelope.twr.toFixed(2)}` : 'no clean run',
  );
}

// ------------------------------------------------------------------ report
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
