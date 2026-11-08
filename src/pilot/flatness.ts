/**
 * Differential flatness: from a trajectory's derivatives to what the quad must
 * be doing to fly it.
 *
 * Acceleration fixes the thrust vector, so the thrust magnitude and the
 * direction of body-down. Heading fixes the rest of the attitude. Jerk fixes
 * the roll and pitch rates. All of it in NED and the body's FRD frame, the same
 * frames as the physics, so nothing here has to know about the pilot's
 * nose-down-positive pitch. That conversion happens once, where rates become
 * sticks.
 *
 * Mass-normalised throughout: thrust is a specific force in m/s^2. A pilot
 * never knows the mass of the aircraft they are flying, and neither does this.
 */

import type { Quat } from '../flight/math.ts';

export const G = 9.80665;

/** What the airframe must be doing at one instant of a trajectory. */
export interface FlatState {
  /** Thrust over mass, m/s^2. */
  c: number;
  /** Body-to-world rotation. */
  q: Quat;
  /** Body rates, FRD, rad/s. */
  omega: [number, number, number];
  /** Body axes in world NED, kept for the tracker. */
  xb: [number, number, number];
  yb: [number, number, number];
  zb: [number, number, number];
}

export function flatState(): FlatState {
  return {
    c: G,
    q: { w: 1, x: 0, y: 0, z: 0 },
    omega: [0, 0, 0],
    xb: [1, 0, 0],
    yb: [0, 1, 0],
    zb: [0, 0, 1],
  };
}

/**
 * Attitude from a wanted specific force and a heading.
 *
 * x_b is built as y_c x z_b, with y_c the horizontal right-hand vector of the
 * heading. The alternative, z_b x x_c, degenerates when the quad pitches
 * towards 90 degrees, and a racing quad at full throttle and constant altitude
 * sits at 83. This one degenerates at 90 degrees of *bank* with no vertical
 * thrust, which a quad holding altitude never reaches.
 */
export function attitudeFor(
  fN: number,
  fE: number,
  fD: number,
  yaw: number,
  out: FlatState,
): void {
  let c = Math.hypot(fN, fE, fD);
  if (c < 1e-6) c = 1e-6;
  // Thrust acts along -z_b.
  const zN = -fN / c;
  const zE = -fE / c;
  const zD = -fD / c;
  const ycN = -Math.sin(yaw);
  const ycE = Math.cos(yaw);
  // x_b = y_c x z_b, with y_c = (ycN, ycE, 0)
  let xN = ycE * zD;
  let xE = -ycN * zD;
  let xD = ycN * zE - ycE * zN;
  const xl = Math.hypot(xN, xE, xD) || 1;
  xN /= xl;
  xE /= xl;
  xD /= xl;
  // y_b = z_b x x_b
  const yN = zE * xD - zD * xE;
  const yE = zD * xN - zN * xD;
  const yD = zN * xE - zE * xN;
  out.c = c;
  out.xb[0] = xN;
  out.xb[1] = xE;
  out.xb[2] = xD;
  out.yb[0] = yN;
  out.yb[1] = yE;
  out.yb[2] = yD;
  out.zb[0] = zN;
  out.zb[1] = zE;
  out.zb[2] = zD;
  // Rotation matrix with body axes as columns -> quaternion.
  const m00 = xN, m01 = yN, m02 = zN;
  const m10 = xE, m11 = yE, m12 = zE;
  const m20 = xD, m21 = yD, m22 = zD;
  const tr = m00 + m11 + m22;
  const q = out.q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q.w = 0.25 * s;
    q.x = (m21 - m12) / s;
    q.y = (m02 - m20) / s;
    q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q.w = (m21 - m12) / s;
    q.x = 0.25 * s;
    q.y = (m01 + m10) / s;
    q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q.w = (m02 - m20) / s;
    q.x = (m01 + m10) / s;
    q.y = 0.25 * s;
    q.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q.w = (m10 - m01) / s;
    q.x = (m02 + m20) / s;
    q.y = (m12 + m21) / s;
    q.z = 0.25 * s;
  }
}

/**
 * Drag as the pilot has learned it: a deceleration of (k1 + k2 |v|) v.
 *
 * Linear plus quadratic because both are there. Rotor disc drag is linear in
 * airspeed and the frame's is quadratic, and on the first circle the feedback
 * along the direction of travel came out at 5 m/s^2 at 20 m/s and 10 at 35 —
 * about a g that the flat model, which knows only thrust and gravity, did not
 * know it needed.
 */
export interface Drag {
  k1: number;
  k2: number;
}

export function noDrag(): Drag {
  return { k1: 0, k2: 0 };
}

