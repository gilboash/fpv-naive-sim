/**
 * The rate controller, in Betaflight's units.
 *
 * Gains are the numbers from the configurator — P 45, I 80, D 30, F 120 — and
 * the scale factors below are Betaflight's own, so a pilot's real tune can be
 * typed in and behave like their real quad. That is a deliberate constraint on
 * this file: where a cleaner formulation would have been available, the
 * Betaflight one is used instead, because transferable feel is the product.
 *
 * Ported from src/main/flight/pid.c. Not modelled yet: anti-gravity, dynamic
 * idle, and the D_MIN gain scheduler. Each is a real part of modern feel and
 * each is listed in the README as a known gap rather than quietly omitted.
 */

import { PT1 } from './filter.ts';
import { clamp } from './math.ts';

const PTERM_SCALE = 0.032029;
const ITERM_SCALE = 0.244381;
const DTERM_SCALE = 0.000529;
const FEEDFORWARD_SCALE = 0.013754;

/** Betaflight divides the summed PID output by this before mixing. */
export const PID_MIXER_SCALING = 1000;

/** deg/s of setpoint movement above which I-term accumulation is fully cut. */
const ITERM_RELAX_THRESHOLD = 40;

export interface AxisGains {
  p: number;
  i: number;
  d: number;
  f: number;
}

export interface PidProfile {
  roll: AxisGains;
  pitch: AxisGains;
  yaw: AxisGains;
  /** Gyro lowpass, Hz. 0 disables. */
  gyroLowpassHz: number;
  /** D-term lowpass, Hz. 0 disables. */
  dtermLowpassHz: number;
  /** I-term relax lowpass, Hz. */
  itermRelaxHz: number;
  /** Absolute clamp on accumulated I, in output units. */
  itermLimit: number;
  /** Clamp on the summed output, roll/pitch. */
  pidSumLimit: number;
  /** Clamp on the summed output, yaw. */
  pidSumLimitYaw: number;
  /** Throttle above which P and D are attenuated, 0..1. */
  tpaBreakpoint: number;
  /** Fraction of P/D removed at full throttle. */
  tpaRate: number;
}

/** Betaflight 4.5 defaults for a 5" quad. */
export function defaultPids(): PidProfile {
  return {
    roll: { p: 45, i: 80, d: 30, f: 120 },
    pitch: { p: 47, i: 84, d: 34, f: 125 },
    yaw: { p: 45, i: 80, d: 0, f: 120 },
    gyroLowpassHz: 250,
    dtermLowpassHz: 117,
    itermRelaxHz: 15,
    itermLimit: 400,
    pidSumLimit: 500,
    pidSumLimitYaw: 400,
    tpaBreakpoint: 0.35,
    tpaRate: 0.65,
  };
}

interface AxisState {
  integral: number;
  prevGyro: number;
  prevSetpoint: number;
  dLowpass: PT1;
  relaxLowpass: PT1;
  /** Last computed components, for telemetry. */
  pOut: number;
  iOut: number;
  dOut: number;
  fOut: number;
  sum: number;
}

function newAxisState(profile: PidProfile, dt: number): AxisState {
  return {
    integral: 0,
    prevGyro: 0,
    prevSetpoint: 0,
    dLowpass: new PT1(profile.dtermLowpassHz, dt),
    relaxLowpass: new PT1(profile.itermRelaxHz, dt),
    pOut: 0,
    iOut: 0,
    dOut: 0,
    fOut: 0,
    sum: 0,
  };
}

export class RateController {
  readonly axes: [AxisState, AxisState, AxisState];
  private dt: number;

  profile: PidProfile;

  constructor(profile: PidProfile, dt: number) {
    this.profile = profile;
    this.dt = dt;
    this.axes = [
      newAxisState(profile, dt),
      newAxisState(profile, dt),
      newAxisState(profile, dt),
    ];
  }

  reset(): void {
    for (const a of this.axes) {
      a.integral = 0;
      a.prevGyro = 0;
      a.prevSetpoint = 0;
      a.dLowpass.reset(0);
      a.relaxLowpass.reset(0);
      a.pOut = a.iOut = a.dOut = a.fOut = a.sum = 0;
    }
  }

  private gainsFor(axis: number): AxisGains {
    return axis === 0 ? this.profile.roll : axis === 1 ? this.profile.pitch : this.profile.yaw;
  }

  /**
   * One axis, one step.
   *
   * @param axis      0 roll, 1 pitch, 2 yaw
   * @param setpoint  desired rate, deg/s
   * @param gyro      measured rate, deg/s, already gyro-filtered
   * @param throttle  0..1, for throttle PID attenuation
   * @returns         output in Betaflight pidSum units
   */
  update(axis: number, setpoint: number, gyro: number, throttle: number): number {
    const st = this.axes[axis]!;
    const g = this.gainsFor(axis);
    const dt = this.dt;

    const error = setpoint - gyro;

    // TPA: P and D come down as throttle rises, because a faster-spinning prop
    // produces more torque per unit of command and a tune that is right at
    // hover will oscillate at full throttle.
    let tpa = 1;
    if (throttle > this.profile.tpaBreakpoint) {
      const span = 1 - this.profile.tpaBreakpoint;
      const over = span > 0 ? (throttle - this.profile.tpaBreakpoint) / span : 1;
      tpa = 1 - clamp(over, 0, 1) * this.profile.tpaRate;
    }

    st.pOut = PTERM_SCALE * g.p * error * tpa;

    // I-term relax: while the stick is moving fast the error is mostly "the
    // quad has not got there yet", not a standing bias, and integrating it
    // just buys bounce-back at the end of the input.
    const setpointLpf = st.relaxLowpass.apply(setpoint);
    const setpointHpf = Math.abs(setpoint - setpointLpf);
    const relax = Math.max(0, 1 - setpointHpf / ITERM_RELAX_THRESHOLD);
    const growing = error * st.integral >= 0;
    const iError = growing ? error * relax : error;

    st.integral = clamp(
      st.integral + ITERM_SCALE * g.i * iError * dt,
      -this.profile.itermLimit,
      this.profile.itermLimit,
    );
    st.iOut = st.integral;

    // D on measurement, not on error: differentiating the setpoint puts a
    // spike into the motors on every stick movement. Feedforward covers that
    // job deliberately instead.
    const dGyro = (gyro - st.prevGyro) / dt;
    st.prevGyro = gyro;
    const dFiltered = st.dLowpass.apply(dGyro);
    st.dOut = -DTERM_SCALE * g.d * dFiltered * tpa;

    const dSetpoint = (setpoint - st.prevSetpoint) / dt;
    st.prevSetpoint = setpoint;
    st.fOut = FEEDFORWARD_SCALE * g.f * dSetpoint;

    const limit = axis === 2 ? this.profile.pidSumLimitYaw : this.profile.pidSumLimit;
    st.sum = clamp(st.pOut + st.iOut + st.dOut + st.fOut, -limit, limit);
    return st.sum;
  }
}
