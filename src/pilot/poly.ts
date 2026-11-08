/**
 * Minimum-snap piecewise polynomials: a trajectory with exact derivatives.
 *
 * The parked bot flew a spline with a speed profile bolted on, and its
 * feedforward came from differentiating that spline numerically — which cost
 * more in noise than it bought in lead. A quadrotor is differentially flat in
 * position and yaw: thrust needs the second derivative of position, body rates
 * the third. So the line has to be a polynomial whose derivatives are known in
 * closed form, continuous to snap, or there is nothing clean to feed forward.
 *
 * Degree 7 per segment and per axis, solved in the unconstrained form of
 * Richter, Bry & Roy (2013): the unknowns are the derivatives at each knot
 * rather than the coefficients, so continuity holds by construction and the
 * whole problem is one symmetric linear solve. The lap is periodic — the last
 * knot is the first — so a lap flown twice joins itself smoothly.
 *
 * Pure TypeScript, no parameter properties: this runs under strip-types.
 */

export const DEG7 = 8; // coefficients per segment
const DERIVS = 4; // position, velocity, acceleration, jerk at each knot

/** Falling factorial k!/(k-d)!, zero when d > k. */
function fall(k: number, d: number): number {
  if (d > k) return 0;
  let r = 1;
  for (let i = 0; i < d; i++) r *= k - i;
  return r;
}

/**
 * Solve A x = b in place by Gaussian elimination with partial pivoting.
 * `a` is row-major n x n and is destroyed; `b` holds `m` right-hand sides
 * column-interleaved (b[row * m + col]) and receives the solutions.
 */
export function solveDense(a: Float64Array, b: Float64Array, n: number, m = 1): void {
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(a[col * n + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-300) throw new Error('solveDense: singular matrix');
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k]!;
        a[col * n + k] = a[piv * n + k]!;
        a[piv * n + k] = t;
      }
      for (let k = 0; k < m; k++) {
        const t = b[col * m + k]!;
        b[col * m + k] = b[piv * m + k]!;
        b[piv * m + k] = t;
      }
    }
    const d = a[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / d;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[r * n + k] = a[r * n + k]! - f * a[col * n + k]!;
      for (let k = 0; k < m; k++) b[r * m + k] = b[r * m + k]! - f * b[col * m + k]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < m; k++) {
      let s = b[r * m + k]!;
      for (let c = r + 1; c < n; c++) s -= a[r * n + c]! * b[c * m + k]!;
      b[r * m + k] = s / a[r * n + r]!;
    }
  }
}

/**
 * The 8x8 map from a segment's coefficients to its boundary derivatives,
 * inverted: coefficients = M * [d0(0..3), d1(0..3)].
 */
function boundaryInverse(T: number): Float64Array {
  const A = new Float64Array(64);
  for (let d = 0; d < DERIVS; d++) {
    // At t = 0 only the k = d term survives.
    A[d * 8 + d] = fall(d, d);
    for (let k = 0; k < DEG7; k++) A[(d + 4) * 8 + k] = fall(k, d) * Math.pow(T, k - d);
  }
  // Invert by solving against the identity.
  const I = new Float64Array(64);
  for (let i = 0; i < 8; i++) I[i * 8 + i] = 1;
  solveDense(A, I, 8, 8);
  return I;
}

/**
 * Snap cost of one segment as a quadratic form in its boundary derivatives:
 * J = d^T H d with d = [d0(0..3), d1(0..3)].
 */
function segmentHessian(T: number, M: Float64Array): Float64Array {
  // Q in coefficient space: integral of snap squared.
  const Q = new Float64Array(64);
  for (let i = 4; i < DEG7; i++) {
    for (let j = 4; j < DEG7; j++) {
      const p = i + j - 7;
      Q[i * 8 + j] = (fall(i, 4) * fall(j, 4) * Math.pow(T, p)) / p;
    }
  }
  // H = M^T Q M
  const QM = new Float64Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += Q[i * 8 + k]! * M[k * 8 + j]!;
      QM[i * 8 + j] = s;
    }
  }
  const H = new Float64Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += M[k * 8 + i]! * QM[k * 8 + j]!;
      H[i * 8 + j] = s;
    }
  }
  return H;
}