/**
 * The thrust (specific force) a trajectory needs, and its rate of change.
 * f = a - g + drag(v); f' = j + d/dt[(k1 + k2|v|) v].
 */
export function thrustFrom(
  a: readonly number[],
  j: readonly number[],
  v: readonly number[],
  drag: Drag,
  f: number[],
  fdot: number[],
): void {
  const sp = Math.hypot(v[0]!, v[1]!, v[2]!);
  const k = drag.k1 + drag.k2 * sp;
  const va = sp > 1e-6 ? (v[0]! * a[0]! + v[1]! * a[1]! + v[2]! * a[2]!) / sp : 0;
  for (let i = 0; i < 3; i++) {
    f[i] = a[i]! + k * v[i]!;
    fdot[i] = j[i]! + k * a[i]! + drag.k2 * va * v[i]!;
  }
  f[2] = f[2]! - G;
}

/**
 * The full flat state from thrust, its rate, heading and heading rate.
 *
 * Roll and pitch rate come from the thrust rate: with f = -c z_b,
 * f' = -c' z_b - c (q x_b - p y_b), so p = (f' . y_b) / c and
 * q = -(f' . x_b) / c. Without drag f' is just jerk. Yaw rate is whatever
 * makes the heading turn at yawRate given that tilt.
 */
export function flatFromThrust(
  f: readonly number[],
  fdot: readonly number[],
  yaw: number,
  yawRate: number,
  out: FlatState,
): FlatState {
  attitudeFor(f[0]!, f[1]!, f[2]!, yaw, out);
  const c = out.c;
  const jy = fdot[0]! * out.yb[0] + fdot[1]! * out.yb[1] + fdot[2]! * out.yb[2];
  const jx = fdot[0]! * out.xb[0] + fdot[1]! * out.xb[1] + fdot[2]! * out.xb[2];
  const p = jy / c;
  const q = -jx / c;
  // x_b is perpendicular to y_c by construction, so d/dt(x_b . y_c) = 0:
  //   (omega x x_b) . y_c + x_b . (dy_c/dt) = 0
  // with dy_c/dt = -yawRate * x_c and omega x x_b = r y_b - q z_b in body
  // terms. Solve for r.
  const xcN = Math.cos(yaw);
  const xcE = Math.sin(yaw);
  const ycN = -Math.sin(yaw);
  const ycE = Math.cos(yaw);
  const ybyc = out.yb[0] * ycN + out.yb[1] * ycE;
  const zbyc = out.zb[0] * ycN + out.zb[1] * ycE;
  const xbxc = out.xb[0] * xcN + out.xb[1] * xcE;
  const r = Math.abs(ybyc) > 1e-6 ? (q * zbyc + yawRate * xbxc) / ybyc : 0;
  out.omega[0] = p;
  out.omega[1] = q;
  out.omega[2] = r;
  return out;
}

const scratchF = [0, 0, 0];
const scratchFd = [0, 0, 0];

/** The flat state with no drag: thrust from acceleration, its rate from jerk. */
export function flatFrom(
  a: readonly number[],
  j: readonly number[],
  yaw: number,
  yawRate: number,
  out: FlatState,
): FlatState {
  scratchF[0] = a[0]!;
  scratchF[1] = a[1]!;
  scratchF[2] = a[2]! - G;
  return flatFromThrust(scratchF, j, yaw, yawRate, out);
}

/** The flat state with drag. */
export function flatFromDrag(
  a: readonly number[],
  j: readonly number[],
  v: readonly number[],
  drag: Drag,
  yaw: number,
  yawRate: number,
  out: FlatState,
): FlatState {
  thrustFrom(a, j, v, drag, scratchF, scratchFd);
  return flatFromThrust(scratchF, scratchFd, yaw, yawRate, out);
}

/**
 * Heading and its rate from velocity and acceleration: point where you are
 * going, as a pilot does.
 *
 * Biased towards `fallbackYaw` at low horizontal speed, where the direction of
 * travel is noise — on the start line, and at the bottom of a vertical drop.
 */
export function headingFrom(
  v: readonly number[],
  a: readonly number[],
  fallbackYaw: number,
  blendSpeed = 1.5,
): { yaw: number; yawRate: number } {
  const bN = Math.cos(fallbackYaw) * blendSpeed;
  const bE = Math.sin(fallbackYaw) * blendSpeed;
  const hN = v[0]! + bN;
  const hE = v[1]! + bE;
  const h2 = hN * hN + hE * hE;
  const yaw = Math.atan2(hE, hN);
  const yawRate = h2 > 1e-9 ? (hN * a[1]! - hE * a[0]!) / h2 : 0;
  return { yaw, yawRate };
}
