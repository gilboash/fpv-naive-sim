/**
 * Flight replays: record the sticks, re-fly them later.
 *
 * Nothing about the picture is recorded. A flight is the stick commands the
 * model was fed, tick by tick, plus a snapshot of the model (and the race)
 * whenever something other than the sticks changed it: arming, disarming, a
 * reset or respawn, a race starting, a new tune. Re-flying puts the snapshots
 * back at the same tick and feeds the same commands, and because the model has
 * a fixed step and no randomness the result is the same flight to the last bit
 * (tools/flight-check.ts checks this, and a tape carries its own end state so
 * the page can check it too).
 *
 * The recorder sits on the 1 kHz tick, so it is cheap there: two integer
 * compares and, when the sticks moved, five numbers into a typed array. The
 * radio reports at ~200 Hz, so most ticks store nothing.
 *
 * What a flight is (agreed with Gilboa, 2026-11-17):
 *   starts  when the quad is armed or a race is started, whichever is first;
 *   ends    after 3 s disarmed outside a race, 9 s after a race finishes,
 *           when the map changes, on Stop, or at 10 minutes (a flight still
 *           going then carries on as the next one, with no gap);
 *   dropped when it was armed for under a second.
 *
 * Pure TypeScript, no DOM, so it runs under plain Node like src/flight.
 */

import { FlightSim, type StickInput } from '../flight/sim.ts';
import type { Obstacle } from '../flight/collision.ts';
import { Race, type RaceResult } from '../race/race.ts';
import type { Course } from '../race/course.ts';
import { firstDifference, restore, snapshot, type Snapshot } from './state.ts';

/** A snapshot of the model and the race, put back at `tick` before (0) or after (1) its step. */
export interface TapeEvent {
  tick: number;
  phase: 0 | 1;
  sim: Snapshot;
  race: Snapshot;
}

/** How the flight was seen, so the video looks as it did. */
export interface TapeView {
  fovDeg: number;
  tiltDeg: number;
  shutterMs: number;
  stickMode: 1 | 2 | 3 | 4;
}

export interface FlightTape {
  id: number;
  /** Wall clock at the start, ms since the epoch. For the list only. */
  startedAt: number;
  trackName: string;
  /** The map itself, opaque here; the page renders it. */
  track: unknown;
  /** The obstacles the flight was flown against (identity marks a map change). */
  obstacles: readonly Obstacle[];
  course: Course;
  view: TapeView;
  /** Physics steps in the flight. */
  ticks: number;
  dt: number;
  /** Stick changes: [tick, throttle, roll, pitch, yaw] per record. */
  cmd: Float64Array;
  cmdCount: number;
  events: TapeEvent[];
  /** State at the end of the last tick, for the determinism check; null if the end was not clean. */
  end: { sim: Snapshot; race: Snapshot } | null;
  armedTicks: number;
  crashes: number;
  /** The race result, if a race finished during the flight. */
  race: RaceResult | null;
  endReason: 'disarmed' | 'race finished' | 'map changed' | 'stopped' | 'time cap' | 'recording off';
}

/** What the page tells the recorder about the moment a flight starts. */
export interface TapeContext {
  trackName: string;
  track: unknown;
  view: TapeView;
}

export const IDLE_END_TICKS = 3000;
export const FINISH_HOLD_TICKS = 9000;
export const MAX_TICKS = 600_000;
export const MIN_ARMED_TICKS = 1000;

const raceActive = (r: Race): boolean => r.state === 'countdown' || r.state === 'running';

export class TapeRecorder {
  enabled = true;
  /** Set by the page: what to record about the scene when a flight starts. */
  context: (() => TapeContext) | null = null;
  /** A finished flight worth keeping. */
  onFinished: ((tape: FlightTape) => void) | null = null;

  private tape: FlightTape | null = null;
  private simEpoch = -1;
  private raceEpoch = -1;
  private idleTicks = 0;
  private finishedAt = -1;
  private wasCrashed = false;
  private stopAsked = false;
  /** After Stop, wait for a disarm before recording again. */
  private holdUntilIdle = false;
  private nextId = 1;

  get recording(): boolean {
    return this.tape !== null;
  }

  /** Seconds recorded so far in the flight in progress. */
  get seconds(): number {
    return this.tape ? this.tape.ticks * this.tape.dt : 0;
  }