/** Coefficients from boundary derivatives, for one axis. */
function coeffs(M: Float64Array, d: Float64Array, out: Float64Array, offset: number): void {
  for (let i = 0; i < 8; i++) {
    let s = 0;
    for (let k = 0; k < 8; k++) s += M[i * 8 + k]! * d[k]!;
    out[offset + i] = s;
  }
}

/** One derivative of a degree-7 polynomial at local time t. */
export function polyAt(c: Float64Array, offset: number, t: number, d: number): number {
  let s = 0;
  let tp = 1;
  for (let k = d; k < DEG7; k++) {
    s += c[offset + k]! * fall(k, d) * tp;
    tp *= t;
  }
  return s;
}

/** Position, velocity, acceleration, jerk and snap in NED, written in place. */
export interface FlatSample {
  p: [number, number, number];
  v: [number, number, number];
  a: [number, number, number];
  j: [number, number, number];
  s: [number, number, number];
}

export function flatSample(): FlatSample {
  return { p: [0, 0, 0], v: [0, 0, 0], a: [0, 0, 0], j: [0, 0, 0], s: [0, 0, 0] };
}

/**
 * Knot derivatives of a periodic lap through `knots` (NED, n x 3) with segment
 * durations `T` (segment i runs from knot i to knot i+1, the last back to 0).
 *
 * `dirs`, when given (n x 3, unit vectors), pins the *direction* of the
 * velocity at every knot and leaves its magnitude to the solve. That is how a
 * gate gets a way through: a minimum-snap line left to choose its own velocity
 * will happily sweep through a gate sideways, or loop back through it the
 * wrong way, because snap does not know what a gate is. Pinning the speed as
 * well was the first version, and it made the search fight itself — each
 * gate's speed and each segment's duration were separate variables, so the
 * line surged between every pair of gates. With the magnitude inside the
 * solve, speed falls out of the timing.
 *
 * The constraint couples the three axes (one speed shared by all of them), so
 * this is one joint system rather than three. Unknowns per knot: speed,
 * acceleration (3), jerk (3) — or with no `dirs`, velocity (3) instead of
 * speed.
 *
 * Returns, per knot and axis, [p, v, a, j] — 4n x 3, row-major by knot.
 */
