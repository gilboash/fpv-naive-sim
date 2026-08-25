/**
 * Measurement, not decoration. The point of M0 is a number we can publish and
 * re-test later, so this records raw intervals and reports percentiles rather
 * than a smoothed average that would hide the stalls that matter.
 */

export interface Stats {
  count: number;
  meanMs: number;
  sdMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  /** Implied rate from the mean interval. */
  hz: number;
}

export class Series {
  private buf: Float64Array;
  private n = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    if (this.n < this.buf.length) this.buf[this.n++] = v;
  }

  reset(): void {
    this.n = 0;
  }

  get length(): number {
    return this.n;
  }

  /** Copy, because sorting in place would destroy the recording order. */
  values(): Float64Array {
    return this.buf.slice(0, this.n);
  }

  countAbove(threshold: number): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if ((this.buf[i] ?? 0) > threshold) c++;
    return c;
  }

  stats(): Stats {
    const empty: Stats = { count: 0, meanMs: 0, sdMs: 0, minMs: 0, maxMs: 0, p50: 0, p90: 0, p99: 0, p999: 0, hz: 0 };
    if (this.n === 0) return empty;

    const v = this.values();
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < v.length; i++) {
      const x = v[i] ?? 0;
      sum += x;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const mean = sum / v.length;

    let sq = 0;
    for (let i = 0; i < v.length; i++) {
      const d = (v[i] ?? 0) - mean;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / v.length);

    const sorted = v.slice().sort();
    const pct = (p: number): number => {
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
      return sorted[idx] ?? 0;
    };

    return {
      count: v.length,
      meanMs: mean,
      sdMs: sd,
      minMs: min,
      maxMs: max,
      p50: pct(50),
      p90: pct(90),
      p99: pct(99),
      p999: pct(99.9),
      hz: mean > 0 ? 1000 / mean : 0,
    };
  }

  /** Log-ish histogram over fixed edges, for eyeballing the tail. */
  histogram(edges: number[]): { label: string; count: number }[] {
    const out: { label: string; count: number }[] = [];
    const v = this.values();
    let prev = 0;
    for (const e of edges) {
      let c = 0;
      for (let i = 0; i < v.length; i++) {
        const x = v[i] ?? 0;
        if (x >= prev && x < e) c++;
      }
      out.push({ label: `${prev.toFixed(prev < 1 ? 1 : 0)}–${e.toFixed(e < 1 ? 1 : 0)} ms`, count: c });
      prev = e;
    }
    let c = 0;
    for (let i = 0; i < v.length; i++) if ((v[i] ?? 0) >= prev) c++;
    out.push({ label: `≥${prev} ms`, count: c });
    return out;
  }
}

export const HIST_EDGES = [0.5, 0.9, 1.1, 1.5, 2, 4, 8, 16, 33];

export interface RunResult {
  startedAt: string;
  durationS: number;
  targetHz: number;
  tickerBackend: string;
  crossOriginIsolated: boolean;
  userAgent: string;
  device: string;
  deviceAxes: number;
  polls: number;
  freshSamples: number;
  missedPolls: number;
  /** Interval between successive ticker callbacks on the main thread. */
  tickInterval: Stats;
  /** How late each tick fired relative to its scheduled time. */
  tickLateness: Stats;
  /** Interval between Gamepad.timestamp changes = the device's real report rate. */
  deviceReport: Stats;
  /** requestAnimationFrame interval, for reference only. */
  frameInterval: Stats;
  stalls: { over2ms: number; over8ms: number; over33ms: number };
  histogram: { label: string; count: number }[];
}

export class JitterRun {
  readonly tickInterval: Series;
  readonly tickLateness: Series;
  readonly deviceReport: Series;
  readonly frameInterval: Series;

  running = false;
  startedAtMs = 0;
  startedAtISO = '';

  private lastTick = -1;
  private lastFresh = -1;
  private lastFrame = -1;

  constructor(
    readonly durationS: number,
    readonly targetHz: number,
  ) {
    const cap = Math.ceil(durationS * targetHz * 1.2);
    this.tickInterval = new Series(cap);
    this.tickLateness = new Series(cap);
    this.deviceReport = new Series(cap);
    this.frameInterval = new Series(Math.ceil(durationS * 400));
  }

  start(tNow: number): void {
    this.tickInterval.reset();
    this.tickLateness.reset();
    this.deviceReport.reset();
    this.frameInterval.reset();
    this.lastTick = -1;
    this.lastFresh = -1;
    this.lastFrame = -1;
    this.startedAtMs = tNow;
    this.startedAtISO = new Date().toISOString();
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  elapsedS(tNow: number): number {
    return this.running ? (tNow - this.startedAtMs) / 1000 : this.durationS;
  }

  recordTick(fired: number, scheduled: number): void {
    if (!this.running) return;
    if (this.lastTick >= 0) this.tickInterval.push(fired - this.lastTick);
    this.lastTick = fired;
    this.tickLateness.push(Math.max(0, fired - scheduled));
  }

  recordFresh(tNow: number): void {
    if (!this.running) return;
    if (this.lastFresh >= 0) this.deviceReport.push(tNow - this.lastFresh);
    this.lastFresh = tNow;
  }

  recordFrame(tNow: number): void {
    if (!this.running) return;
    if (this.lastFrame >= 0) this.frameInterval.push(tNow - this.lastFrame);
    this.lastFrame = tNow;
  }

  result(meta: {
    backend: string;
    device: string;
    deviceAxes: number;
    polls: number;
    freshSamples: number;
    missedPolls: number;
  }): RunResult {
    return {
      startedAt: this.startedAtISO,
      durationS: this.durationS,
      targetHz: this.targetHz,
      tickerBackend: meta.backend,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      userAgent: navigator.userAgent,
      device: meta.device,
      deviceAxes: meta.deviceAxes,
      polls: meta.polls,
      freshSamples: meta.freshSamples,
      missedPolls: meta.missedPolls,
      tickInterval: this.tickInterval.stats(),
      tickLateness: this.tickLateness.stats(),
      deviceReport: this.deviceReport.stats(),
      frameInterval: this.frameInterval.stats(),
      stalls: {
        over2ms: this.tickInterval.countAbove(2),
        over8ms: this.tickInterval.countAbove(8),
        over33ms: this.tickInterval.countAbove(33),
      },
      histogram: this.tickInterval.histogram(HIST_EDGES),
    };
  }
}