  /** End the flight in progress at the end of this tick. */
  stop(): void {
    if (this.tape) this.stopAsked = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.tape) this.finish('recording off', null);
  }

  /** Immediately before sim.step, with the exact input it is about to be fed. */
  beforeStep(sim: FlightSim, race: Race, input: StickInput): void {
    let t = this.tape;
    if (t && sim.obstacles !== t.obstacles) {
      this.finish('map changed', null);
      t = null;
    }
    if (!t) {
      if (this.holdUntilIdle && !sim.armed && !raceActive(race)) this.holdUntilIdle = false;
      if (!this.enabled || this.holdUntilIdle || !(sim.armed || raceActive(race))) return;
      t = this.begin(sim, race);
    } else {
      this.sync(t, sim, race, 0);
    }
    const n = t.cmdCount;
    const c = t.cmd;
    const o = (n - 1) * 5;
    if (
      n === 0 ||
      c[o + 1] !== input.throttle ||
      c[o + 2] !== input.roll ||
      c[o + 3] !== input.pitch ||
      c[o + 4] !== input.yaw
    ) {
      if ((n + 1) * 5 > c.length) {
        const grown = new Float64Array(c.length * 2);
        grown.set(c);
        t.cmd = grown;
      }
      const d = t.cmd;
      const p = n * 5;
      d[p] = t.ticks;
      d[p + 1] = input.throttle;
      d[p + 2] = input.roll;
      d[p + 3] = input.pitch;
      d[p + 4] = input.yaw;
      t.cmdCount = n + 1;
    }
  }

  /** After sim.step and anything that reacts to it (crash recovery), before the race steps. */
  afterStep(sim: FlightSim, race: Race): void {
    if (this.tape) this.sync(this.tape, sim, race, 1);
  }

  /** At the end of the tick, after the race has stepped. */
  endTick(sim: FlightSim, race: Race): void {
    const t = this.tape;
    if (!t) return;
    t.ticks++;
    if (sim.armed) t.armedTicks++;
    if (sim.crashed && !this.wasCrashed) t.crashes++;
    this.wasCrashed = sim.crashed;

    if (race.state === 'finished' && this.finishedAt < 0 && race.completed.length > 0) {
      this.finishedAt = t.ticks;
      t.race = race.result();
    }
    this.idleTicks = !sim.armed && !raceActive(race) ? this.idleTicks + 1 : 0;

    const end = (): { sim: Snapshot; race: Snapshot } => ({ sim: snapshot(sim), race: snapshot(race) });
    if (this.stopAsked) {
      this.holdUntilIdle = true;
      this.finish('stopped', end());
    } else if (this.finishedAt >= 0 && t.ticks - this.finishedAt >= FINISH_HOLD_TICKS) {
      this.finish('race finished', end());
    } else if (this.idleTicks >= IDLE_END_TICKS) {
      this.finish('disarmed', end());
    } else if (t.ticks >= MAX_TICKS) {
      this.finish('time cap', end());
    }
  }

  private begin(sim: FlightSim, race: Race): FlightTape {
    const ctx = this.context?.() ?? {
      trackName: '',
      track: null,
      view: { fovDeg: 75, tiltDeg: 25, shutterMs: 0, stickMode: 2 as const },
    };
    const t: FlightTape = {
      id: this.nextId++,
      startedAt: Date.now(),
      trackName: ctx.trackName,
      track: ctx.track,
      obstacles: sim.obstacles,
      course: race.course,
      view: { ...ctx.view },
      ticks: 0,
      dt: sim.dt,
      cmd: new Float64Array(5 * 4096),
      cmdCount: 0,
      events: [{ tick: 0, phase: 0, sim: snapshot(sim), race: snapshot(race) }],
      end: null,
      armedTicks: 0,
      crashes: 0,
      race: null,
      endReason: 'disarmed',
    };
    this.tape = t;
    this.simEpoch = sim.epoch;
    this.raceEpoch = race.epoch;
    this.idleTicks = 0;
    this.finishedAt = -1;
    this.wasCrashed = sim.crashed;
    this.stopAsked = false;
    return t;
  }

  private sync(t: FlightTape, sim: FlightSim, race: Race, phase: 0 | 1): void {
    if (sim.epoch === this.simEpoch && race.epoch === this.raceEpoch) return;
    this.simEpoch = sim.epoch;
    this.raceEpoch = race.epoch;
    t.events.push({ tick: t.ticks, phase, sim: snapshot(sim), race: snapshot(race) });
  }

  private finish(reason: FlightTape['endReason'], end: FlightTape['end']): void {
    const t = this.tape;
    if (!t) return;
    this.tape = null;
    this.stopAsked = false;
    t.endReason = reason;
    t.end = end;
    t.cmd = t.cmd.slice(0, t.cmdCount * 5);
    if (t.armedTicks >= MIN_ARMED_TICKS) this.onFinished?.(t);
  }
}

