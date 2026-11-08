/**
 * The line: a minimum-snap lap through the checkpoints, with its timing pushed
 * as hard as the measured envelope allows.
 *
 * What is free:
 *  - where the line crosses each aperture (two numbers per checkpoint),
 *  - how fast and at what angle it crosses (three),
 *  - how long each segment takes (one), and the launch.
 *
 * What is penalised, sampled along the line through the flatness inverse:
 *  - more thrust than the envelope has *at that inflow speed*,
 *  - less thrust than idle (a quad cannot pull down),
 *  - body rates beyond what full stick asks for on the pilot's own rate curve,
 *  - the ground, and every collision volume on the map.
 *
 * Every limit carries a margin, `aggression`, because a line flown at 100% of
 * the envelope leaves the feedback nothing to correct with. The practice laps
 * raise it.
 *
 * This is not time-optimal control. A polynomial cannot be bang-bang, and the
 * search is a penalty method with a numerical gradient. What it is, unlike the
 * parked spline, is a trajectory the airframe can fly, with derivatives that
 * are exact.
 */

import type { Course, Checkpoint } from '../race/course.ts';
import { planeAxes } from '../race/race.ts';
import type { Obstacle } from '../flight/collision.ts';
import type { RateProfile } from '../flight/rates.ts';
import { maxRate, AXIS_ROLL, AXIS_PITCH, AXIS_YAW } from '../flight/rates.ts';
import { Trajectory, flatSample, knotSpeeds } from './poly.ts';
import { flatFromDrag, flatState, headingFrom, G } from './flatness.ts';
import { type Envelope, inflowFactor } from './envelope.ts';

const DEG = Math.PI / 180;
/** Clearance kept from anything solid, m: arm radius plus a bit. */
const OBSTACLE_MARGIN = 0.55;
/** Kept off the frame of an aperture, m. */
const APERTURE_MARGIN = 0.6;
/** Lowest the line may go away from the start, m. */
const FLOOR = 0.8;

export interface PlanLimits {
  envelope: Envelope;
  rates: RateProfile;
  /** Fraction of the envelope the line may use, 0..1. */
  aggression: number;
}

/** Signed distance from a point (NED) to an obstacle. Negative inside. */
export function obstacleDistance(o: Obstacle, n: number, e: number, u: number): number {
  if (o.kind === 'cylinder') {
    const radial = Math.hypot(n - o.north, e - o.east) - o.radius;
    const vert = Math.max(-u, u - o.height); // below ground or above the top
    if (radial <= 0 && vert <= 0) return Math.max(radial, vert);
    return Math.hypot(Math.max(0, radial), Math.max(0, vert));
  }
  if (o.kind === 'box') {
    const cx = (o.minNorth + o.maxNorth) / 2;
    const cy = (o.minEast + o.maxEast) / 2;
    const cz = (o.minUp + o.maxUp) / 2;
    const qx = Math.abs(n - cx) - (o.maxNorth - o.minNorth) / 2;
    const qy = Math.abs(e - cy) - (o.maxEast - o.minEast) / 2;
    const qz = Math.abs(u - cz) - (o.maxUp - o.minUp) / 2;
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    return out + Math.min(Math.max(qx, qy, qz), 0);
  }
  // Ring: an annulus swept along an axis — a 2D box in (radial, along).
  let along: number;
  let radial: number;
  if (o.axis === 'north') {
    along = n - o.north;
    radial = Math.hypot(e - o.east, u - o.up);
  } else if (o.axis === 'east') {
    along = e - o.east;
    radial = Math.hypot(n - o.north, u - o.up);
  } else {
    along = u - o.up;
    radial = Math.hypot(n - o.north, e - o.east);
  }
  const qr = Math.abs(radial - (o.radius + o.thickness / 2)) - o.thickness / 2;
  const qa = Math.abs(along) - o.halfLength;
  return Math.hypot(Math.max(qr, 0), Math.max(qa, 0)) + Math.min(Math.max(qr, qa), 0);
}

