/**
 * A reference lap: the fastest way round a course this model can be made to go.
 *
 *   node --experimental-strip-types tools/optimal-lap.ts [course] [--opt N]
 *
 * Three stages, because the interesting number is the gap between them:
 *
 *  1. **A kinematic bound.** A spline through the apertures, then a
 *     forward-backward velocity profile limited by corner radius and by
 *     thrust-to-weight. It ignores attitude dynamics entirely, so no aircraft
 *     can reach it — which is the point of quoting it.
 *  2. **Flying that line with the real model**, through `Autopilot`, which gets
 *     four sticks and the same tune a pilot gets. This is the honest number.
 *  3. **Optimising** where the line goes through each aperture, and how hard it
 *     pushes, against the stage-2 lap time.
 *
 * What comes out is a *reference*, not a perfect lap. It is the best this
 * search found under this model, and both of those qualifications matter — the
 * model's rate response is known to be soft against real logs. A machine time
 * labelled "perfect" that a pilot then beats is worse than no number at all.
 */

import { FlightSim } from '../src/flight/sim.ts';
import { kronos } from '../src/flight/airframe.ts';
import { Autopilot, defaultGains, type PathPoint } from '../src/flight/autopilot.ts';
import { defaultRates, type RateProfile } from '../src/flight/rates.ts';
import { COURSES, type Checkpoint, type Course } from '../src/race/course.ts';
import { Race } from '../src/race/race.ts';
import { writeFileSync } from 'node:fs';

const G = 9.80665;

/**
 * How far before and after a checkpoint the line is pinned to its axis.
 *
 * Adaptive, and it has to be. A fixed length cannot serve both: long stubs make
 * the circle smooth and fast but turn the flag-and-gate element into a shape
 * the aircraft cannot fly, and short ones do the reverse — 15.9 s versus 29.1 s
 * on the circle for the same course, purely from this number. Scaling it to the
 * gap between neighbours gives each element the room it actually has.
 */
function stubFor(gap: number): number {
  return Math.max(1.2, Math.min(5, gap * 0.22));
}

/** Resolution of the resampled line. Fine enough that curvature is smooth. */
const STEP_M = 0.3;

interface Vec {
  n: number;
  e: number;
  u: number;
}

/**
 * Free parameters of a lap: where through each aperture the line goes, and how
 * hard the profile pushes.
 *
 * Deliberately few. The alternative is optimising the trajectory point by
 * point, which is the proper formulation and wants a solver we do not have;
 * this is the racing-driver's version of the same question — which part of the
 * gate do you take, and how late do you brake.
 */
interface LapParams {
  /** Per checkpoint: across the aperture and up it, each -1..1. */
  offsets: number[];
  /** Fraction of the available lateral acceleration the profile plans to use. */
  grip: number;
  /** Ceiling on planned speed, m/s. */
  vMax: number;
  /** Radius of the turn inserted where the course doubles back, metres. */
  turnRadius: number;
}

