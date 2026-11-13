/**
 * 4x4 matrices, column-major, the layout WebGL wants.
 *
 * Small and self-contained rather than a dependency: the renderer needs a
 * perspective, a look-at and a multiply, and that is all this is. Everything
 * mutates an output argument, because these run every frame.
 */

export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** Right-handed perspective with a [-1,1] depth range. */
export function perspective(out: Mat4, fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * View matrix from an eye position and an orthonormal camera basis.
 *
 * Takes the basis directly rather than a target point: the camera here is
 * rigidly attached to an aircraft whose orientation is already a rotation
 * matrix, and going via a look-at target would throw away the roll and then
 * need it put back.
 */
export function viewFromBasis(
  out: Mat4,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number,
  fx: number,
  fy: number,
  fz: number,
): Mat4 {
  // Camera looks down -z in view space, so the third row is the negated forward.
  const bx = -fx;
  const by = -fy;
  const bz = -fz;
  out[0] = rx;
  out[1] = ux;
  out[2] = bx;
  out[3] = 0;
  out[4] = ry;
  out[5] = uy;
  out[6] = by;
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = bz;
  out[11] = 0;
  out[12] = -(rx * eyeX + ry * eyeY + rz * eyeZ);
  out[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
  out[14] = -(bx * eyeX + by * eyeY + bz * eyeZ);
  out[15] = 1;
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    out[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    out[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    out[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    out[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return out;
}

/** Translation only; the scene has no rotated or scaled instances. */
export function translation(out: Mat4, x: number, y: number, z: number): Mat4 {
  identity(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

/** General 4x4 inverse. Returns false, leaving `out` untouched, if `m` is singular. */
export function invert(out: Mat4, m: Mat4): boolean {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return false;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}