/** A keyframe while re-flying, for seeking back without starting over. */
interface Keyframe {
  tick: number;
  sim: Snapshot;
  race: Snapshot;
  ci: number;
  ei: number;
  input: StickInput;
  finishedTick: number;
}

const KEYFRAME_TICKS = 2000;

/**
 * Re-fly a tape on a fresh model. `obstacles` must be the same map built again
 * (the page builds it with the renderer that will draw it).
 */
export class ReplayRun {
  readonly tape: FlightTape;
  readonly sim: FlightSim;
  readonly race: Race;
  /** Steps done. The state is the flight's after this many ticks. */
  tick = 0;
  /** The tick the race finished on, or -1. For the result card on the video. */
  finishedTick = -1;
  /** The input the model is being fed. */
  readonly input: StickInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  /**
   * Called in the tick at the points the live page reads its sound cues
   * (src/sound-cues.ts): after the physics step and after the race. For the
   * video's sound track; only meaningful on a run that never seeks back.
   */
  cues: { afterSim(sim: FlightSim): void; afterRace(race: Race): void } | null = null;
  private ci = 0;
  private ei = 0;
  private keyframes: Keyframe[] = [];

  constructor(tape: FlightTape, obstacles: readonly Obstacle[]) {
    this.tape = tape;
    this.sim = new FlightSim({ dt: tape.dt });
    this.sim.obstacles = obstacles;
    this.race = new Race(tape.course);
    this.apply(0, 0);
    this.keep();
  }

  get done(): boolean {
    return this.tick >= this.tape.ticks;
  }

  get seconds(): number {
    return this.tick * this.tape.dt;
  }

  /** One tick, exactly as the page ran it. */
  step(): void {
    const k = this.tick;
    this.apply(k, 0);
    const c = this.tape.cmd;
    while (this.ci < this.tape.cmdCount && c[this.ci * 5]! <= k) {
      const p = this.ci * 5;
      this.input.throttle = c[p + 1]!;
      this.input.roll = c[p + 2]!;
      this.input.pitch = c[p + 3]!;
      this.input.yaw = c[p + 4]!;
      this.ci++;
    }
    this.sim.step(this.input);
    this.cues?.afterSim(this.sim);
    this.apply(k, 1);
    const wasFinished = this.race.state === 'finished';
    this.race.setDt(this.sim.dt);
    this.race.step(this.sim.pos.x, this.sim.pos.y, -this.sim.pos.z, this.sim.dt);
    this.cues?.afterRace(this.race);
    this.tick = k + 1;
    if (!wasFinished && this.race.state === 'finished' && this.finishedTick < 0) this.finishedTick = this.tick;
    if (this.tick % KEYFRAME_TICKS === 0 && this.keyframes.length === this.tick / KEYFRAME_TICKS) this.keep();
  }

  /** Re-fly up to tick `n` (never past the end). */
  runTo(n: number): void {
    const target = Math.min(n, this.tape.ticks);
    if (target < this.tick) this.rewind(target);
    while (this.tick < target) this.step();
  }

  /** Go back to the last keyframe at or before `n`. */
  private rewind(n: number): void {
    const i = Math.min(Math.floor(n / KEYFRAME_TICKS), this.keyframes.length - 1);
    const kf = this.keyframes[i]!;
    restore(this.sim, kf.sim);
    restore(this.race, kf.race);
    this.tick = kf.tick;
    this.ci = kf.ci;
    this.ei = kf.ei;
    Object.assign(this.input, kf.input);
    this.finishedTick = kf.finishedTick;
  }

  private keep(): void {
    this.keyframes.push({
      tick: this.tick,
      sim: snapshot(this.sim),
      race: snapshot(this.race),
      ci: this.ci,
      ei: this.ei,
      input: { ...this.input },
      finishedTick: this.finishedTick,
    });
  }

  private apply(tick: number, phase: 0 | 1): void {
    const ev = this.tape.events;
    while (this.ei < ev.length) {
      const e = ev[this.ei]!;
      if (e.tick > tick || (e.tick === tick && e.phase > phase)) break;
      restore(this.sim, e.sim);
      restore(this.race, e.race);
      this.ei++;
    }
  }

  /**
   * After re-flying to the end: where the replay differs from the live flight,
   * or null when it is identical. Undefined when the tape has no clean end.
   */
  verify(): string | null | undefined {
    if (!this.tape.end) return undefined;
    return (
      firstDifference(snapshot(this.sim), this.tape.end.sim, 'sim') ??
      firstDifference(snapshot(this.race), this.tape.end.race, 'race')
    );
  }
}
