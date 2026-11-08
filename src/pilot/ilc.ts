/**
 * Practice: what the feedback did on the last lap goes into the plan for the
 * next.
 *
 * Iterative learning control in its feedback-error form: if the feedback had
 * to add 3 m/s^2 of push at some point on the course every time, the model is
 * 3 m/s^2 wrong there, so add it up front next time and let the feedback rest.
 * It needs no model of *why* — drag, thrust lost to inflow, the rate loop's
 * lag, a battery sagging — which is the property that has to survive the move
 * to a simulator whose physics nobody here has seen.
 *
 *   u_{k+1} = Q( u_k + L * fb_k )
 *
 * Stored against progress along the line (phase), not against time. A re-plan
 * changes every segment's duration, and a correction indexed by time would
 * then be applied at the wrong corner.
 *
 * Q is a zero-phase low-pass — forward and backward over the bins — because a
 * correction that lags by a filter delay is a correction applied late, and
 * learning a late correction lap after lap is how ILC goes unstable.
 */

import type { TrackerLog } from './tracker.ts';

export class Correction {
  /** Bins per segment of the line. */
  readonly perSegment: number;
  /** Phase of bin 0. */
  readonly origin: number;
  readonly bins: number;
  /** NED acceleration correction, 3 per bin. */
  readonly a: Float64Array;

  constructor(segments: number, laps: number, perSegment = 12) {
    this.perSegment = perSegment;
    // The launch is phase -1..0; one extra lap covers the run-out after the
    // last crossing, which the tracker keeps flying until the race says stop.
    this.origin = -1;
    this.bins = Math.ceil((segments * (laps + 1) + 1) * perSegment) + 1;
    this.a = new Float64Array(this.bins * 3);
  }

  private out: [number, number, number] = [0, 0, 0];

  /** Linearly interpolated correction at a phase. */
  at(phase: number): [number, number, number] {
    const f = (phase - this.origin) * this.perSegment;
    const i = Math.max(0, Math.min(this.bins - 2, Math.floor(f)));
    const w = Math.max(0, Math.min(1, f - i));
    for (let k = 0; k < 3; k++) {
      this.out[k] = this.a[i * 3 + k]! * (1 - w) + this.a[(i + 1) * 3 + k]! * w;
    }
    return this.out;
  }

  /**
   * Learn from one run's log.
   *
   * @param gain     L: how much of the feedback to believe, 0..1.
   * @param smooth   Q's time constant, in bins.
   * @param upTo     Only learn up to this phase — beyond a crash, the feedback
   *                 is fighting a wreck and teaches nothing.
   */
  learn(log: readonly TrackerLog[], gain = 0.6, smooth = 2, upTo = Infinity): void {
    const sum = new Float64Array(this.bins * 3);
    const cnt = new Float64Array(this.bins);
    for (const e of log) {
      if (e.phase > upTo) break;
      // On the ground the feedback is arguing with the grass.
      if (e.up < 0.3) continue;
      const f = (e.phase - this.origin) * this.perSegment;
      const i = Math.round(f);
      if (i < 0 || i >= this.bins) continue;
      sum[i * 3] = sum[i * 3]! + e.fb[0];
      sum[i * 3 + 1] = sum[i * 3 + 1]! + e.fb[1];
      sum[i * 3 + 2] = sum[i * 3 + 2]! + e.fb[2];
      cnt[i] = cnt[i]! + 1;
    }
    const next = Float64Array.from(this.a);
    for (let i = 0; i < this.bins; i++) {
      if (cnt[i]! === 0) continue;
      for (let k = 0; k < 3; k++) next[i * 3 + k] = next[i * 3 + k]! + (gain * sum[i * 3 + k]!) / cnt[i]!;
    }
    // Zero-phase smoothing: a first-order filter run forwards then backwards.
    const alpha = 1 / (1 + smooth);
    for (let k = 0; k < 3; k++) {
      let y = next[k]!;
      for (let i = 0; i < this.bins; i++) {
        y += alpha * (next[i * 3 + k]! - y);
        next[i * 3 + k] = y;
      }
      y = next[(this.bins - 1) * 3 + k]!;
      for (let i = this.bins - 1; i >= 0; i--) {
        y += alpha * (next[i * 3 + k]! - y);
        next[i * 3 + k] = y;
      }
    }
    // A correction larger than the airframe's own acceleration is not a
    // correction, it is a runaway.
    for (let i = 0; i < next.length; i++) next[i] = Math.max(-25, Math.min(25, next[i]!));
    this.a.set(next);
  }

  /** Mean magnitude, for the report. */
  rms(): number {
    let s = 0;
    for (let i = 0; i < this.a.length; i++) s += this.a[i]! * this.a[i]!;
    return Math.sqrt(s / this.bins);
  }
}
