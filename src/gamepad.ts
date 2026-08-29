/**
 * Gamepad reading. Deliberately dumb and allocation-light: this runs inside
 * the (future) physics loop, so it does no DOM work and never awaits.
 *
 * navigator.getGamepads() returns a fresh snapshot array on every call — that
 * allocation is the platform's, not ours, and is the reason the rest of this
 * file reuses typed arrays.
 */

export const MAX_AXES = 16;
export const MAX_BUTTONS = 32;

export interface DeviceInfo {
  index: number;
  id: string;
  mapping: string;
  axisCount: number;
  buttonCount: number;
}

export class GamepadPoller {
  /** Index into navigator.getGamepads(), or -1 for "none selected". */
  index = -1;
  id = '';
  connected = false;

  readonly axes = new Float64Array(MAX_AXES);
  readonly buttons = new Float64Array(MAX_BUTTONS);
  axisCount = 0;
  buttonCount = 0;

  /** Total poll() calls. */
  polls = 0;
  /** Polls where Gamepad.timestamp advanced, i.e. genuinely new device data. */
  freshSamples = 0;
  /** Polls that found no device. */
  missedPolls = 0;

  private lastGpTimestamp = -1;

  /** Called only when the device reported new data. (tNow, gamepadTimestamp) */
  onFresh: ((tNow: number, gpTimestamp: number) => void) | null = null;
  /** Called on every poll that found a device, fresh or not. */
  onSample: ((tNow: number) => void) | null = null;

  static list(): DeviceInfo[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: DeviceInfo[] = [];
    for (const p of pads) {
      if (!p) continue;
      out.push({
        index: p.index,
        id: p.id,
        mapping: p.mapping || 'none',
        axisCount: p.axes.length,
        buttonCount: p.buttons.length,
      });
    }
    return out;
  }

  select(index: number): void {
    this.index = index;
    this.lastGpTimestamp = -1;
    this.axes.fill(0);
    this.buttons.fill(0);
  }

  resetCounters(): void {
    this.polls = 0;
    this.freshSamples = 0;
    this.missedPolls = 0;
  }

  /**
   * False when the browser will not expose gamepads at all, as opposed to there
   * being none plugged in. Chrome restricts the Gamepad API to secure contexts,
   * so a page served over plain http:// to anything but localhost has no radio
   * support whatever — advice a pilot needs, and completely different from
   * "nothing is connected".
   */
  static get apiAvailable(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  }

  /** Hot path. Call from the ticker, not from rAF. */
  poll(tNow: number): boolean {
    this.polls++;
    // Guarded like list() is. Unguarded this threw a thousand times a second on
    // an insecure origin, which is exactly where a shared page ends up.
    if (!navigator.getGamepads) {
      this.connected = false;
      this.missedPolls++;
      return false;
    }
    const pads = navigator.getGamepads();
    const gp = this.index >= 0 ? pads[this.index] : null;
    if (!gp) {
      this.connected = false;
      this.missedPolls++;
      return false;
    }

    this.connected = true;
    this.id = gp.id;

    const na = Math.min(gp.axes.length, MAX_AXES);
    this.axisCount = na;
    for (let i = 0; i < na; i++) this.axes[i] = gp.axes[i] ?? 0;

    const nb = Math.min(gp.buttons.length, MAX_BUTTONS);
    this.buttonCount = nb;
    for (let i = 0; i < nb; i++) this.buttons[i] = gp.buttons[i]?.value ?? 0;

    const ts = gp.timestamp;
    if (ts !== this.lastGpTimestamp) {
      if (this.lastGpTimestamp >= 0) {
        this.freshSamples++;
        this.onFresh?.(tNow, ts);
      }
      this.lastGpTimestamp = ts;
    }
    this.onSample?.(tNow);
    return true;
  }
}

// ------------------------------------------------------------ axis detection

export interface DetectResult {
  axis: number;
  /** Sign of the movement away from baseline. */
  direction: 1 | -1;
  travel: number;
}

/**
 * Watches every axis for the largest excursion from its baseline over a
 * window, so the pilot can assign a channel by moving the stick.
 */
export class AxisDetector {
  private baseline = new Float64Array(MAX_AXES);
  private peak = new Float64Array(MAX_AXES);
  private started = 0;
  active = false;

  constructor(
    private readonly poller: GamepadPoller,
    private readonly durationMs = 1600,
    private readonly threshold = 0.35,
  ) {}

  start(tNow: number): void {
    this.baseline.set(this.poller.axes);
    this.peak.fill(0);
    this.started = tNow;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  /** Returns a result once the window closes, otherwise null. */
  update(tNow: number): DetectResult | null {
    if (!this.active) return null;
    const axes = this.poller.axes;
    for (let i = 0; i < this.poller.axisCount; i++) {
      const d = (axes[i] ?? 0) - (this.baseline[i] ?? 0);
      if (Math.abs(d) > Math.abs(this.peak[i] ?? 0)) this.peak[i] = d;
    }

    if (tNow - this.started < this.durationMs) return null;
    this.active = false;

    let best = -1;
    let bestAbs = 0;
    for (let i = 0; i < this.poller.axisCount; i++) {
      const a = Math.abs(this.peak[i] ?? 0);
      if (a > bestAbs) {
        bestAbs = a;
        best = i;
      }
    }
    if (best < 0 || bestAbs < this.threshold) return null;
    return { axis: best, direction: (this.peak[best] ?? 0) >= 0 ? 1 : -1, travel: bestAbs };
  }

  get progress(): number {
    return this.active ? 0 : 1;
  }

  elapsed(tNow: number): number {
    return this.active ? tNow - this.started : this.durationMs;
  }

  get windowMs(): number {
    return this.durationMs;
  }
}

// ------------------------------------------------------------- endpoint calib

/** Tracks per-axis min/max while the pilot sweeps every stick to its stops. */
export class EndpointCalibrator {
  readonly min = new Float64Array(MAX_AXES);
  readonly max = new Float64Array(MAX_AXES);
  active = false;

  constructor(private readonly poller: GamepadPoller) {}

  start(): void {
    this.min.fill(Number.POSITIVE_INFINITY);
    this.max.fill(Number.NEGATIVE_INFINITY);
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  update(): void {
    if (!this.active) return;
    const axes = this.poller.axes;
    for (let i = 0; i < this.poller.axisCount; i++) {
      const v = axes[i] ?? 0;
      if (v < (this.min[i] ?? Infinity)) this.min[i] = v;
      if (v > (this.max[i] ?? -Infinity)) this.max[i] = v;
    }
  }

  /** True when the axis saw enough travel to be worth trusting. */
  hasTravel(axis: number, minSpan = 0.5): boolean {
    const lo = this.min[axis];
    const hi = this.max[axis];
    if (lo === undefined || hi === undefined) return false;
    return Number.isFinite(lo) && Number.isFinite(hi) && hi - lo >= minSpan;
  }
}
