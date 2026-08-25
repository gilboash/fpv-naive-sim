/**
 * The filters a flight controller actually runs. Their lag is not incidental
 * detail — a quad's feel is largely the phase delay of its D-term path, so a
 * model without them flies better than any real quad and teaches the wrong
 * reflexes.
 */

/** First-order lowpass, the PT1 of Betaflight. */
export class PT1 {
  private y = 0;
  private k = 1;

  constructor(cutoffHz: number, dt: number) {
    this.setCutoff(cutoffHz, dt);
  }

  setCutoff(cutoffHz: number, dt: number): void {
    if (cutoffHz <= 0) {
      this.k = 1; // pass-through
      return;
    }
    const rc = 1 / (2 * Math.PI * cutoffHz);
    this.k = dt / (rc + dt);
  }

  reset(v = 0): void {
    this.y = v;
  }

  apply(x: number): number {
    this.y += this.k * (x - this.y);
    return this.y;
  }

  get value(): number {
    return this.y;
  }
}

/** Second-order Butterworth lowpass, direct form 1. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(cutoffHz: number, dt: number, q = Math.SQRT1_2) {
    this.setCutoff(cutoffHz, dt, q);
  }

  setCutoff(cutoffHz: number, dt: number, q = Math.SQRT1_2): void {
    const nyquist = 0.5 / dt;
    if (cutoffHz <= 0 || cutoffHz >= nyquist) {
      this.b0 = 1;
      this.b1 = this.b2 = this.a1 = this.a2 = 0;
      return;
    }
    const omega = (2 * Math.PI * cutoffHz) / (1 / dt);
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cs) / 2) / a0;
    this.b1 = (1 - cs) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  reset(v = 0): void {
    this.x1 = this.x2 = v;
    this.y1 = this.y2 = v;
  }

  apply(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Slew limiter, used on the throttle path into the battery model. Not a
 * flight-controller filter; it keeps the electrical model from being asked for
 * a step it could never physically deliver.
 */
export function slew(current: number, target: number, maxPerStep: number): number {
  const d = target - current;
  if (d > maxPerStep) return current + maxPerStep;
  if (d < -maxPerStep) return current - maxPerStep;
  return target;
}
