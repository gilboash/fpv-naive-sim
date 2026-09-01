/**
 * A machine pilot: flies the model along a given line, through the same sticks
 * a person uses.
 *
 * The point is a reference lap — what the airframe can do round a course, so a
 * pilot has something to measure themselves against. That only means anything
 * if the machine is held to the same constraints as the human: it gets four
 * stick channels, the same rate curve, the same PIDs, the same mixer and the
 * same battery sag. It does not get to write to the rigid body, and it does not
 * get more authority than a full-stick input.
 *
 * It does get two things a pilot does not: perfect knowledge of its own state,
 * and no reaction time. Both are worth stating rather than hiding — they are
 * most of why the reference is a bound rather than a target.
 *
 * Cascaded, as a flight controller is: position -> velocity -> acceleration ->
 * a thrust vector, which is an attitude and a throttle, which are sticks.
 *
 * Pure TypeScript with no browser dependency, so it runs under
 * `node --experimental-strip-types` — and so no parameter properties, per the
 * rule in CLAUDE.md.
 */

import type { FlightSim, StickInput } from './sim.ts';
import type { RateProfile } from './rates.ts';
import { applyRates, AXIS_ROLL, AXIS_PITCH, AXIS_YAW } from './rates.ts';
import { clamp, rotateBodyToWorld, rotateWorldToBody, vec3 } from './math.ts';

/** Body up, in the rigid body's FRD frame. */
const BODY_UP = vec3(0, 0, -1);

const G = 9.80665;
const DEG = Math.PI / 180;

/** A point on the reference line, in NED, with the speed to take it at. */
export interface PathPoint {
  north: number;
  east: number;
  /** Metres above the ground. Stored up-positive, unlike the physics. */
  up: number;
  /** Target speed here, m/s. */
  speed: number;
  /**
   * The acceleration following the line at that speed *requires* — centripetal
   * for the corner, tangential for the speed change. Optional, and supplying it
   * is the difference between a controller that follows a line and one that
   * chases it: without feedforward the corner can only be discovered as an
   * error, so the aircraft is permanently late and hunts. It hunted at 1.57 Hz
   * and half stick.
   */
  accN?: number;
  accE?: number;
  accU?: number;
}

export interface AutopilotGains {
  /** Position error to velocity, 1/s. */
  kPos: number;
  /** Velocity error to acceleration, 1/s. */
  kVel: number;
  /** Attitude error to body rate, 1/s. */
  kAtt: number;
  /** Yaw error to body rate, 1/s. Softer: yaw is the slow axis on a quad. */
  kYaw: number;
  /** Thrust error to throttle, per newton. */
  kThrottle: number;
  /** How far along the line to aim, in seconds of travel. */
  lookaheadS: number;
  /** Ceiling on the velocity correction toward the line, m/s. */
  maxCorrection: number;
  /** Ceiling on commanded acceleration, m/s^2. Roughly what the airframe has. */
  maxAccel: number;
  /**
   * How much of the line's own acceleration to feed forward, 0..1.
   *
   * Zero is pure feedback, and is what currently flies. The feedforward is
   * derived from a numerically differentiated spline, and at full weight it
   * costs more in noise than it buys in lead — see the note in optimal-lap.ts.
   * Kept as a dial rather than deleted because the *idea* is right: a corner
   * that can only be discovered as an error is a corner taken late.
   */
  ffWeight: number;
  /** Ceiling on the rate the controller will ask for, deg/s. */
  maxRateDps: number;
  /** Ceiling on tilt from vertical, degrees. Beyond this a quad falls. */
  maxTiltDeg: number;
  /**
   * Pin the throttle wide open and steer with attitude alone.
   *
   * A different strategy, not a tuning knob. With thrust fixed you cannot
   * choose the magnitude of the acceleration, only its direction — so holding
   * altitude fixes the tilt (about 83 degrees at a thrust-to-weight of 8) and
   * guidance is left with the azimuth. Pointing it forward accelerates,
   * backward brakes, sideways turns. That is the shape a time-optimal solution
   * takes for a thrust-limited vehicle, and it is what a pilot means by "full
   * throttle and fly it".
   */
  fullThrottle: boolean;
  /** Thrust-to-weight, needed only when fullThrottle is set. */
  twr: number;
}