export function solvePeriodic(knots: Float64Array, T: Float64Array, dirs?: Float64Array): Float64Array {
  const n = T.length;
  const per = dirs ? 7 : 9;
  // For local derivative d of knot k on axis ax: the slot within the knot's
  // block it reads, or -1 for a fixed value (position).
  const local = (d: number, ax: number): number => {
    if (d === 0) return -1;
    if (d === 1) return dirs ? 0 : ax;
    return (dirs ? 1 : 3) + (d - 2) * 3 + ax;
  };
  const coef = (k: number, d: number, ax: number): number => (d === 1 && dirs ? dirs[k * 3 + ax]! : 1);

  // Blocks: D[k] is knot k with itself, U[k] is knot k with knot k+1 (mod n).
  // The system is symmetric, so the block below the diagonal is U^T.
  const bb = per * per;
  const D = new Float64Array(n * bb);
  const U = new Float64Array(n * bb);
  const R = new Float64Array(n * per);
  const li = new Int32Array(8);
  const lk = new Int32Array(8);
  const vc = new Float64Array(8);
  const fx = new Float64Array(8);
  for (let sg = 0; sg < n; sg++) {
    const M = boundaryInverse(T[sg]!);
    const H = segmentHessian(T[sg]!, M);
    const k0 = sg;
    const k1 = (sg + 1) % n;
    for (let ax = 0; ax < 3; ax++) {
      for (let r = 0; r < 8; r++) {
        const k = r < 4 ? k0 : k1;
        const d = r & 3;
        li[r] = local(d, ax);
        lk[r] = r < 4 ? 0 : 1;
        vc[r] = coef(k, d, ax);
        fx[r] = d === 0 ? knots[k * 3 + ax]! : 0;
      }
      for (let r = 0; r < 8; r++) {
        if (li[r]! < 0) continue;
        const kr = lk[r] === 0 ? k0 : k1;
        const row = li[r]!;
        const cr = vc[r]!;
        for (let c = 0; c < 8; c++) {
          const h = H[r * 8 + c]! * cr;
          if (li[c]! < 0) {
            R[kr * per + row] = R[kr * per + row]! - h * fx[c]!;
            continue;
          }
          const col = li[c]!;
          const v = h * vc[c]!;
          if (lk[r] === lk[c]) D[kr * bb + row * per + col] = D[kr * bb + row * per + col]! + v;
          else if (lk[r] === 0) U[k0 * bb + row * per + col] = U[k0 * bb + row * per + col]! + v;
          // lk[r] === 1, lk[c] === 0 is the transpose of the line above.
        }
      }
    }
  }

  const z = n >= 3 && !solveCyclicOverride ? solveCyclicBlocks(D, U, R, n, per) : solveBlocksDense(D, U, R, n, per);

  const out = new Float64Array(n * 4 * 3);
  for (let k = 0; k < n; k++) {
    for (let ax = 0; ax < 3; ax++) {
      for (let d = 0; d < 4; d++) {
        const sl = local(d, ax);
        out[(k * 4 + d) * 3 + ax] = sl < 0 ? knots[k * 3 + ax]! : z[k * per + sl]! * coef(k, d, ax);
      }
    }
  }
  return out;
}

/** Fallback for tiny loops: assemble the blocks densely. */
function solveBlocksDense(D: Float64Array, U: Float64Array, R: Float64Array, n: number, b: number): Float64Array {
  const N = n * b;
  const A = new Float64Array(N * N);
  const bb = b * b;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    for (let i = 0; i < b; i++) {
      for (let j = 0; j < b; j++) {
        A[(k * b + i) * N + k * b + j] = A[(k * b + i) * N + k * b + j]! + D[k * bb + i * b + j]!;
        A[(k * b + i) * N + k1 * b + j] = A[(k * b + i) * N + k1 * b + j]! + U[k * bb + i * b + j]!;
        A[(k1 * b + j) * N + k * b + i] = A[(k1 * b + j) * N + k * b + i]! + U[k * bb + i * b + j]!;
      }
    }
  }
  const x = Float64Array.from(R);
  solveDense(A, x, N, 1);
  return x;
}

/** out = A (b x b) * X (b x m), row-major. */
function mulBlock(A: Float64Array, ao: number, X: Float64Array, xo: number, b: number, m: number, out: Float64Array): void {
  for (let i = 0; i < b; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < b; k++) s += A[ao + i * b + k]! * X[xo + k * m + j]!;
      out[i * m + j] = s;
    }
  }
}

/** out = A^T (b x b) * X (b x m). */
function mulBlockT(A: Float64Array, ao: number, X: Float64Array, xo: number, b: number, m: number, out: Float64Array): void {
  for (let i = 0; i < b; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < b; k++) s += A[ao + k * b + i]! * X[xo + k * m + j]!;
      out[i * m + j] = s;
    }
  }
}

/**
 * A symmetric block-tridiagonal system with periodic corners, by bordering.
 *
 * Knot 0 is taken out as the border; what remains is plainly block
 * tridiagonal and goes through block Thomas, carrying the border's columns as
 * extra right-hand sides; a small Schur complement then gives knot 0. O(n b^3)
 * where the dense solve was O(n^3 b^3) — on the 41-checkpoint Thrust line that
 * is the difference between the planner taking minutes and taking seconds.
 */