function waypointFor(cp: Checkpoint, across: number, up: number, inStub: number, outStub: number): Vec[] {
  if (cp.kind === 'flag') {
    // Past the pole on the required side, at a height that clears it.
    const rN = -cp.dirE * cp.side;
    const rE = cp.dirN * cp.side;
    const off = cp.passWidth * 0.45;
    return [
      {
        n: cp.north + rN * off - cp.dirN * inStub,
        e: cp.east + rE * off - cp.dirE * inStub,
        u: Math.max(2, cp.height * 0.45),
      },
      {
        n: cp.north + rN * off + cp.dirN * outStub,
        e: cp.east + rE * off + cp.dirE * outStub,
        u: Math.max(2, cp.height * 0.45),
      },
    ];
  }
  const dU = cp.dirU ?? 0;
  // In-plane axes, the same pair the crossing test uses.
  let axN = -cp.dirE;
  let axE = cp.dirN;
  let axU = 0;
  let ayN = 0;
  let ayE = 0;
  let ayU = 1;
  if (Math.abs(dU) > 0.999) {
    axN = 0;
    axE = 1;
    axU = 0;
    ayN = 1;
    ayE = 0;
    ayU = 0;
  } else {
    const l = Math.hypot(axN, axE) || 1;
    axN /= l;
    axE /= l;
  }
  // Kept inside the aperture: the line has to clear the frame, not graze it.
  const inset = 0.55;
  const cN = cp.north + axN * across * cp.halfWidth * inset + ayN * up * cp.halfHeight * inset;
  const cE = cp.east + axE * across * cp.halfWidth * inset + ayE * up * cp.halfHeight * inset;
  const cU = cp.up + axU * across * cp.halfWidth * inset + ayU * up * cp.halfHeight * inset;
  // Pinned on the axis either side, so the line arrives square rather than
  // clipping the frame on a diagonal.
  return [
    { n: cN - cp.dirN * inStub, e: cE - cp.dirE * inStub, u: cU - dU * inStub },
    { n: cN + cp.dirN * outStub, e: cE + cp.dirE * outStub, u: cU + dU * outStub },
  ];
}

/**
 * Centripetal Catmull-Rom through the waypoints, resampled at a fixed spacing.
 *
 * Centripetal — knots spaced by the square root of the distance between points
 * — rather than uniform, and the difference is not cosmetic. The waypoints are
 * unevenly spaced by construction: an entry and exit stub a few metres apart,
 * then ten metres to the next pair. Uniform Catmull-Rom overshoots badly on
 * that, and the wiggles it produces have real curvature: the feedforward
 * averaged 21.7 m/s^2 round a circle that needs 12.2, swinging plus and minus
 * 28, which is a controller instruction to hunt. Centripetal parameterisation
 * is the standard answer and provably cannot cusp or self-intersect within a
 * segment.
 */