export function defaultGains(): AutopilotGains {
  return {
    kPos: 1.8,
    kVel: 4.0,
    kAtt: 9.0,
    kYaw: 3.0,
    kThrottle: 1.6,
    lookaheadS: 0.22,
    maxCorrection: 9,
    maxAccel: 26,
    ffWeight: 0,
    fullThrottle: false,
    twr: 8,
    maxRateDps: 800,
    maxTiltDeg: 78,
  };
}

/**
 * The stick positions that produce a wanted body rate.
 *
 * The rate curve is monotonic in stick, so a bisection inverts it in a fixed
 * number of steps with no algebra per curve type — which matters, because there
 * are three curve types and Betaflight's is not analytically invertible in any
 * pleasant way. Twenty iterations gets closer than the stick resolution.
 */
export function stickForRate(rates: RateProfile, axis: number, wantDps: number): number {
  const sign = wantDps < 0 ? -1 : 1;
  const target = Math.abs(wantDps);
  if (applyRates(rates, axis, sign) * sign <= target) return sign;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (applyRates(rates, axis, mid * sign) * sign < target) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * sign;
}

export class Autopilot {
  gains: AutopilotGains;
  /** Index of the path point last passed. Monotonic: the line is one-way. */
  index = 0;
  /** Distance travelled along the line, metres. */
  travelled = 0;
  /** Set once the last point is behind us. */
  finished = false;

  private path: PathPoint[];
  private cumulative: number[] = [];
  private rates: RateProfile;
  private throttle = 0.5;

  // Scratch, reused: this runs at 1 kHz inside an optimiser loop.
  private bodyUp = vec3();
  private want = vec3();
  private bodyWant = vec3();