function solveCyclicBlocks(D: Float64Array, U: Float64Array, R: Float64Array, n: number, b: number): Float64Array {
  const bb = b * b;
  const m = b + 1; // columns: rhs, then the border's b columns
  const inner = n - 1; // blocks 1..n-1
  // RHS for the inner system: [R_k | B_k], B_1 = U_0^T, B_{n-1} = U_{n-1}.
  const rhs = new Float64Array(inner * b * m);
  for (let k = 1; k < n; k++) {
    const base = (k - 1) * b * m;
    for (let i = 0; i < b; i++) rhs[base + i * m] = R[k * b + i]!;
  }
  for (let i = 0; i < b; i++) {
    for (let j = 0; j < b; j++) {
      // B_1 = U_0^T: row i of block 1, col j of knot 0 -> U_0[j][i]
      rhs[0 * b * m + i * m + 1 + j] = rhs[0 * b * m + i * m + 1 + j]! + U[0 * bb + j * b + i]!;
      // B_{n-1} = U_{n-1}: row i of block n-1, col j of knot 0
      const base = (n - 2) * b * m;
      rhs[base + i * m + 1 + j] = rhs[base + i * m + 1 + j]! + U[(n - 1) * bb + i * b + j]!;
    }
  }
  // Forward sweep. Cp[k] = M_k^{-1} U_k (b x b), dp[k] = M_k^{-1} (rhs_k - U_{k-1}^T dp[k-1]).
  const Cp = new Float64Array(inner * bb);
  const dp = new Float64Array(inner * b * m);
  const Mk = new Float64Array(bb);
  const tmpB = new Float64Array(bb);
  const tmpM = new Float64Array(b * m);
  const work = new Float64Array(b * (b + m));
  for (let idx = 0; idx < inner; idx++) {
    const k = idx + 1;
    Mk.set(D.subarray(k * bb, k * bb + bb));
    const rk = new Float64Array(b * m);
    rk.set(rhs.subarray(idx * b * m, (idx + 1) * b * m));
    if (idx > 0) {
      // M = D_k - U_{k-1}^T Cp[k-1]
      mulBlockT(U, (k - 1) * bb, Cp, (idx - 1) * bb, b, b, tmpB);
      for (let i = 0; i < bb; i++) Mk[i] = Mk[i]! - tmpB[i]!;
      mulBlockT(U, (k - 1) * bb, dp, (idx - 1) * b * m, b, m, tmpM);
      for (let i = 0; i < b * m; i++) rk[i] = rk[i]! - tmpM[i]!;
    }
    // Solve M [Cp | dp] = [U_k | rk] in one go (U_k only for k < n-1).
    const cols = idx < inner - 1 ? b + m : m;
    for (let i = 0; i < b; i++) {
      for (let j = 0; j < m; j++) work[i * cols + j] = rk[i * m + j]!;
      if (cols > m) for (let j = 0; j < b; j++) work[i * cols + m + j] = U[k * bb + i * b + j]!;
    }
    const A = Float64Array.from(Mk);
    solveDense(A, work, b, cols);
    for (let i = 0; i < b; i++) {
      for (let j = 0; j < m; j++) dp[idx * b * m + i * m + j] = work[i * cols + j]!;
      if (cols > m) for (let j = 0; j < b; j++) Cp[idx * bb + i * b + j] = work[i * cols + m + j]!;
    }
  }
  // Back substitution: Y[k] = dp[k] - Cp[k] Y[k+1].
  const Y = new Float64Array(inner * b * m);
  Y.set(dp.subarray((inner - 1) * b * m, inner * b * m), (inner - 1) * b * m);
  for (let idx = inner - 2; idx >= 0; idx--) {
    mulBlock(Cp, idx * bb, Y, (idx + 1) * b * m, b, m, tmpM);
    for (let i = 0; i < b * m; i++) Y[idx * b * m + i] = dp[idx * b * m + i]! - tmpM[i]!;
  }
  // y_k = Y_r,k - Y_B,k x. Border equation:
  //   (D_0 - U_0 Y_B,1 - U_{n-1}^T Y_B,n-1) x = R_0 - U_0 Y_r,1 - U_{n-1}^T Y_r,n-1
  const S = new Float64Array(bb);
  const sr = new Float64Array(b);
  const t1 = new Float64Array(b * m);
  const t2 = new Float64Array(b * m);
  mulBlock(U, 0, Y, 0, b, m, t1);
  mulBlockT(U, (n - 1) * bb, Y, (inner - 1) * b * m, b, m, t2);
  for (let i = 0; i < b; i++) {
    sr[i] = R[i]! - t1[i * m]! - t2[i * m]!;
    for (let j = 0; j < b; j++) S[i * b + j] = D[i * b + j]! - t1[i * m + 1 + j]! - t2[i * m + 1 + j]!;
  }
  solveDense(S, sr, b, 1);
  const z = new Float64Array(n * b);
  for (let i = 0; i < b; i++) z[i] = sr[i]!;
  for (let idx = 0; idx < inner; idx++) {
    for (let i = 0; i < b; i++) {
      let v = Y[idx * b * m + i * m]!;
      for (let j = 0; j < b; j++) v -= Y[idx * b * m + i * m + 1 + j]! * sr[j]!;
      z[(idx + 1) * b + i] = v;
    }
  }
  return z;
}

