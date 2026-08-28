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