/** A conservative box round an obstacle, for culling. NEU. */
function obstacleBounds(o: Obstacle): [number, number, number, number, number, number] {
  if (o.kind === 'cylinder') {
    return [o.north - o.radius, o.north + o.radius, o.east - o.radius, o.east + o.radius, 0, o.height];
  }
  if (o.kind === 'box') return [o.minNorth, o.maxNorth, o.minEast, o.maxEast, o.minUp, o.maxUp];
  const r = o.radius + o.thickness;
  const L = o.halfLength;
  if (o.axis === 'north') return [o.north - L, o.north + L, o.east - r, o.east + r, o.up - r, o.up + r];
  if (o.axis === 'east') return [o.north - r, o.north + r, o.east - L, o.east + L, o.up - r, o.up + r];
  return [o.north - r, o.north + r, o.east - r, o.east + r, o.up - L, o.up + L];
}

/** Per checkpoint: the in-plane axes and allowed ranges, precomputed. */
interface CheckpointFrame {
  /** Centre, NED. */
  c: [number, number, number];
  /** Normal (way through), NED. */
  nrm: [number, number, number];
  /** First and second in-plane axes, NED. */
  a1: [number, number, number];
  a2: [number, number, number];
  /** Offset along a1 = mid1 + half1 * tanh(x). */
  mid1: number;
  half1: number;
  mid2: number;
  half2: number;
}

function frameFor(cp: Checkpoint): CheckpointFrame {
  if (cp.kind === 'gate') {
    const dU = cp.dirU ?? 0;
    const [ax, ay] = planeAxes(cp.dirN, cp.dirE, dU);
    return {
      c: [cp.north, cp.east, -cp.up],
      nrm: [cp.dirN, cp.dirE, -dU],
      a1: [ax[0], ax[1], -ax[2]],
      a2: [ay[0], ay[1], -ay[2]],
      mid1: 0,
      half1: Math.max(0.05, cp.halfWidth - APERTURE_MARGIN),
      mid2: 0,
      half2: Math.max(0.05, cp.halfHeight - APERTURE_MARGIN),
    };
  }
  // A flag: pass on `side`, between 1 m from the pole and passWidth less a
  // margin, at a height between 1.2 m and the top of the pole.
  const lo = 1.0;
  const hi = Math.max(lo + 0.2, cp.passWidth - 0.6);
  const s = cp.side;
  const top = Math.max(1.6, Math.min(cp.height - 0.5, 5));
  return {
    c: [cp.north, cp.east, 0],
    nrm: [cp.dirN, cp.dirE, 0],
    // across = (-dirE, dirN); positive `across * side` is the legal side.
    a1: [-cp.dirE * s, cp.dirN * s, 0],
    a2: [0, 0, -1],
    mid1: (lo + hi) / 2,
    half1: (hi - lo) / 2,
    mid2: (1.2 + top) / 2,
    half2: (top - 1.2) / 2,
  };
}

/** Index layout of the decision vector. */
export interface PlanLayout {
  /** Checkpoints. */
  n: number;
  /** Free waypoints between checkpoints, where the line has to loop. */
  m: number;
  /** Per checkpoint, 4 numbers: offset1, offset2, lean1, lean2. */
  cpBase: number;
  /** Per waypoint, 5 numbers: north, east, down offsets, heading, climb angle. */
  viaBase: number;
  /** Then one log-duration per segment (n + m), then the launch log-duration. */
  tBase: number;
  launchIdx: number;
  size: number;
}

function layout(n: number, m: number): PlanLayout {
  const viaBase = 4 * n;
  const tBase = viaBase + 5 * m;
  return { n, m, cpBase: 0, viaBase, tBase, launchIdx: tBase + n + m, size: tBase + n + m + 1 };
}

/**
 * A knot of the line: a checkpoint, or a free waypoint where the line has to
 * loop between two of them.
 *
 * The polynomial has one segment per pair of knots, so a loop between two
 * checkpoints — south through gate 4, north round pole 5, all the way round to
 * come north through gate 6 — had to be one degree-7 curve, which bends that
 * far only by demanding five times the turn rate the quad has. A waypoint
 * lets the search place the loop.
 */