function spline(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  const at = (i: number): Vec => points[Math.max(0, Math.min(points.length - 1, i))]!;
  const knot = (t: number, a: Vec, b: Vec): number =>
    t + Math.max(1e-4, Math.hypot(b.n - a.n, b.e - a.e, b.u - a.u) ** 0.5);

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const t0 = 0;
    const t1 = knot(t0, p0, p1);
    const t2 = knot(t1, p1, p2);
    const t3 = knot(t2, p2, p3);

    const seg = Math.hypot(p2.n - p1.n, p2.e - p1.e, p2.u - p1.u);
    const steps = Math.max(2, Math.ceil(seg / STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      // Barry-Goldman: three nested linear interpolations.
      const lerp = (a: Vec, b: Vec, ta: number, tb: number): Vec => {
        const f = (t - ta) / (tb - ta);
        return {
          n: a.n + (b.n - a.n) * f,
          e: a.e + (b.e - a.e) * f,
          u: a.u + (b.u - a.u) * f,
        };
      };
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * The velocity profile: a corner-speed limit from curvature, then a forward
 * pass for how fast you can accelerate into it and a backward pass for how late
 * you can brake. Standard racing-line practice, and the reason it is a *bound*
 * is that it assumes the aircraft is always already pointing the right way.
 */
function profile(line: Vec[], aLat: number, aLong: number, vMax: number): number[] {
  const n = line.length;
  const v = new Array<number>(n).fill(vMax);
  for (let i = 1; i < n - 1; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const c = line[i + 1]!;
    // Menger curvature of the three points.
    const ab = Math.hypot(b.n - a.n, b.e - a.e, b.u - a.u);
    const bc = Math.hypot(c.n - b.n, c.e - b.e, c.u - b.u);
    const ca = Math.hypot(a.n - c.n, a.e - c.e, a.u - c.u);
    const s = (ab + bc + ca) / 2;
    const areaSq = Math.max(0, s * (s - ab) * (s - bc) * (s - ca));
    const area = Math.sqrt(areaSq);
    const kappa = ab * bc * ca > 1e-9 ? (4 * area) / (ab * bc * ca) : 0;
    if (kappa > 1e-6) v[i] = Math.min(v[i]!, Math.sqrt(aLat / kappa));
  }
  // Standing start, and stopped at the end of the last lap.
  v[0] = 0;
  for (let i = 1; i < n; i++) {
    const ds = dist(line[i - 1]!, line[i]!);
    v[i] = Math.min(v[i]!, Math.sqrt(v[i - 1]! * v[i - 1]! + 2 * aLong * ds));
  }
  for (let i = n - 2; i >= 0; i--) {
    const ds = dist(line[i]!, line[i + 1]!);
    v[i] = Math.min(v[i]!, Math.sqrt(v[i + 1]! * v[i + 1]! + 2 * aLong * ds));
  }
  return v;
}

/**
 * The acceleration the line demands at each point: centripetal from its
 * curvature, tangential from the speed changing along it.
 *
 * This is what turns the autopilot from something that chases the line into
 * something that follows it. Both terms come out of geometry that is already
 * computed for the velocity profile, so it costs nothing to hand over.
 */
function withFeedforward(line: Vec[], v: number[]): PathPoint[] {
  const out: PathPoint[] = [];
  for (let i = 0; i < line.length; i++) {
    // A wide stencil, and it has to be wide. A second difference over the 0.3 m
    // sample spacing divides by ds^2, so it multiplies any wobble in the spline
    // by about eleven — the first version asked for hundreds of m/s^2 and the
    // aircraft never left the first gate. Two metres of arc is smooth enough to
    // differentiate twice.
    const span = Math.max(1, Math.round(2 / STEP_M));
    const a = line[Math.max(0, i - span)]!;
    const b = line[i]!;
    const c = line[Math.min(line.length - 1, i + span)]!;
    // Tangent, and the derivative of the tangent along the line, which is
    // curvature times the normal.
    let tN = c.n - a.n;
    let tE = c.e - a.e;
    let tU = c.u - a.u;
    const tl = Math.hypot(tN, tE, tU) || 1;
    tN /= tl;
    tE /= tl;
    tU /= tl;
    const ds = (dist(a, b) + dist(b, c)) / 2 || 1;
    // Second difference gives curvature times the normal, in one step.
    const kN = (c.n - 2 * b.n + a.n) / (ds * ds);
    const kE = (c.e - 2 * b.e + a.e) / (ds * ds);
    const kU = (c.u - 2 * b.u + a.u) / (ds * ds);
    const speed = v[i]!;
    const vPrev = v[Math.max(0, i - span)]!;
    const vNext = v[Math.min(v.length - 1, i + span)]!;
    // v dv/ds along the tangent.
    const dvds = (vNext - vPrev) / (2 * ds);
    const along = speed * dvds;
    let fN = kN * speed * speed + tN * along;
    let fE = kE * speed * speed + tE * along;
    let fU = kU * speed * speed + tU * along;
    // Clamped to what the airframe has. A feedforward the aircraft cannot
    // deliver is worse than none: it saturates the attitude loop and the
    // feedback term loses its authority entirely.
    const fMag = Math.hypot(fN, fE, fU);
    const cap = 30;
    if (fMag > cap) {
      fN *= cap / fMag;
      fE *= cap / fMag;
      fU *= cap / fMag;
    }
    out.push({ north: b.n, east: b.e, up: b.u, speed, accN: fN, accE: fE, accU: fU });
  }
  return out;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(b.n - a.n, b.e - a.e, b.u - a.u);
}

/** Seconds to fly the profile, which is the kinematic bound. */
function profileTime(line: Vec[], v: number[]): number {
  let t = 0;
  for (let i = 1; i < line.length; i++) {
    const ds = dist(line[i - 1]!, line[i]!);
    const vm = (v[i - 1]! + v[i]!) / 2;
    if (vm > 0.05) t += ds / vm;
  }
  return t;
}

/** The centre line, exported so a debug run can fly the same thing. */
export function buildDebugPath(course: Course): PathPoint[] {
  return buildPath(course, { offsets: new Array<number>(course.checkpoints.length * 2).fill(0), grip: 0.35, vMax: 30, turnRadius: 7 }, 2);
}

/**
 * Join two checkpoints, inserting a turn where the course doubles back.
 *
 * Without this the line has a cusp: the flag-and-gate element is *designed* so
 * you cannot take both in one pass — over the gate, round the pole, back
 * through — and the 180s course is nothing but reversals. A spline through a
 * cusp is not a line any aircraft can fly, and the autopilot dutifully tried,
 * got stuck against a point it could not reach, and climbed away.
 *
 * The turn is two points: run on past the exit, then come back onto the next
 * checkpoint's axis, displaced to the side that is already closer to it. That
 * is what a pilot does, and it gives the spline a radius to work with instead
 * of a corner.
 */
function joinTurn(exit: Vec, exitDir: Vec, entry: Vec, entryDir: Vec, radius: number): Vec[] {
  const dN = entry.n - exit.n;
  const dE = entry.e - exit.e;
  const dU = entry.u - exit.u;
  const len = Math.hypot(dN, dE, dU) || 1;
  const ahead = (dN / len) * exitDir.n + (dE / len) * exitDir.e + (dU / len) * exitDir.u;
  const opposed = exitDir.n * entryDir.n + exitDir.e * entryDir.e + exitDir.u * entryDir.u;
  // Purely directional. An earlier version also required the two points to be
  // further apart than the turn radius, which put a U-turn between every pair
  // of gates on the thrust line's straight — they are 14 m apart and the
  // approach stubs eat 8 m of that. Whether a turn is needed is a question
  // about direction, not distance.
  if (ahead > 0.25 && opposed > 0) return [];

  // Which side to swing: whichever the next checkpoint already lies toward.
  const perpN = -exitDir.e;
  const perpE = exitDir.n;
  const side = dN * perpN + dE * perpE >= 0 ? 1 : -1;
  const midU = (exit.u + entry.u) / 2;
  return [
    {
      n: exit.n + exitDir.n * radius + perpN * radius * side,
      e: exit.e + exitDir.e * radius + perpE * radius * side,
      u: midU,
    },
    {
      n: entry.n - entryDir.n * radius + perpN * radius * side,
      e: entry.e - entryDir.e * radius + perpE * radius * side,
      u: midU,
    },
  ];
}

function dirOf(cp: Checkpoint): Vec {
  return { n: cp.dirN, e: cp.dirE, u: cp.kind === 'gate' ? (cp.dirU ?? 0) : 0 };
}

function gapTo(a: Checkpoint, b: Checkpoint): number {
  const au = a.kind === 'gate' ? a.up : a.height;
  const bu = b.kind === 'gate' ? b.up : b.height;
  return Math.hypot(b.north - a.north, b.east - a.east, bu - au);
}

/** The waypoint pair for checkpoint `i`, with stubs sized to its neighbours. */
function pairFor(cps: Checkpoint[], i: number, offsets: number[]): Vec[] {
  const cp = cps[i]!;
  const prev = cps[(i + cps.length - 1) % cps.length]!;
  const next = cps[(i + 1) % cps.length]!;
  return waypointFor(
    cp,
    offsets[i * 2] ?? 0,
    offsets[i * 2 + 1] ?? 0,
    stubFor(gapTo(prev, cp)),
    stubFor(gapTo(cp, next)),
  );
}

/**
 * Thrust-to-weight, measured from the model rather than assumed.
 *
 * It was hard-coded at 3.2, and the Kronos has **8.1** — so the planner spent
 * every lap asking for a third of the acceleration the aircraft had, which is
 * why the reference flew at a third of full throttle and Gilboa said so on
 * sight. Eight is not a typo: his own logs put hover at 9 428 rpm against
 * 28 046 at full throttle, and thrust goes as rpm squared, so hover is 11% of
 * maximum.
 */
let cachedTwr = 0;
function measuredTwr(): number {
  if (cachedTwr > 0) return cachedTwr;
  const af = kronos();
  const sim = new FlightSim({ airframe: af });
  sim.pos.z = -50;
  sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
  let peak = 0;
  for (let i = 0; i < 3000; i++) {
    sim.step({ throttle: 1, roll: 0, pitch: 0, yaw: 0 });
    peak = Math.max(peak, sim.telemetry.totalThrustN);
  }
  cachedTwr = peak / (af.mass * G);
  return cachedTwr;
}

function buildPath(course: Course, p: LapParams, laps: number): PathPoint[] {
  const pts: Vec[] = [{ n: course.start.north, e: course.start.east, u: 1.2 }];
  const cps = course.checkpoints;
  for (let lap = 0; lap < laps; lap++) {
    cps.forEach((cp, i) => {
      const pair = pairFor(cps, i, p.offsets);
      // The turn from the previous checkpoint into this one.
      if (pts.length > 1) {
        const prev = cps[(i + cps.length - 1) % cps.length]!;
        const exit = pts[pts.length - 1]!;
        pts.push(...joinTurn(exit, dirOf(prev), pair[0]!, dirOf(cp), p.turnRadius));
      }
      pts.push(...pair);
    });
  }
  // Round the first checkpoint once more, so the last lap is timed to a
  // crossing rather than to the aircraft running out of line.
  const closing = pairFor(cps, 0, p.offsets);
  pts.push(
    ...joinTurn(pts[pts.length - 1]!, dirOf(cps[cps.length - 1]!), closing[0]!, dirOf(cps[0]!), p.turnRadius),
  );
  pts.push(...closing);

  const line = spline(pts);
  // Thrust-to-weight sets what the profile may plan for. The lateral figure is
  // what is left after holding the aircraft up, which is why it is a difference
  // of squares rather than the whole of it.
  const twr = measuredTwr();
  const aLat = Math.sqrt(Math.max(0.5, (twr * G) ** 2 - G * G)) * p.grip;
  const v = profile(line, aLat, aLat, p.vMax);
  return withFeedforward(line, v);
}

export interface FrameSample {
  t: number;
  n: number;
  e: number;
  u: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  speed: number;
  throttle: number;
  roll: number;
  pitch: number;
  yaw: number;
  batteryV: number;
  batteryA: number;
}

interface LapResult {
  ok: boolean;
  laps: number[];
  holeShot: number;
  total: number;
  crashed: boolean;
  reached: number;
  boundS: number;
}

/** One closed lap of the line, at the profile speed: the kinematic bound. */
function lapBound(course: Course, p: LapParams): number {
  const cps = course.checkpoints;
  const pts: Vec[] = [];
  cps.forEach((cp, i) => {
    const pair = pairFor(cps, i, p.offsets);
    if (pts.length > 0) {
      const prev = cps[(i + cps.length - 1) % cps.length]!;
      pts.push(...joinTurn(pts[pts.length - 1]!, dirOf(prev), pair[0]!, dirOf(cp), p.turnRadius));
    }
    pts.push(...pair);
  });
  const first = cps[0]!;
  const pair = pairFor(cps, 0, p.offsets);
  pts.push(
    ...joinTurn(pts[pts.length - 1]!, dirOf(cps[cps.length - 1]!), pair[0]!, dirOf(first), p.turnRadius),
  );
  pts.push(...pair);
  const line = spline(pts);
  const aLat =
    Math.sqrt(Math.max(0.5, (measuredTwr() * G) ** 2 - G * G)) * p.grip;
  const v = profile(line, aLat, aLat, p.vMax);
  // A flying lap, not one from a standstill: the ends are not pinned to zero.
  v[0] = v[1] ?? v[0]!;
  v[v.length - 1] = v[v.length - 2] ?? v[v.length - 1]!;
  return profileTime(line, v);
}

function flyLap(
  course: Course,
  p: LapParams,
  laps: number,
  rates: RateProfile,
  /** When given, one sample every this many steps is kept for a replay. */
  sampleEvery = 0,
  samples: FrameSample[] = [],
): LapResult {
  const path = buildPath(course, p, laps);
  const sim = new FlightSim({ airframe: kronos() });
  sim.rates.type = rates.type;
  for (let i = 0; i < 3; i++) {
    sim.rates.rcRate[i] = rates.rcRate[i]!;
    sim.rates.rate[i] = rates.rate[i]!;
    sim.rates.expo[i] = rates.expo[i]!;
  }
  sim.pos.x = course.start.north;
  sim.pos.y = course.start.east;
  sim.pos.z = -1.2;
  sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });

  const ap = new Autopilot(path, sim.rates, defaultGains());
  const race = new Race(course);
  race.laps = laps;
  race.start(0);
  race.setDt(sim.dt);
  race.step(sim.pos.x, sim.pos.y, -sim.pos.z, sim.dt);

  const maxSteps = 240_000; // four minutes of simulated time
  let steps = 0;
  while (steps++ < maxSteps && race.state === 'running' && !sim.crashed) {
    const cmd = ap.step(sim);
    sim.step(cmd);
    if (sampleEvery > 0 && steps % sampleEvery === 0) {
      const t = sim.telemetry;
      samples.push({
        t: steps * sim.dt,
        n: sim.pos.x,
        e: sim.pos.y,
        u: -sim.pos.z,
        qw: sim.q.w,
        qx: sim.q.x,
        qy: sim.q.y,
        qz: sim.q.z,
        speed: t.speed,
        throttle: cmd.throttle,
        roll: cmd.roll,
        pitch: cmd.pitch,
        yaw: cmd.yaw,
        batteryV: t.batteryV,
        batteryA: t.batteryA,
      });
    }
    race.setDt(sim.dt);
    race.step(sim.pos.x, sim.pos.y, -sim.pos.z, sim.dt);
    if (ap.finished) break;
  }

  const res = race.result();
  // The bound is one lap exactly: gate one round to gate one. Measuring it over
  // the whole flown line would include the standing start and the run-out, and
  // then it is not comparable with a lap time at all — which is how it first
  // came out *slower* than the lap it was supposed to bound.
  const bound = lapBound(course, p);
  return {
    ok: race.state === 'finished',
    laps: res.laps.map((l) => l.time),
    holeShot: res.holeShot,
    total: res.total,
    crashed: sim.crashed,
    reached: race.lap * course.checkpoints.length + race.next,
    boundS: bound,
  };
}

/** The objective: finish, and be quick. Not finishing is worse than being slow. */
function score(r: LapResult, course: Course, laps: number): number {
  if (!r.ok) {
    // Rank unfinished attempts by how far they got, so the search has a
    // gradient to follow out of the region where nothing completes at all.
    const target = laps * course.checkpoints.length;
    return 10_000 - (r.reached / target) * 1000;
  }
  return r.total;
}

function main(): number {
  const args = process.argv.slice(2);
  const flagValues = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) flagValues.add(args[i + 1] ?? '');
  }
  const wanted = args.find((a) => !a.startsWith('--') && !flagValues.has(a));
  const recArg = args.indexOf('--record');
  const recordTo = recArg >= 0 ? args[recArg + 1] : undefined;
  const optArg = args.indexOf('--opt');
  const iterations = optArg >= 0 ? Number(args[optArg + 1] ?? 200) : 0;
  const laps = 2;

  const courses = wanted
    ? COURSES.filter((c) => c.name.toLowerCase().includes(wanted.toLowerCase()))
    : COURSES;
  if (courses.length === 0) {
    console.error(`no course matching "${wanted}" — have: ${COURSES.map((c) => c.name).join(', ')}`);
    return 2;
  }

  // A fixed tune, not the pilot's. Two pilots must get the same reference or it
  // is not a reference.
  const rates = defaultRates();

  for (const course of courses) {
    console.log(`\n\x1b[1m${course.name}\x1b[0m — ${course.checkpoints.length} checkpoints`);
    let best: LapParams = {
      offsets: new Array<number>(course.checkpoints.length * 2).fill(0),
      grip: 0.35,
      vMax: 30,
      turnRadius: 7,
    };
    let bestResult = flyLap(course, best, laps, rates);
    let bestScore = score(bestResult, course, laps);
    report('centres', bestResult);

    if (iterations > 0) {
      // Coordinate descent with a shrinking step. Crude, and it does not need
      // to be clever: every evaluation is a full simulated lap, so the budget
      // is thousands of tries rather than millions, and the parameters are
      // nearly independent — moving through one gate barely changes the best
      // line through the next but one.
      let stepSize = 0.5;
      for (let round = 0; round < iterations; round++) {
        let improved = false;
        const knobs = best.offsets.length + 2;
        for (let k = 0; k < knobs; k++) {
          for (const sign of [1, -1]) {
            const trial: LapParams = { ...best, offsets: [...best.offsets] };
            if (k < best.offsets.length) {
              trial.offsets[k] = Math.max(-1, Math.min(1, (trial.offsets[k] ?? 0) + sign * stepSize));
            } else if (k === best.offsets.length) {
              trial.grip = Math.max(0.1, Math.min(1.0, trial.grip + sign * stepSize * 0.15));
            } else {
              trial.vMax = Math.max(8, Math.min(60, trial.vMax + sign * stepSize * 10));
            }
            const r = flyLap(course, trial, laps, rates);
            const sc = score(r, course, laps);
            if (sc < bestScore - 1e-4) {
              best = trial;
              bestResult = r;
              bestScore = sc;
              improved = true;
            }
          }
        }
        if (!improved) {
          stepSize /= 2;
          if (stepSize < 0.03) break;
        }
      }
      report(`optimised (${iterations} rounds)`, bestResult);
    }

    // Called what it is. It was labelled a "kinematic bound", and it is not
    // one: the profile plans to use only `grip` of the available acceleration,
    // so the aircraft can and does beat it — the circle flew 15.21 against a
    // 15.38 "bound". It is the time to fly the planned line at the planned
    // speeds, which is a useful reference for how much the attitude dynamics
    // cost, and is not a limit on anything.
    console.log(
      `  planned line ${bestResult.boundS.toFixed(2)} s per lap — the profile's own time, ` +
        `ignoring attitude dynamics; not a lower bound, since it plans for only ` +
        `${(best.grip * 100).toFixed(0)}% of the available acceleration`,
    );
    console.log(
      `  grip ${best.grip.toFixed(2)} of a measured ${measuredTwr().toFixed(1)} thrust-to-weight, ` +
        `vMax ${best.vMax.toFixed(1)} m/s, turn radius ${best.turnRadius.toFixed(1)} m`,
    );

    if (recordTo) {
      // 60 Hz, which is a frame of video. The lap is flown again rather than
      // recorded during the search: the search runs thousands of laps and
      // keeping every sample of every one of them would be gigabytes.
      const samples: FrameSample[] = [];
      flyLap(course, best, laps, rates, Math.round(1 / 60 / 0.001), samples);
      const out = {
        course: course.name,
        generated: new Date().toISOString(),
        laps: bestResult.laps,
        holeShot: bestResult.holeShot,
        params: best,
        hz: 60,
        samples,
      };
      writeFileSync(recordTo, JSON.stringify(out));
      console.log(`  recorded ${samples.length} frames to ${recordTo}`);
    }
  }
  return 0;
}

function report(label: string, r: LapResult): void {
  if (!r.ok) {
    console.log(
      `  ${label.padEnd(22)} did not finish — reached checkpoint ${r.reached}` +
        `${r.crashed ? ', crashed' : ''}`,
    );
    return;
  }
  console.log(
    `  ${label.padEnd(22)} hole shot ${r.holeShot.toFixed(2)} s, ` +
      `laps ${r.laps.map((t) => t.toFixed(2)).join(' / ')}`,
  );
}

if (process.argv[1]?.endsWith('optimal-lap.ts')) process.exit(main());
