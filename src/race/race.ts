/**
 * Race sequencing and timing.
 *
 * Stepped from the 1 kHz tick alongside the physics, because that is where the
 * position is and because a lap time read off a 30 Hz render loop would be
 * quantised to 33 ms — which is a tenth of the gap between a good lap and a bad
 * one.
 *
 * Timing is interpolated, not sampled. At 25 m/s a tick moves 25 mm, so the
 * quad is never exactly on the gate plane when the tick fires; taking the tick
 * time would add up to a millisecond of jitter per gate for no reason when the
 * crossing fraction is already known.
 */

import type { Checkpoint, Course, Flag, Gate } from './course.ts';

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

export interface Split {
  /** Index of the checkpoint reached. */
  index: number;
  /** Seconds since the race clock started. */
  at: number;
  /** Seconds since the previous checkpoint. */
  delta: number;
}

export interface Lap {
  number: number;
  time: number;
  splits: Split[];
  /** True if the pilot reset or respawned during it. */
  invalid: boolean;
}

export interface RaceResult {
  laps: Lap[];
  holeShot: number;
  best: number | null;
  bestThree: number | null;
  total: number;
}

export class Race {
  course: Course;
  laps = 3;
  state: RaceState = 'idle';

  /** Seconds on the race clock. */
  time = 0;
  /** Which checkpoint is next. */
  next = 0;
  lap = 0;
  holeShot: number | null = null;
  completed: Lap[] = [];
  /** Splits accumulated for the lap in progress. */
  private current: Split[] = [];
  private lapStart = 0;
  private lastSplitAt = 0;
  private lapInvalid = false;

  /** Whether the lap in progress has been voided. Read-only, for the UI. */
  get lapWasInvalidated(): boolean {
    return this.lapInvalid;
  }

  /** Countdown remaining, seconds, while state is 'countdown'. */
  countdown = 0;

  // Previous-position state, for crossing detection.
  private prevN = 0;
  private prevE = 0;
  private prevU = 0;
  private havePrev = false;

  constructor(course: Course) {
    this.course = course;
    this.laps = course.defaultLaps;
  }

  get activeCheckpoint(): Checkpoint | null {
    return this.course.checkpoints[this.next] ?? null;
  }

  /** Arm the race. The clock starts after the countdown. */
  start(seconds = 3): void {
    this.reset();
    this.state = 'countdown';
    this.countdown = seconds;
  }

  reset(): void {
    this.state = 'idle';
    this.time = 0;
    this.next = 0;
    this.lap = 0;
    this.holeShot = null;
    this.completed = [];
    this.current = [];
    this.lapStart = 0;
    this.lastSplitAt = 0;
    this.lapInvalid = false;
    this.countdown = 0;
    this.havePrev = false;
  }

  /**
   * The pilot respawned. The lap in progress cannot count — otherwise a reset
   * at a bad moment is a shortcut, and the timing measures nothing.
   */
  invalidateLap(): void {
    if (this.state === 'running') this.lapInvalid = true;
    this.havePrev = false;
  }