type Knot = { kind: 'cp'; i: number } | { kind: 'via'; j: number };

interface Via {
  /** Initial position, NED, and direction of travel. */
  p: [number, number, number];
  d: [number, number, number];
}

/** How far out from a checkpoint the line is assumed to keep straight, m. */
const VIA_LEAD = 3;
/** A segment turning more than this at either end gets waypoints. */
const VIA_TURN = (120 * Math.PI) / 180;

/** Largest a gate crossing's angle may lean off its normal, as tan. */
const MAX_LEAN = 0.6;

export interface PlanReport {
  time: number;
  lapTime: number;
  launchTime: number;
  penalty: number;
  /** Worst use of each limit, as a fraction of what is allowed. */
  thrustUse: number;
  rateUse: number;
  minClearance: number;
  minAltitude: number;
}

/** A planned line and the numbers that made it. */
export interface Plan {
  traj: Trajectory;
  x: Float64Array;
  report: PlanReport;
  startYaw: number;
}

export class Planner {
  readonly course: Course;
  readonly laps: number;
  readonly frames: CheckpointFrame[];
  readonly lay: PlanLayout;
  /** The knots in order round the lap. */
  readonly knots: Knot[];
  readonly vias: Via[];
  private obstacles: readonly Obstacle[];
  private bounds: [number, number, number, number, number, number][];
  private start: [number, number, number];
  readonly startYaw: number;
  limits: PlanLimits;
  /** Penalty weight; raised during the search. */
  mu = 30;
  /** Weight on integrated jerk squared, s per (m/s^3)^2 s. */
  smooth = 2e-6;
  private lastDirs: Float64Array = new Float64Array(0);
  /** Sample spacing for the penalties, s. */
  sampleDt = 0.01;

  constructor(course: Course, obstacles: readonly Obstacle[], limits: PlanLimits, laps: number, standHeight = 0.045) {
    this.course = course;
    this.laps = laps;
    this.limits = limits;
    this.frames = course.checkpoints.map(frameFor);
    const { knots, vias } = placeVias(this.frames);
    this.knots = knots;
    this.vias = vias;
    this.lay = layout(course.checkpoints.length, vias.length);
    this.obstacles = obstacles;
    this.bounds = obstacles.map(obstacleBounds);
    this.start = [course.start.north, course.start.east, -standHeight];
    this.startYaw = course.start.yawDeg * DEG;
  }

  /** Segments of the line per lap: checkpoints plus waypoints. */
  get segments(): number {
    return this.knots.length;
  }

  /** A cautious first guess: through the centres, square on, at `speed`. */
  initial(speed = 10): Float64Array {
    const { viaBase, tBase, launchIdx, size } = this.lay;
    const x = new Float64Array(size);
    for (let j = 0; j < this.vias.length; j++) {
      const d = this.vias[j]!.d;
      x[viaBase + j * 5 + 3] = Math.atan2(d[1], d[0]);
      x[viaBase + j * 5 + 4] = Math.asin(Math.max(-1, Math.min(1, -d[2])));
    }
    const K = this.knots.length;
    const pos = (k: Knot): [number, number, number] =>
      k.kind === 'cp' ? this.knotOf(this.frames[k.i]!, 0, 0) : this.vias[k.j]!.p;
    const dir = (k: Knot): [number, number, number] => (k.kind === 'cp' ? this.frames[k.i]!.nrm : this.vias[k.j]!.d);
    for (let s = 0; s < K; s++) {
      const a = this.knots[s]!;
      const b = this.knots[(s + 1) % K]!;
      const ca = pos(a);
      const cb = pos(b);
      const d = Math.hypot(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]);
      // A segment that has to turn round needs longer than its chord says.
      const na = dir(a);
      const nb = dir(b);
      const turn = 1 - (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
      x[tBase + s] = Math.log(Math.max(0.4, (d / speed) * (1 + 0.8 * turn) + 0.3 * turn));
    }
    const k0 = this.knotOf(this.frames[0]!, 0, 0);
    const dl = Math.hypot(k0[0] - this.start[0], k0[1] - this.start[1], k0[2] - this.start[2]);
    x[launchIdx] = Math.log(Math.max(1.0, (2 * dl) / speed + 0.6));
    return x;
  }