/** The same solve, densely — kept as the reference the fast path is checked against. */
export function solvePeriodicDense(knots: Float64Array, T: Float64Array, dirs?: Float64Array): Float64Array {
  const saved = solveCyclicOverride;
  solveCyclicOverride = true;
  try {
    return solvePeriodic(knots, T, dirs);
  } finally {
    solveCyclicOverride = saved;
  }
}
let solveCyclicOverride = false;

/** Speed along the pinned direction at each knot, from solved derivatives. */
export function knotSpeeds(derivs: Float64Array, dirs: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let ax = 0; ax < 3; ax++) s += derivs[(k * 4 + 1) * 3 + ax]! * dirs[k * 3 + ax]!;
    out[k] = s;
  }
  return out;
}

/**
 * A run: one launch segment from rest at the start to the first knot, then the
 * periodic lap repeated for ever.
 *
 * "For ever" is deliberate: the race ends on a crossing, and whatever the quad
 * does after it does not matter — but the tracker must have a reference to
 * follow until then, however late it is.
 */
export class Trajectory {
  /** Per segment of the lap, coefficients per axis: n x 3 x 8. */
  readonly lap: Float64Array;
  readonly T: Float64Array;
  /** Start time of each lap segment within a lap. */
  readonly cum: Float64Array;
  readonly lapTime: number;
  readonly launch: Float64Array;
  readonly launchTime: number;
  /** Knot derivatives as solved, 4n x 3. */
  readonly knotDerivs: Float64Array;
  readonly n: number;

