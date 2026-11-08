/**
 * Flying the line: feedforward from the trajectory, feedback on top, sticks
 * out.
 *
 * The feedforward is what the parked bot never had in a usable form: the
 * thrust and body rates the line *requires*, from exact derivatives, so a
 * corner is flown as it arrives rather than discovered as an error. The
 * feedback is a small cascade — position and velocity error to acceleration,
 * attitude error to rate — that only has to mop up what the model got wrong.
 * The practice laps (ilc.ts) then move what the feedback keeps doing into the
 * feedforward, so lap by lap there is less to mop up.
 *
 * Held to the human's constraints: four sticks, inside their range, through
 * the pilot's own rate curve. It acts at radio rate and holds between.
 */

import type { StickInput } from '../flight/sim.ts';
import type { RateProfile } from '../flight/rates.ts';
import { AXIS_PITCH, AXIS_ROLL, AXIS_YAW } from '../flight/rates.ts';
import { stickForRate } from '../flight/autopilot.ts';
import type { Observation } from './env.ts';
import type { Trajectory } from './poly.ts';
import { flatSample } from './poly.ts';
import { attitudeFor, flatFromDrag, flatState, headingFrom, G } from './flatness.ts';
import { type Envelope, throttleFor } from './envelope.ts';
import type { Correction } from './ilc.ts';

const RAD = 180 / Math.PI;

export interface TrackerGains {
  /** Position error to acceleration, 1/s^2. */
  kPos: number;
  /** Velocity error to acceleration, 1/s. */
  kVel: number;
  /** Cap on the feedback acceleration, m/s^2. */
  maxFeedback: number;
  /** Attitude error to rate, roll and pitch, 1/s. */
  kAtt: number;
  /** Attitude error to rate, yaw, 1/s. Yaw is the slow axis on a quad. */
  kYaw: number;
  /**
   * How far ahead the feedforward is read, s. The rate loop and the motors
   * take time to deliver what is asked, so asking at the moment it is needed
   * is asking late.
   */
  lead: number;
  /** How hard the reference clock slows when the quad falls behind, 1/s. */
  kWarp: number;
}

export function defaultTrackerGains(): TrackerGains {
  return { kPos: 14, kVel: 7, maxFeedback: 35, kAtt: 14, kYaw: 6, lead: 0.03, kWarp: 2 };
}

/** One radio frame of what the tracker did, for learning and for the report. */
export interface TrackerLog {
  t: number;
  tau: number;
  phase: number;
  /** Feedback acceleration, NED, m/s^2 — what learning moves into the plan. */
  fb: [number, number, number];
  /** Position error, m. */
  err: number;
  /** Observed height, m — nothing is learned while sitting on the ground. */
  up: number;
  /** Observed velocity, NED, m/s — what drag is learned against. */
  vel: [number, number, number];
  sticks: StickInput;
}

export class Tracker {
  readonly traj: Trajectory;
  readonly gains: TrackerGains;
  /** Reference time. Starts with the run and never runs backwards. */
  tau = 0;
  private envelope: Envelope;
  private rates: RateProfile;
  private startYaw: number;
  private correction: Correction | null;
  private ref = flatSample();
  private ff = flatSample();
  private ffState = flatState();
  private want = flatState();
  private lastT = 0;
  private started = false;

  constructor(
    traj: Trajectory,
    startYaw: number,
    envelope: Envelope,
    rates: RateProfile,
    correction: Correction | null,
    gains: TrackerGains = defaultTrackerGains(),
  ) {
    this.traj = traj;
    this.startYaw = startYaw;
    this.envelope = envelope;
    this.rates = rates;
    this.correction = correction;
    this.gains = gains;
  }