  private knotOf(f: CheckpointFrame, x1: number, x2: number): [number, number, number] {
    const o1 = f.mid1 + f.half1 * Math.tanh(x1);
    const o2 = f.mid2 + f.half2 * Math.tanh(x2);
    return [
      f.c[0] + f.a1[0] * o1 + f.a2[0] * o2,
      f.c[1] + f.a1[1] * o1 + f.a2[1] * o2,
      f.c[2] + f.a1[2] * o1 + f.a2[2] * o2,
    ];
  }

  /** Decision vector to trajectory. Throws on a singular solve. */
  build(x: Float64Array): Trajectory {
    const { cpBase, viaBase, tBase, launchIdx } = this.lay;
    const K = this.knots.length;
    const knots = new Float64Array(K * 3);
    const dirs = new Float64Array(K * 3);
    const T = new Float64Array(K);
    for (let s = 0; s < K; s++) {
      const kn = this.knots[s]!;
      let k: [number, number, number];
      let dN: number, dE: number, dD: number;
      if (kn.kind === 'cp') {
        const f = this.frames[kn.i]!;
        const b = cpBase + kn.i * 4;
        k = this.knotOf(f, x[b]!, x[b + 1]!);
        const l1 = MAX_LEAN * Math.tanh(x[b + 2]!);
        const l2 = MAX_LEAN * Math.tanh(x[b + 3]!);
        dN = f.nrm[0] + f.a1[0] * l1 + f.a2[0] * l2;
        dE = f.nrm[1] + f.a1[1] * l1 + f.a2[1] * l2;
        dD = f.nrm[2] + f.a1[2] * l1 + f.a2[2] * l2;
      } else {
        const v = this.vias[kn.j]!;
        const b = viaBase + kn.j * 5;
        k = [v.p[0] + x[b]!, v.p[1] + x[b + 1]!, v.p[2] + x[b + 2]!];
        const hd = x[b + 3]!;
        const cl = 0.8 * Math.tanh(x[b + 4]!);
        dN = Math.cos(hd) * Math.cos(cl);
        dE = Math.sin(hd) * Math.cos(cl);
        dD = -Math.sin(cl);
      }
      knots[s * 3] = k[0];
      knots[s * 3 + 1] = k[1];
      knots[s * 3 + 2] = k[2];
      const dl = Math.hypot(dN, dE, dD);
      dirs[s * 3] = dN / dl;
      dirs[s * 3 + 1] = dE / dl;
      dirs[s * 3 + 2] = dD / dl;
      T[s] = Math.exp(x[tBase + s]!);
    }
    this.lastDirs = dirs;
    return new Trajectory(knots, T, this.start, Math.exp(x[launchIdx]!), dirs);
  }

