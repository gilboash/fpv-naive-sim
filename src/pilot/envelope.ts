/**
 * What the aircraft can do, measured by flying it rather than read from its
 * spec.
 *
 * The planner needs two numbers it must not assume: how much thrust the quad
 * has, and how throttle maps onto it. Reading them from `kronos()` would work
 * here and nowhere else — in Velocidrone there is no airframe object to read.
 * So the pilot does what a person does with an unfamiliar quad: punches out a
 * few times from the start line and feels how hard it pulls.
 *
 * Thrust over mass, never thrust: the mass is not observable either, and the
 * planner only ever needs the acceleration.
 */

import type { PilotEnv, Observation } from './env.ts';
import { observation } from './env.ts';
import { G, type Drag, noDrag } from './flatness.ts';

export interface Envelope {
  /** sqrt(static specific thrust) = alpha * throttle + beta, fitted below the plateau. */
  alpha: number;
  beta: number;
  /** Peak static specific thrust, m/s^2: where the stick stops making a difference. */
  maxAccel: number;
  /**
   * Fractional thrust lost per m/s of inflow along the thrust axis. Measured,
   * because it is large: the Kronos model loses a quarter of its thrust by
   * 25 m/s of climb, and a racing quad at full speed is flying straight up its
   * own thrust axis. A planner that assumes the static figure at speed is
   * asking for thrust that is not there.
   */
  inflowLoss: number;
  /** Thrust-to-weight, static, for reporting. */
  twr: number;
  /** Learned from the first practice run; zero until then. */
  drag: Drag;
  /** The raw points, throttle -> peak m/s^2, for the report. */
  points: [number, number][];
}

/** How much of the static thrust is left at this inflow speed. */
export function inflowFactor(env: Envelope, inflow: number): number {
  return Math.max(0.25, 1 - env.inflowLoss * Math.max(0, inflow));
}

/** Static specific thrust at a throttle position. */
export function thrustAt(env: Envelope, throttle: number): number {
  const r = Math.max(0, env.alpha * throttle + env.beta);
  return Math.min(env.maxAccel, r * r);
}

/** Throttle for a wanted specific thrust at a given inflow, clamped to the stick. */
export function throttleFor(env: Envelope, accel: number, inflow = 0): number {
  const a = accel / inflowFactor(env, inflow);
  const u = (Math.sqrt(Math.max(0, a)) - env.beta) / env.alpha;
  return Math.min(1, Math.max(0, u));
}

/** Peak acceleration over sliding windows, and the climb-rate history. */
function punch(
  env: PilotEnv,
  u: number,
  seconds: number,
): { peak: number; trace: [number, number][] } {
  const obs: Observation = observation();
  const dt = 0.005;
  const win = 4; // 20 ms
  const vs: number[] = [];
  const trace: [number, number][] = [];
  env.reset();
  let t = 0;
  while (t < seconds && !env.crashed) {
    env.advance({ throttle: u, roll: 0, pitch: 0, yaw: 0 }, dt);
    t += dt;
    env.observe(obs);
    vs.push(-obs.vel[2]);
  }
  let peak = -Infinity;
  for (let i = win; i < vs.length; i++) {
    const a = (vs[i]! - vs[i - win]!) / (win * dt) + G;
    // Only once off the ground, or the ground reaction is in it.
    if (vs[i - win]! > 0.05) peak = Math.max(peak, a);
    trace.push([(vs[i]! + vs[i - win]!) / 2, a]);
  }
  return { peak, trace };
}

/**
 * Punch out from the start at several throttle positions and fit the curve.
 *
 * Each punch starts from a reset, so every one begins level, still and on the
 * ground. Peak acceleration is the static figure — taken after spin-up and
 * before the climb is fast enough to eat into it. The full-throttle punch is
 * held longer, and the way its acceleration falls with climb speed is the
 * inflow loss.
 */
export function measureEnvelope(env: PilotEnv, levels = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]): Envelope {
  const raw: [number, number][] = [];
  for (const u of levels) {
    const { peak } = punch(env, u, 0.3);
    if (Number.isFinite(peak) && peak > G) raw.push([u, peak]);
  }
  if (raw.length < 2) throw new Error('measureEnvelope: the quad never left the ground');
  const maxAccel = Math.max(...raw.map((p) => p[1]));
  // Fit only below the plateau: a stick position that adds nothing would drag
  // the slope down and make every lower throttle read wrong.
  const fitPts = raw.filter((p) => p[1] < maxAccel * 0.97);
  const use = fitPts.length >= 2 ? fitPts : raw;
  const n = use.length;
  const xs = use.map((p) => p[0]);
  const ys = use.map((p) => Math.sqrt(p[1]));
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const alpha = num / den;
  const beta = my - alpha * mx;

  // Inflow: a long full-throttle punch, after the peak.
  const { trace } = punch(env, 1, 0.6);
  let iPeak = 0;
  for (let i = 0; i < trace.length; i++) if (trace[i]![1] > trace[iPeak]![1]) iPeak = i;
  const tail = trace.slice(iPeak);
  let inflowLoss = 0;
  if (tail.length > 5) {
    const tx = tail.map((p) => p[0]);
    // Thrust is acceleration plus gravity, so fit (a) not (a - G).
    const ty = tail.map((p) => p[1]);
    const m = tail.length;
    const ax = tx.reduce((s, x) => s + x, 0) / m;
    const ay = ty.reduce((s, x) => s + x, 0) / m;
    let nn = 0;
    let dd = 0;
    for (let i = 0; i < m; i++) {
      nn += (tx[i]! - ax) * (ty[i]! - ay);
      dd += (tx[i]! - ax) ** 2;
    }
    const slope = nn / dd; // m/s^2 per m/s, negative
    inflowLoss = Math.max(0, -slope / maxAccel);
  }
  env.reset();
  return { alpha, beta, maxAccel, inflowLoss, twr: maxAccel / G, drag: noDrag(), points: raw };
}

/**
 * Fit drag to what the feedback had to push along the direction of travel.
 *
 * `extra` is the drag already in the model when the run was flown, so the fit
 * is of the total and a second fit refines rather than compounds the first.
 * Least squares of push against |v| and |v|^2, through the origin — no drag at
 * rest — with both coefficients kept non-negative, because negative drag is a
 * symptom of something else and should not be learned as physics.
 */
export function fitDrag(
  samples: readonly { fb: readonly number[]; vel: readonly number[]; up: number }[],
  extra: Drag,
): Drag {
  let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
  for (const e of samples) {
    const sp = Math.hypot(e.vel[0]!, e.vel[1]!, e.vel[2]!);
    if (sp < 3 || e.up < 0.3) continue;
    const along = (e.fb[0]! * e.vel[0]! + e.fb[1]! * e.vel[1]! + e.fb[2]! * e.vel[2]!) / sp;
    const y = along + (extra.k1 + extra.k2 * sp) * sp;
    const x1 = sp;
    const x2 = sp * sp;
    s11 += x1 * x1;
    s12 += x1 * x2;
    s22 += x2 * x2;
    b1 += x1 * y;
    b2 += x2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  if (s11 === 0 || Math.abs(det) < 1e-12) return { ...extra };
  let k1 = (b1 * s22 - b2 * s12) / det;
  let k2 = (s11 * b2 - s12 * b1) / det;
  if (k1 < 0) {
    k1 = 0;
    k2 = Math.max(0, b2 / s22);
  } else if (k2 < 0) {
    k2 = 0;
    k1 = Math.max(0, b1 / s11);
  }
  return { k1, k2 };
}