  step(obs: Observation, log?: TrackerLog[]): StickInput {
    const g = this.gains;
    if (!this.started) {
      this.lastT = obs.t;
      this.started = true;
    }
    const dt = Math.max(0, obs.t - this.lastT);
    this.lastT = obs.t;

    const ref = this.traj.sample(this.tau, this.ref);
    const ff = this.traj.sample(this.tau + g.lead, this.ff);

    // ---- time warp: how far behind the reference are we, in seconds?
    const vref = Math.hypot(ref.v[0], ref.v[1], ref.v[2]);
    let behind = 0;
    if (vref > 1) {
      const along =
        ((ref.p[0] - obs.pos[0]) * ref.v[0] + (ref.p[1] - obs.pos[1]) * ref.v[1] + (ref.p[2] - obs.pos[2]) * ref.v[2]) /
        vref;
      behind = along / vref;
    }
    const rate = Math.min(1.1, Math.max(0.5, 1 - g.kWarp * behind));

    // ---- acceleration wanted: feedforward + learned correction + feedback
    let fbN = g.kPos * (ref.p[0] - obs.pos[0]) + g.kVel * (ref.v[0] - obs.vel[0]);
    let fbE = g.kPos * (ref.p[1] - obs.pos[1]) + g.kVel * (ref.v[1] - obs.vel[1]);
    let fbD = g.kPos * (ref.p[2] - obs.pos[2]) + g.kVel * (ref.v[2] - obs.vel[2]);
    const fbMag = Math.hypot(fbN, fbE, fbD);
    if (fbMag > g.maxFeedback) {
      const k = g.maxFeedback / fbMag;
      fbN *= k;
      fbE *= k;
      fbD *= k;
    }
    const phase = this.traj.phase(this.tau + g.lead);
    let cN = 0;
    let cE = 0;
    let cD = 0;
    if (this.correction) {
      const c = this.correction.at(phase);
      cN = c[0];
      cE = c[1];
      cD = c[2];
    }
    // Drag at the speed actually being flown, not the planned one: it is the
    // air the quad is in that pushes back.
    const drag = this.envelope.drag;
    const sp = Math.hypot(obs.vel[0], obs.vel[1], obs.vel[2]);
    const kd = drag.k1 + drag.k2 * sp;
    const aN = ff.a[0] + cN + fbN + kd * obs.vel[0];
    const aE = ff.a[1] + cE + fbE + kd * obs.vel[1];
    const aD = ff.a[2] + cD + fbD + kd * obs.vel[2];

    // ---- attitude and thrust for it
    const hd = headingFrom(ff.v, ff.a, this.startYaw);
    flatFromDrag(ff.a, ff.j, ff.v, drag, hd.yaw, hd.yawRate, this.ffState);
    attitudeFor(aN, aE, aD - G, hd.yaw, this.want);
    const qd = this.want.q;
    const q = obs.q;
    // q_err = conj(q) * qd, in the body frame.
    const ew = q.w * qd.w + q.x * qd.x + q.y * qd.y + q.z * qd.z;
    const ex = q.w * qd.x - q.x * qd.w - q.y * qd.z + q.z * qd.y;
    const ey = q.w * qd.y + q.x * qd.z - q.y * qd.w - q.z * qd.x;
    const ez = q.w * qd.z - q.x * qd.y + q.y * qd.x - q.z * qd.w;
    const sgn = ew < 0 ? -2 : 2;
    const p = this.ffState.omega[0] + g.kAtt * sgn * ex;
    const qq = this.ffState.omega[1] + g.kAtt * sgn * ey;
    const r = this.ffState.omega[2] + g.kYaw * sgn * ez;

    // Inflow along the thrust axis as it is now, not as wanted: that is the
    // air the props are actually in.
    const zbN = 2 * (q.x * q.z + q.w * q.y);
    const zbE = 2 * (q.y * q.z - q.w * q.x);
    const zbD = 1 - 2 * (q.x * q.x + q.y * q.y);
    const inflow = -(obs.vel[0] * zbN + obs.vel[1] * zbE + obs.vel[2] * zbD);
    const throttle = throttleFor(this.envelope, this.want.c, inflow);

    const sticks: StickInput = {
      throttle,
      roll: stickForRate(this.rates, AXIS_ROLL, p * RAD),
      // The control path runs nose-down positive; the body is FRD.
      pitch: stickForRate(this.rates, AXIS_PITCH, -qq * RAD),
      yaw: stickForRate(this.rates, AXIS_YAW, r * RAD),
    };

    if (log) {
      log.push({
        t: obs.t,
        tau: this.tau,
        phase,
        fb: [fbN, fbE, fbD],
        err: Math.hypot(ref.p[0] - obs.pos[0], ref.p[1] - obs.pos[1], ref.p[2] - obs.pos[2]),
        up: -obs.pos[2],
        vel: [obs.vel[0], obs.vel[1], obs.vel[2]],
        sticks,
      });
    }
    this.tau += dt * rate;
    return sticks;
  }
}