  /** Objective and its breakdown. */
  evaluate(x: Float64Array): { cost: number; report: PlanReport; traj: Trajectory | null } {
    let traj: Trajectory;
    try {
      traj = this.build(x);
    } catch {
      return { cost: 1e9, report: emptyReport(), traj: null };
    }
    const lim = this.limits;
    const env = lim.envelope;
    const rateLimRP = Math.min(maxRate(lim.rates, AXIS_ROLL), maxRate(lim.rates, AXIS_PITCH)) * DEG * lim.aggression;
    const rateLimY = maxRate(lim.rates, AXIS_YAW) * DEG * lim.aggression;
    const cMin = 0.2 * G;
    const s = flatSample();
    const fs = flatState();
    let pen = 0;
    // Through every checkpoint forwards, and briskly: the solve picks the
    // speed, and nothing in snap stops it picking a negative one.
    const speeds = knotSpeeds(traj.knotDerivs, this.lastDirs, traj.n);
    for (let i = 0; i < traj.n; i++) {
      const sp = speeds[i]!;
      if (sp < 2) pen += ((2 - sp) / 2) ** 2 * 50;
    }
    let thrustUse = 0;
    let rateUse = 0;
    let jerk2 = 0;
    let minClear = Infinity;
    let minAlt = Infinity;
    const dt = this.sampleDt;
    const tEnd = traj.launchTime + traj.lapTime;
    // Cull obstacles once per run against the whole sampled line's box would
    // keep everything on a circuit; per stretch of ~0.5 s is the useful grain.
    const chunk = 50;
    const pts: number[] = [];
    for (let t0 = 0; t0 < tEnd; t0 += dt * chunk) {
      pts.length = 0;
      let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
      for (let k = 0; k < chunk; k++) {
        const t = t0 + k * dt;
        if (t >= tEnd) break;
        traj.sample(t, s);
        const inLaunch = t < traj.launchTime;
        const hd = headingFrom(s.v, s.a, this.startYaw);
        flatFromDrag(s.a, s.j, s.v, env.drag, hd.yaw, hd.yawRate, fs);
        const inflow = -(s.v[0] * fs.zb[0] + s.v[1] * fs.zb[1] + s.v[2] * fs.zb[2]);
        const cMax = env.maxAccel * inflowFactor(env, inflow) * lim.aggression;
        const tu = fs.c / cMax;
        if (tu > thrustUse) thrustUse = tu;
        if (fs.c > cMax) pen += ((fs.c - cMax) / cMax) ** 2;
        if (fs.c < cMin) pen += ((cMin - fs.c) / cMin) ** 2;
        const rp = Math.max(Math.abs(fs.omega[0]), Math.abs(fs.omega[1])) / rateLimRP;
        const ry = Math.abs(fs.omega[2]) / rateLimY;
        const ru = Math.max(rp, ry);
        if (ru > rateUse) rateUse = ru;
        if (rp > 1) pen += (rp - 1) ** 2;
        if (ry > 1) pen += (ry - 1) ** 2;
        const up = -s.p[2];
        if (!inLaunch) {
          if (up < minAlt) minAlt = up;
          if (up < FLOOR) pen += ((FLOOR - up) / FLOOR) ** 2 * 4;
        } else if (up < -this.start[2] - 0.02) {
          pen += (-this.start[2] - 0.02 - up) ** 2 * 100;
        }
        jerk2 += s.j[0] * s.j[0] + s.j[1] * s.j[1] + s.j[2] * s.j[2];
        pts.push(s.p[0], s.p[1], up);
        if (s.p[0] < lo0) lo0 = s.p[0];
        if (s.p[0] > hi0) hi0 = s.p[0];
        if (s.p[1] < lo1) lo1 = s.p[1];
        if (s.p[1] > hi1) hi1 = s.p[1];
        if (up < lo2) lo2 = up;
        if (up > hi2) hi2 = up;
      }
      const m = OBSTACLE_MARGIN;
      for (let oi = 0; oi < this.obstacles.length; oi++) {
        const b = this.bounds[oi]!;
        if (b[1] < lo0 - m || b[0] > hi0 + m || b[3] < lo1 - m || b[2] > hi1 + m || b[5] < lo2 - m || b[4] > hi2 + m) continue;
        const o = this.obstacles[oi]!;
        for (let k = 0; k < pts.length; k += 3) {
          const d = obstacleDistance(o, pts[k]!, pts[k + 1]!, pts[k + 2]!);
          if (d < minClear) minClear = d;
          if (d < m) pen += ((m - d) / m) ** 2 * 4;
        }
      }
    }
    pen *= dt;
    const time = traj.launchTime + this.laps * traj.lapTime;
    return {
      // The jerk term is a tie-breaker, not an objective: among lines of equal
      // time it prefers the one that does not wiggle, which is the one a
      // controller can follow.
      cost: time + this.mu * pen + this.smooth * jerk2 * dt,
      report: {
        time,
        lapTime: traj.lapTime,
        launchTime: traj.launchTime,
        penalty: pen,
        thrustUse,
        rateUse,
        minClearance: minClear,
        minAltitude: minAlt,
      },
      traj,
    };
  }

