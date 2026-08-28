/**
 * Quad X mixer with Betaflight's airmode behaviour.
 *
 * The mix coefficients are derived from the geometry rather than copied, and
 * they differ from Betaflight's published QUADX table in the sign of pitch.
 * That is deliberate and it is a convention difference, not a disagreement:
 * this model defines positive pitch as nose-up throughout, matching the Euler
 * angles in math.ts, so a positive pitch command has to raise the front
 * motors. The PID gains are sign-agnostic, so a real tune still transfers.
 * The rate-tracking tests in tools/flight-check.ts assert every one of these
 * signs, which is the only reason to trust the paragraph you are reading.
 *
 * Airmode is the part that matters for feel. Without it, a mix that would push
 * a motor below zero simply clips, the quad silently loses roll authority at
 * low throttle, and it falls out of flips. With it, the throttle is shifted to
 * keep the whole mix representable, and the quad holds attitude at zero stick.
 */

import type { MotorMount } from './airframe.ts';
import { clamp } from './math.ts';

export interface MixCoeffs {
  roll: number;
  pitch: number;
  yaw: number;
}

/** Derive the mix from where the motors actually are and which way they turn. */
export function mixFromGeometry(mounts: MotorMount[]): MixCoeffs[] {
  let maxX = 0;
  let maxY = 0;
  for (const m of mounts) {
    maxX = Math.max(maxX, Math.abs(m.pos.x));
    maxY = Math.max(maxY, Math.abs(m.pos.y));
  }
  return mounts.map((m) => ({
    // Roll moment from a motor is -y*T, so the left side (negative y) is the
    // side that rolls the quad right.
    roll: maxY > 0 ? -m.pos.y / maxY : 0,
    // Pitch moment is +x*T: the front raises the nose.
    pitch: maxX > 0 ? m.pos.x / maxX : 0,
    // Reaction torque yaws opposite the rotor, so a CCW rotor yaws nose-right.
    yaw: m.spin,
  }));
}

export interface MixResult {
  /** Per-motor ESC command, 0..1. */
  outputs: number[];
  /** True if the mix had to be scaled back to fit. */
  saturated: boolean;
  /** Throttle actually used after any airmode shift. */
  throttleUsed: number;
  /**
   * Spread of the raw mix before any clamping, Betaflight's motor mix range.
   * The controller uses it for anti-windup: a mix wider than the motors can
   * express means the correction is not being delivered, and integrating
   * against that is how a controller winds itself into an oscillation.
   */
  range: number;
}

export class Mixer {
  readonly result: MixResult;
  private mix: MixCoeffs[];

  airmode: boolean;

  constructor(mounts: MotorMount[], airmode = true) {
    this.airmode = airmode;
    this.mix = mixFromGeometry(mounts);
    this.result = {
      outputs: new Array<number>(mounts.length).fill(0),
      saturated: false,
      throttleUsed: 0,
      range: 0,
    };
  }

  /**
   * @param throttle 0..1 stick throttle
   * @param roll     pidSum/PID_MIXER_SCALING for roll
   * @param pitch    likewise
   * @param yaw      likewise
   */
  apply(throttle: number, roll: number, pitch: number, yaw: number): MixResult {
    const res = this.result;
    const out = res.outputs;
    const n = this.mix.length;

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const m = this.mix[i]!;
      const v = roll * m.roll + pitch * m.pitch + yaw * m.yaw;
      out[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    const range = hi - lo;
    res.range = range;
    res.saturated = false;
    let thr = clamp(throttle, 0, 1);

    if (range > 1) {
      // The demand is wider than the motor range can express at any throttle.
      // Scale the whole mix rather than clipping one motor, which would corrupt
      // the axis ratios and roll the quad while it was trying to yaw.
      const s = 1 / range;
      for (let i = 0; i < n; i++) out[i]! *= s;
      lo *= s;
      hi *= s;
      thr = 0.5;
      res.saturated = true;
    } else if (this.airmode) {
      // Airmode shifts throttle to fit the mix. When the throttle stick is at
      // the bottom the shift puts the lowest motor at exactly zero, so any
      // further correction on that side has nowhere to go — which is why the
      // range above matters to the controller.

      // Shift throttle so the full mix fits. This is what keeps attitude
      // authority at zero throttle.
      const min = -lo;
      const max = 1 - hi;
      if (min > max) {
        thr = (min + max) / 2;
        res.saturated = true;
      } else {
        thr = clamp(thr, min, max);
      }
    }

    for (let i = 0; i < n; i++) out[i] = clamp(thr + out[i]!, 0, 1);
    res.throttleUsed = thr;
    return res;
  }
}