  constructor(
    knots: Float64Array,
    T: Float64Array,
    start: [number, number, number],
    launchTime: number,
    dirs?: Float64Array,
  ) {
    const n = T.length;
    this.n = n;
    this.T = Float64Array.from(T);
    this.knotDerivs = solvePeriodic(knots, T, dirs);
    this.lap = new Float64Array(n * 3 * 8);
    this.cum = new Float64Array(n);
    let t = 0;
    const d = new Float64Array(8);
    for (let s = 0; s < n; s++) {
      this.cum[s] = t;
      t += T[s]!;
      const M = boundaryInverse(T[s]!);
      const k1 = (s + 1) % n;
      for (let ax = 0; ax < 3; ax++) {
        for (let q = 0; q < 4; q++) {
          d[q] = this.knotDerivs[(s * 4 + q) * 3 + ax]!;
          d[q + 4] = this.knotDerivs[(k1 * 4 + q) * 3 + ax]!;
        }
        coeffs(M, d, this.lap, (s * 3 + ax) * 8);
      }
    }
    this.lapTime = t;

    // Launch: from rest at the start to knot 0 with the lap's own derivatives
    // there. Position and velocity are fixed at the start; acceleration and
    // jerk are left to the snap minimisation. Pinning them at zero as well was
    // the first version, and it made the reference rise as t^4 — so gently
    // that any lift at all put the quad *above* it, the feedback cut the
    // throttle to zero just off the grass, and the learning then taught itself
    // that transient as if it were model error. A pilot punches off the line.
    this.launchTime = launchTime;
    this.launch = new Float64Array(3 * 8);
    const ML = boundaryInverse(launchTime);
    const HL = segmentHessian(launchTime, ML);
    for (let ax = 0; ax < 3; ax++) {
      d.fill(0);
      d[0] = start[ax]!;
      for (let q = 0; q < 4; q++) d[q + 4] = this.knotDerivs[(0 * 4 + q) * 3 + ax]!;
      // Free: d[2], d[3]. Minimise d^T H d over them: H_ff x = -H_fx d_fixed.
      const A = new Float64Array([HL[2 * 8 + 2]!, HL[2 * 8 + 3]!, HL[3 * 8 + 2]!, HL[3 * 8 + 3]!]);
      const b = new Float64Array(2);
      for (let r = 0; r < 2; r++) {
        let sum = 0;
        for (let c = 0; c < 8; c++) if (c !== 2 && c !== 3) sum += HL[(r + 2) * 8 + c]! * d[c]!;
        b[r] = -sum;
      }
      solveDense(A, b, 2, 1);
      d[2] = b[0]!;
      d[3] = b[1]!;
      coeffs(ML, d, this.launch, ax * 8);
    }
  }

  /** Which piece holds global time t, and the local time within it. */
  private locate(t: number): { seg: number; local: number; lap: number } {
    if (t < this.launchTime) return { seg: -1, local: Math.max(0, t), lap: -1 };
    const tt = t - this.launchTime;
    const lap = Math.floor(tt / this.lapTime);
    let within = tt - lap * this.lapTime;
    // Binary search the segment.
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid]! <= within) lo = mid;
      else hi = mid - 1;
    }
    within -= this.cum[lo]!;
    return { seg: lo, local: within, lap };
  }

  /** Evaluate everything at global time t. */
  sample(t: number, out: FlatSample): FlatSample {
    const { seg, local } = this.locate(t);
    const c = seg < 0 ? this.launch : this.lap;
    const base = seg < 0 ? 0 : seg * 24;
    for (let ax = 0; ax < 3; ax++) {
      const off = base + ax * 8;
      out.p[ax] = polyAt(c, off, local, 0);
      out.v[ax] = polyAt(c, off, local, 1);
      out.a[ax] = polyAt(c, off, local, 2);
      out.j[ax] = polyAt(c, off, local, 3);
      out.s[ax] = polyAt(c, off, local, 4);
    }
    return out;
  }

  /**
   * Progress as a number: -1..0 through the launch, then lap * n + segment +
   * fraction. A learned correction is stored against this rather than against
   * time, so it survives a re-plan that changes every segment's duration.
   */
  phase(t: number): number {
    const { seg, local, lap } = this.locate(t);
    if (seg < 0) return -1 + local / this.launchTime;
    return lap * this.n + seg + local / this.T[seg]!;
  }

  /** Inverse of phase(). */
  timeAt(phase: number): number {
    if (phase < 0) return (phase + 1) * this.launchTime;
    const lap = Math.floor(phase / this.n);
    const rem = phase - lap * this.n;
    const seg = Math.min(this.n - 1, Math.floor(rem));
    return this.launchTime + lap * this.lapTime + this.cum[seg]! + (rem - seg) * this.T[seg]!;
  }
}