  /**
   * Search. Adam on a forward-difference gradient, with the penalty weight
   * raised in stages so the line first finds the feasible region and is then
   * held to it.
   *
   * Timing first, geometry second. Freeing everything at once let the search
   * trade a bit of offset at one gate against a bit of time at the next, and
   * the result on the circle — where the optimum is plainly uniform — wandered
   * between 25 and 35 m/s from gate to gate.
   */
  optimise(x0: Float64Array, opts: { iterations?: number; log?: (s: string) => void } = {}): Plan {
    const iters = opts.iterations ?? 300;
    const N = x0.length;
    const timing = new Uint8Array(N);
    for (let i = this.lay.tBase; i < N; i++) timing[i] = 1;
    const all = new Uint8Array(N).fill(1);
    let x = this.scaleSearch(x0);
    x = this.descend(x, timing, Math.ceil(iters * 0.4), [30, 300, 3000], opts.log);
    x = this.descend(x, all, Math.ceil(iters * 0.6), [300, 3000], opts.log);
    const ev = this.evaluate(x);
    return { traj: ev.traj!, x, report: ev.report, startYaw: this.startYaw };
  }

  /**
   * Scale every duration together to the cheapest point on that line — a
   * one-dimensional golden-section search that does in twenty evaluations
   * what the gradient takes a hundred iterations to do from a slow first
   * guess. On the Thrust line, starting the descent from 10 m/s left it at a
   * 40 s lap after 120 iterations where 200 had reached 30.
   *
   * It minimises the cost, not "fastest with zero penalty": some penalties do
   * not scale away. A line that brushes a pole brushes it at any speed, and
   * slowing down far enough trips the minimum crossing speed instead — the
   * first version searched for zero and scaled the Thrust line to a 586 s lap.
   */
  scaleSearch(x0: Float64Array, mu = 300): Float64Array {
    const { tBase } = this.lay;
    const N = x0.length;
    const saved = this.mu;
    this.mu = mu;
    const at = (logK: number): Float64Array => {
      const x = Float64Array.from(x0);
      for (let i = tBase; i < N; i++) x[i] = x0[i]! + logK;
      return x;
    };
    const f = (logK: number): number => this.evaluate(at(logK)).cost;
    const g = (Math.sqrt(5) - 1) / 2;
    let a = -2.5;
    let b = 1;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = f(c);
    let fd = f(d);
    for (let it = 0; it < 20; it++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = f(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = f(d);
      }
    }
    this.mu = saved;
    const k = (a + b) / 2;
    return f(k) < f(0) ? at(k) : Float64Array.from(x0);
  }

  private descend(
    x0: Float64Array,
    mask: Uint8Array,
    iters: number,
    stages: number[],
    log?: (s: string) => void,
  ): Float64Array {
    const x = Float64Array.from(x0);
    const N = x.length;
    const m = new Float64Array(N);
    const v = new Float64Array(N);
    const g = new Float64Array(N);
    const lr = 0.02;
    const h = 1e-4;
    let best = Float64Array.from(x);
    let bestCost = Infinity;
    for (let st = 0; st < stages.length; st++) {
      this.mu = stages[st]!;
      m.fill(0);
      v.fill(0);
      x.set(best);
      bestCost = this.evaluate(best).cost;
      const per = Math.ceil(iters / stages.length);
      for (let it = 1; it <= per; it++) {
        const f0 = this.evaluate(x).cost;
        if (f0 < bestCost) {
          bestCost = f0;
          best = Float64Array.from(x);
        }
        for (let i = 0; i < N; i++) {
          if (!mask[i]) {
            g[i] = 0;
            continue;
          }
          const xi = x[i]!;
          x[i] = xi + h;
          g[i] = (this.evaluate(x).cost - f0) / h;
          x[i] = xi;
        }
        for (let i = 0; i < N; i++) {
          if (!mask[i]) continue;
          const gi = Math.max(-1e3, Math.min(1e3, g[i]!));
          m[i] = 0.9 * m[i]! + 0.1 * gi;
          v[i] = 0.999 * v[i]! + 0.001 * gi * gi;
          const mh = m[i]! / (1 - Math.pow(0.9, it));
          const vh = v[i]! / (1 - Math.pow(0.999, it));
          x[i] = x[i]! - (lr * mh) / (Math.sqrt(vh) + 1e-8);
        }
        if (log && it % 25 === 0) {
          const r = this.evaluate(x).report;
          log(
            `  mu ${this.mu} it ${it}: run ${r.time.toFixed(2)} s, lap ${r.lapTime.toFixed(2)}, ` +
              `pen ${r.penalty.toExponential(1)}, thrust ${(r.thrustUse * 100).toFixed(0)}%, ` +
              `rate ${(r.rateUse * 100).toFixed(0)}%, clear ${r.minClearance.toFixed(2)} m`,
          );
        }
      }
      const fEnd = this.evaluate(x).cost;
      if (fEnd < bestCost) best = Float64Array.from(x);
    }
    return best;
  }
}

