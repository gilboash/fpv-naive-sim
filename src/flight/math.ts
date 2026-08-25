/**
 * Minimal 3D maths for the flight model.
 *
 * Frames follow the aerospace convention rather than the graphics one, so the
 * PID and gyro signs match Betaflight directly and a real tune can be typed in
 * without translation:
 *
 *   body:  x forward (nose), y right, z down          (FRD)
 *   world: x north,          y east,  z down          (NED)
 *
 * Gravity is therefore +z. Roll is about x, pitch about y, yaw about z, all
 * right-handed, all matching what a flight controller's gyro reports. The
 * renderer converts to Y-up at its own boundary; the physics never does.
 *
 * Everything here mutates an output argument instead of returning a fresh
 * object: this runs 1000 times a second inside the input tick, and the hot
 * path allocates nothing.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion rotating body vectors into world. w is the scalar part. */
export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function setV(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyV(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function addV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function subV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

/** out = a + b * s */
export function addScaledV(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function scaleV(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

export function crossV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function dotV(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lenV(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function quat(w = 1, x = 0, y = 0, z = 0): Quat {
  return { w, x, y, z };
}

export function copyQ(out: Quat, a: Quat): Quat {
  out.w = a.w;
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function normaliseQ(q: Quat): Quat {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (n === 0) {
    q.w = 1;
    q.x = q.y = q.z = 0;
    return q;
  }
  const inv = 1 / n;
  q.w *= inv;
  q.x *= inv;
  q.y *= inv;
  q.z *= inv;
  return q;
}

/** Rotate a body-frame vector into the world frame. out may alias v. */
export function rotateBodyToWorld(out: Vec3, q: Quat, v: Vec3): Vec3 {
  // t = 2 * (qv x v); out = v + q.w * t + qv x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  const x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  const y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  const z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Rotate a world-frame vector into the body frame. out may alias v. */
export function rotateWorldToBody(out: Vec3, q: Quat, v: Vec3): Vec3 {
  // Conjugate rotation: same expression with the vector part negated.
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  const x = v.x + q.w * tx + (-q.y * tz + q.z * ty);
  const y = v.y + q.w * ty + (-q.z * tx + q.x * tz);
  const z = v.z + q.w * tz + (-q.x * ty + q.y * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * Integrate orientation by a body-frame angular velocity over dt.
 *
 * Uses the exact exponential map rather than q += 0.5*w*q*dt. At 1 kHz the
 * linearised form is accurate enough in the small, but it loses norm steadily
 * during sustained fast rotation — and a 5" racing quad spends real time above
 * 1000 deg/s, where that drift shows up as attitude that slowly lies.
 */
export function integrateQ(q: Quat, w: Vec3, dt: number): Quat {
  const wx = w.x * dt * 0.5;
  const wy = w.y * dt * 0.5;
  const wz = w.z * dt * 0.5;
  const theta = Math.hypot(wx, wy, wz);

  let sw: number;
  let s: number;
  if (theta < 1e-8) {
    // Series expansion; avoids 0/0 in sin(theta)/theta at rest.
    sw = 1 - (theta * theta) / 2;
    s = 1 - (theta * theta) / 6;
  } else {
    sw = Math.cos(theta);
    s = Math.sin(theta) / theta;
  }

  const dx = s * wx;
  const dy = s * wy;
  const dz = s * wz;

  // q = q * dq  (body-frame increment applies on the right)
  const w0 = q.w;
  const x0 = q.x;
  const y0 = q.y;
  const z0 = q.z;
  q.w = w0 * sw - x0 * dx - y0 * dy - z0 * dz;
  q.x = w0 * dx + x0 * sw + y0 * dz - z0 * dy;
  q.y = w0 * dy - x0 * dz + y0 * sw + z0 * dx;
  q.z = w0 * dz + x0 * dy - y0 * dx + z0 * sw;
  return normaliseQ(q);
}

export interface Euler {
  /** Rotation about body x, radians. Positive = right side down. */
  roll: number;
  /** Rotation about body y, radians. Positive = nose up. */
  pitch: number;
  /** Rotation about body z, radians. Positive = nose right. */
  yaw: number;
}

/** Z-Y-X (yaw, then pitch, then roll) Euler angles, the aviation ordering. */
export function toEuler(out: Euler, q: Quat): Euler {
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  out.roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  // Clamp rather than let asin() go NaN a hair outside [-1,1] from rounding.
  out.pitch = Math.asin(Math.max(-1, Math.min(1, sinp)));
  out.yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  return out;
}

export function fromEuler(out: Quat, roll: number, pitch: number, yaw: number): Quat {
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  out.w = cr * cp * cy + sr * sp * sy;
  out.x = sr * cp * cy - cr * sp * sy;
  out.y = cr * sp * cy + sr * cp * sy;
  out.z = cr * cp * sy - sr * sp * cy;
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