  /**
   * One tick. `n, e, u` are the quad's position in NED with `u` as height.
   */
  step(n: number, e: number, u: number, dt: number): void {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'running';
        this.countdown = 0;
        this.time = 0;
        this.lapStart = 0;
        this.lastSplitAt = 0;
      }
      this.prevN = n;
      this.prevE = e;
      this.prevU = u;
      this.havePrev = true;
      return;
    }
    if (this.state !== 'running') return;

    this.time += dt;

    if (!this.havePrev) {
      this.prevN = n;
      this.prevE = e;
      this.prevU = u;
      this.havePrev = true;
      return;
    }

    const cp = this.course.checkpoints[this.next];
    if (cp) {
      const hit = cp.kind === 'gate' ? this.testGate(cp, n, e, u) : this.testFlag(cp, n, e);
      if (hit !== null) this.reach(hit);
    }

    this.prevN = n;
    this.prevE = e;
    this.prevU = u;
  }

  /**
   * Did the segment from the previous position to this one pass through the
   * gate, the right way round?
   *
   * Returns the time of the crossing, or null. The fraction along the segment
   * is what makes the split times worth quoting to a hundredth.
   */
  private testGate(gate: Gate, n: number, e: number, u: number): number | null {
    const before = (this.prevN - gate.north) * gate.dirN + (this.prevE - gate.east) * gate.dirE;
    const after = (n - gate.north) * gate.dirN + (e - gate.east) * gate.dirE;
    // Must go from behind the plane to in front of it: the right way round.
    if (!(before < 0 && after >= 0)) return null;

    const span = after - before;
    const f = span === 0 ? 0 : -before / span;
    const cn = this.prevN + (n - this.prevN) * f;
    const ce = this.prevE + (e - this.prevE) * f;
    const cu = this.prevU + (u - this.prevU) * f;

    // Sideways offset in the gate plane, and height.
    const across = -(cn - gate.north) * gate.dirE + (ce - gate.east) * gate.dirN;
    if (Math.abs(across) > gate.halfWidth) return null;
    if (Math.abs(cu - gate.up) > gate.halfHeight) return null;

    // Time of the crossing rather than the time of the tick that noticed it.
    return this.time - (1 - f) * this.lastDt;
  }

  private lastDt = 0;

  /**
   * Passing a flag: cross the line through the pole, the right way, on the
   * right side, near enough.
   *
   * The same plane crossing a gate uses, with the aperture on one side of the
   * pole instead of both. Replaces a swept-angle rule that was unclear to fly
   * and brittle to satisfy — see the note on Flag in course.ts.
   */
  private testFlag(flag: Flag, n: number, e: number): number | null {
    const before = (this.prevN - flag.north) * flag.dirN + (this.prevE - flag.east) * flag.dirE;
    const after = (n - flag.north) * flag.dirN + (e - flag.east) * flag.dirE;
    if (!(before < 0 && after >= 0)) return null;

    const span = after - before;
    const f = span === 0 ? 0 : -before / span;
    const cn = this.prevN + (n - this.prevN) * f;
    const ce = this.prevE + (e - this.prevE) * f;

    // Positive across is to the right of the direction of travel.
    const across = -(cn - flag.north) * flag.dirE + (ce - flag.east) * flag.dirN;
    if (across * flag.side <= 0) return null;
    if (Math.abs(across) > flag.passWidth) return null;

    return this.time - (1 - f) * this.lastDt;
  }

  private reach(at: number): void {
    const delta = at - this.lastSplitAt;
    this.current.push({ index: this.next, at, delta });
    this.lastSplitAt = at;

    if (this.holeShot === null) this.holeShot = at;

    this.next++;
    if (this.next < this.course.checkpoints.length) return;

    // Lap complete.
    this.next = 0;
    this.lap++;
    this.completed.push({
      number: this.lap,
      time: at - this.lapStart,
      splits: this.current,
      invalid: this.lapInvalid,
    });
    this.current = [];
    this.lapStart = at;
    this.lapInvalid = false;

    if (this.lap >= this.laps) this.state = 'finished';
  }

  /** Called by the owner so crossings can be timed within the tick. */
  setDt(dt: number): void {
    this.lastDt = dt;
  }

  result(): RaceResult {
    const valid = this.completed.filter((l) => !l.invalid);
    const best = valid.length ? Math.min(...valid.map((l) => l.time)) : null;

    // Best three consecutive laps, the figure racers actually quote. Any
    // invalid lap breaks the run rather than being skipped over.
    let bestThree: number | null = null;
    for (let i = 0; i + 2 < this.completed.length; i++) {
      const run = this.completed.slice(i, i + 3);
      if (run.some((l) => l.invalid)) continue;
      const sum = run.reduce((a, l) => a + l.time, 0);
      if (bestThree === null || sum < bestThree) bestThree = sum;
    }

    return {
      laps: this.completed,
      holeShot: this.holeShot ?? 0,
      best,
      bestThree,
      total: this.completed.reduce((a, l) => a + l.time, 0),
    };
  }
}