  constructor(path: PathPoint[], rates: RateProfile, gains: AutopilotGains = defaultGains()) {
    this.path = path;
    this.rates = rates;
    this.gains = gains;
    let d = 0;
    this.cumulative.push(0);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      d += Math.hypot(b.north - a.north, b.east - a.east, b.up - a.up);
      this.cumulative.push(d);
    }
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  /**
   * Advance the index to the point nearest ahead of the quad, then aim a little
   * beyond it.
   *
   * Pure pursuit rather than a time-parameterised trajectory, because a
   * trajectory the quad falls behind gets further away every step, and the
   * recovery is worse than the delay. Chasing a point on the line cannot
   * diverge that way.
   */
  private advance(sim: FlightSim): void {
    const pos = sim.pos;
    const n = pos.x;
    const e = pos.y;
    const u = -pos.z;
    // Walk forward only. The line is flown once and never revisited, so
    // searching the whole path every step would be both slower and wrong at a
    // crossing point.
    // Bounded by *arc length*, not by a point count. On a hairpin the line
    // doubles back within a couple of metres, so an unbounded search finds the
    // return leg closer than the corner itself and cuts straight across it —
    // which is exactly how the 180s course was failing at its second gate.
    // Progress is capped at what the aircraft could actually have covered.
    const speed = Math.hypot(sim.vel.x, sim.vel.y, sim.vel.z);
    const window = Math.max(3, speed * 0.35);
    let best = this.index;
    let bestD = Infinity;
    let limit = this.index;
    while (
      limit < this.path.length - 1 &&
      (this.cumulative[limit] ?? 0) - this.travelled < window
    ) {
      limit++;
    }
    for (let i = this.index; i <= limit; i++) {
      const p = this.path[i]!;
      const d = (p.north - n) ** 2 + (p.east - e) ** 2 + (p.up - u) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.index = best;
    this.travelled = this.cumulative[best] ?? 0;
    if (best >= this.path.length - 1) this.finished = true;
  }

  /** The point to aim at: `lookaheadS` of travel beyond the nearest one. */
  private carrot(): PathPoint {
    const here = this.path[this.index]!;
    const ahead = this.travelled + Math.max(2.5, here.speed * this.gains.lookaheadS);
    let i = this.index;
    while (i < this.path.length - 1 && (this.cumulative[i] ?? 0) < ahead) i++;
    return this.path[i]!;
  }

  /** One tick. Returns the sticks a pilot would have to be holding. */
  step(sim: FlightSim): StickInput {
    this.advance(sim);
    const target = this.carrot();
    const g = this.gains;

    // ---- guidance: how fast, and how far off the line
    //
    // The error is split along the line and across it, and only the across part
    // is corrected by position feedback. Correcting the along-track part too
    // was the first version, and it demanded 25 m/s^2 to chase a carrot 2.5 m
    // ahead — a 69 degree tilt to fly at 12 m/s. How fast to go along the line
    // is the velocity profile's job; position feedback exists to stop the
    // aircraft drifting off it.
    const here = this.path[this.index]!;
    const next = this.path[Math.min(this.index + 1, this.path.length - 1)]!;
    let tN = next.north - here.north;
    let tE = next.east - here.east;
    let tU = next.up - here.up;
    const tl = Math.hypot(tN, tE, tU) || 1;
    tN /= tl;
    tE /= tl;
    tU /= tl;

    const errN = here.north - sim.pos.x;
    const errE = here.east - sim.pos.y;
    const errU = here.up - -sim.pos.z;
    const along = errN * tN + errE * tE + errU * tU;
    const crossN = errN - along * tN;
    const crossE = errE - along * tE;
    const crossU = errU - along * tU;

    // The speed comes from the *carrot*, so the profile brakes before a corner
    // rather than in it.
    const speed = target.speed;
    // Saturated, so a big excursion asks for a firm correction rather than an
    // impossible one.
    const corr = Math.min(g.maxCorrection, Math.hypot(crossN, crossE, crossU) * g.kPos);
    const cl = Math.hypot(crossN, crossE, crossU) || 1;
    const vN = tN * speed + (crossN / cl) * corr;
    const vE = tE * speed + (crossE / cl) * corr;
    const vU = tU * speed + (crossU / cl) * corr;

    // Feedforward from where the aircraft *is*, not from the carrot. The carrot
    // is a lead term for direction and speed; applying the corner's centripetal
    // acceleration before reaching the corner just pushes the aircraft off the
    // line early, which is what it did.
    let aN = (here.accN ?? 0) * g.ffWeight + (vN - sim.vel.x) * g.kVel;
    let aE = (here.accE ?? 0) * g.ffWeight + (vE - sim.vel.y) * g.kVel;
    let aU = (here.accU ?? 0) * g.ffWeight + (vU - -sim.vel.z) * g.kVel;
    // Clamped to what the aircraft has. Asking for more does not make it go
    // faster, it just saturates the attitude loop and throws away control.
    const aMag = Math.hypot(aN, aE, aU);
    if (aMag > g.maxAccel) {
      const k = g.maxAccel / aMag;
      aN *= k;
      aE *= k;
      aU *= k;
    }

    // ---- the thrust vector that produces that acceleration
    //
    // All of this is in NED, deliberately. The obvious thing is to work in
    // north/east/*up* because it reads better, and it is wrong: N-E-U is
    // left-handed, so every cross product comes out with the opposite sense and
    // the aircraft flies backwards while tumbling. It did exactly that.
    //
    // Thrust also holds the aircraft up, hence the gravity term; the result
    // points up (negative z) in the hover.
    let fN = aN;
    let fE = aE;
    let fD = -(aU + G);
    if (g.fullThrottle) {
      // Magnitude is not ours to choose. Hold altitude with the vertical
      // component — including whatever the guidance wants to correct — and
      // spend everything that is left on the horizontal, in the direction
      // guidance asked for.
      const total = g.twr * G;
      const wantD = -(aU + G);
      const clampedD = clamp(wantD, -total * 0.999, total * 0.999);
      const horizMag = Math.sqrt(Math.max(0, total * total - clampedD * clampedD));
      const h = Math.hypot(aN, aE);
      // With no horizontal preference, keep pointing where we are going rather
      // than snapping to north.
      const uN = h > 1e-6 ? aN / h : (sim.vel.x || 1) / (Math.hypot(sim.vel.x, sim.vel.y) || 1);
      const uE = h > 1e-6 ? aE / h : sim.vel.y / (Math.hypot(sim.vel.x, sim.vel.y) || 1);
      fN = uN * horizMag;
      fE = uE * horizMag;
      fD = clampedD;
    }
    let mag = Math.hypot(fN, fE, fD);
    if (mag < 1e-6) mag = 1e-6;
    let dN = fN / mag;
    let dE = fE / mag;
    let dD = fD / mag;

    // Tilt limit. Past about 80 degrees there is no vertical component left and
    // a quad simply falls, and the optimiser will happily ask for it.
    // Skipped when the throttle is pinned: the altitude-hold term already fixes
    // the tilt, and at a thrust-to-weight of 8 that tilt is 83 degrees — past
    // any limit that makes sense when thrust is the free variable.
    const minUp = Math.cos(g.maxTiltDeg * DEG);
    if (!g.fullThrottle && -dD < minUp) {
      const horiz = Math.hypot(dN, dE) || 1;
      const wantHoriz = Math.sqrt(Math.max(0, 1 - minUp * minUp));
      dN = (dN / horiz) * wantHoriz;
      dE = (dE / horiz) * wantHoriz;
      dD = -minUp;
    }

    // ---- attitude error, as the rotation that takes body-up onto that vector
    rotateBodyToWorld(this.bodyUp, sim.q, BODY_UP);
    const bN = this.bodyUp.x;
    const bE = this.bodyUp.y;
    const bD = this.bodyUp.z;

    const cx = bE * dD - bD * dE;
    const cy = bD * dN - bN * dD;
    const cz = bN * dE - bE * dN;
    const sinA = Math.hypot(cx, cy, cz);
    const cosA = bN * dN + bE * dE + bD * dD;
    const angle = Math.atan2(sinA, cosA);
    const scale = sinA > 1e-9 ? angle / sinA : 0;
    // The axis is perpendicular to body-up by construction, so this is a pure
    // tilt correction with no yaw in it — which is what a quad wants, since
    // yaw is the slow axis and must not fight the tilt.
    this.want.x = cx * scale;
    this.want.y = cy * scale;
    this.want.z = cz * scale;
    rotateWorldToBody(this.bodyWant, sim.q, this.want);

    // ---- yaw: point where you are going, as a pilot does
    const headingWanted = Math.atan2(target.east - sim.pos.y, target.north - sim.pos.x);
    const yawNow = Math.atan2(
      2 * (sim.q.w * sim.q.z + sim.q.x * sim.q.y),
      1 - 2 * (sim.q.y * sim.q.y + sim.q.z * sim.q.z),
    );
    let yawErr = headingWanted - yawNow;
    while (yawErr > Math.PI) yawErr -= Math.PI * 2;
    while (yawErr < -Math.PI) yawErr += Math.PI * 2;

    const rollDps = clamp((this.bodyWant.x * g.kAtt) / DEG, -g.maxRateDps, g.maxRateDps);
    const pitchDps = clamp((this.bodyWant.y * g.kAtt) / DEG, -g.maxRateDps, g.maxRateDps);
    const yawDps = clamp((yawErr * g.kYaw) / DEG, -g.maxRateDps, g.maxRateDps);

    // ---- throttle, closed on the thrust the model is actually making
    // The alternative is a curve fitted to the motors, which would be a second
    // model of a thing we already have exactly.
    if (g.fullThrottle) {
      this.throttle = 1;
    } else {
      const wantN = mag * sim.airframe.mass;
      const haveN = sim.telemetry.totalThrustN;
      this.throttle = clamp(this.throttle + (wantN - haveN) * g.kThrottle * sim.dt, 0, 1);
    }

    return {
      throttle: this.throttle,
      roll: stickForRate(this.rates, AXIS_ROLL, rollDps),
      // The control path runs in the pilot's convention, where positive pitch
      // is nose-DOWN, while the rigid body is standard FRD. Same negation the
      // gyro gets on the way into the controller in sim.ts, for the same reason.
      pitch: stickForRate(this.rates, AXIS_PITCH, -pitchDps),
      yaw: stickForRate(this.rates, AXIS_YAW, yawDps),
    };
  }
}