/**
 * Where the line has to loop, put waypoints.
 *
 * Leaving checkpoint a straight for VIA_LEAD metres and arriving at b the same
 * way, the chord between those two points says how hard each end turns. Past
 * VIA_TURN at either end the segment is a loop, not a bend: two waypoints go
 * in, one where the line leaves a and one where it arrives at b, and the
 * search moves them from there. On Macabim that is 2 -> 3 (side by side, both
 * south), 5 -> 6, 8 -> 9 (stacked, both south) and 14 -> 15 (the circle round
 * the pole), and nothing on the built-in maps.
 */
function placeVias(frames: CheckpointFrame[]): { knots: Knot[]; vias: Via[] } {
  const knots: Knot[] = [];
  const vias: Via[] = [];
  const n = frames.length;
  const centre = (f: CheckpointFrame): [number, number, number] => [
    f.c[0] + f.a1[0] * f.mid1 + f.a2[0] * f.mid2,
    f.c[1] + f.a1[1] * f.mid1 + f.a2[1] * f.mid2,
    f.c[2] + f.a1[2] * f.mid1 + f.a2[2] * f.mid2,
  ];
  for (let i = 0; i < n; i++) {
    knots.push({ kind: 'cp', i });
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const ca = centre(a);
    const cb = centre(b);
    const out: [number, number, number] = [ca[0] + a.nrm[0] * VIA_LEAD, ca[1] + a.nrm[1] * VIA_LEAD, ca[2] + a.nrm[2] * VIA_LEAD];
    const into: [number, number, number] = [cb[0] - b.nrm[0] * VIA_LEAD, cb[1] - b.nrm[1] * VIA_LEAD, cb[2] - b.nrm[2] * VIA_LEAD];
    const ch = [into[0] - out[0], into[1] - out[1], into[2] - out[2]];
    const L = Math.hypot(ch[0]!, ch[1]!, ch[2]!);
    if (L < 1e-6) continue;
    const u: [number, number, number] = [ch[0]! / L, ch[1]! / L, ch[2]! / L];
    const angle = (p: readonly number[], q: readonly number[]): number =>
      Math.acos(Math.max(-1, Math.min(1, p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!)));
    if (Math.max(angle(a.nrm, u), angle(u, b.nrm)) <= VIA_TURN) continue;
    // Keep the waypoints above the floor; a loop is flown in the air.
    const lift = (p: [number, number, number]): [number, number, number] => [p[0], p[1], Math.min(p[2], -1.5)];
    knots.push({ kind: 'via', j: vias.length });
    vias.push({ p: lift(out), d: u });
    knots.push({ kind: 'via', j: vias.length });
    vias.push({ p: lift(into), d: u });
  }
  return { knots, vias };
}

function emptyReport(): PlanReport {
  return {
    time: Infinity,
    lapTime: Infinity,
    launchTime: Infinity,
    penalty: Infinity,
    thrustUse: Infinity,
    rateUse: Infinity,
    minClearance: -Infinity,
    minAltitude: -Infinity,
  };
}
