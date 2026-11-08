/**
 * The practice session: measure the quad, plan a line, fly it, learn, push.
 *
 * Each round plans at an aggression — the fraction of the measured envelope
 * the line may use — and flies a few practice runs, each learning from the
 * last. When a run finishes cleanly with room to spare in every aperture, the
 * next round plans harder, keeping what was learned. When a round cannot
 * produce a clean run, the session stops and the best clean run stands.
 *
 * "Clean" is judged by the race timer, not by the pilot's opinion of itself:
 * the run must finish according to `Race`, uncrashed.
 */

import type { StickInput } from '../flight/sim.ts';
import type { RateProfile } from '../flight/rates.ts';
import type { Obstacle } from '../flight/collision.ts';
import type { Course } from '../race/course.ts';
import { planeAxes } from '../race/race.ts';
import { type Observation, observation, type PilotEnv } from './env.ts';
import { type Envelope, fitDrag, measureEnvelope } from './envelope.ts';
import { type Plan, Planner } from './planner.ts';
import { Correction } from './ilc.ts';
import { Tracker, type TrackerGains, type TrackerLog, defaultTrackerGains } from './tracker.ts';

export interface RunResult {
  finished: boolean;
  crashed: boolean;
  /** Seconds, from the env's own timer when it has one. */
  laps: number[];
  holeShot: number | null;
  total: number | null;
  /** Smallest distance to an aperture edge at any crossing, m. Negative = missed. */
  margin: number;
  /** Largest distance from the reference, m. */
  peakError: number;
  /** RMS feedback acceleration, m/s^2: how much the plan was wrong. */
  feedbackRms: number;
  /** Checkpoints reached. */
  reached: number;
  log: TrackerLog[];
  /** Sticks at radio rate, for the trace. */
  sticks: { t: number; s: StickInput }[];
}

/** Optional extras an environment may offer. fpvsim's does; others may not. */
export interface RaceTimer {
  result(): { laps: { time: number }[]; holeShot: number | null; total: number | null };
}

function hasTimer(env: PilotEnv): env is PilotEnv & RaceTimer {
  return typeof (env as Partial<RaceTimer>).result === 'function';
}

/**
 * Where a crossing went through each checkpoint, measured from the pilot's
 * own observations — the margin a pilot means by "that was close".
 */
class MarginWatch {
  private cps: Course['checkpoints'];
  private next = 0;
  private prev: [number, number, number] | null = null;
  margin = Infinity;
  reached = 0;

  constructor(course: Course) {
    this.cps = course.checkpoints;
  }

  update(p: readonly number[]): void {
    const n = p[0]!;
    const e = p[1]!;
    const u = -p[2]!;
    if (this.prev) {
      const cp = this.cps[this.next % this.cps.length]!;
      const [pn, pe, pu] = this.prev;
      const dU = cp.kind === 'gate' ? (cp.dirU ?? 0) : 0;
      const cu = cp.kind === 'gate' ? cp.up : 0;
      const before = (pn - cp.north) * cp.dirN + (pe - cp.east) * cp.dirE + (pu - cu) * dU;
      const after = (n - cp.north) * cp.dirN + (e - cp.east) * cp.dirE + (u - cu) * dU;
      if (before < 0 && after >= 0) {
        const f = after === before ? 0 : -before / (after - before);
        const xn = pn + (n - pn) * f - cp.north;
        const xe = pe + (e - pe) * f - cp.east;
        const xu = pu + (u - pu) * f - cu;
        let m: number;
        if (cp.kind === 'gate') {
          const [ax, ay] = planeAxes(cp.dirN, cp.dirE, dU);
          const o1 = xn * ax[0] + xe * ax[1] + xu * ax[2];
          const o2 = xn * ay[0] + xe * ay[1] + xu * ay[2];
          m = Math.min(cp.halfWidth - Math.abs(o1), cp.halfHeight - Math.abs(o2));
        } else {
          const across = (-xn * cp.dirE + xe * cp.dirN) * cp.side;
          m = Math.min(across, cp.passWidth - across);
        }
        // Only a legal crossing advances, as with the timer, and only a legal
        // one says anything about margin. Crossing a pole's line on the other
        // side is how a circle round it is flown, and the plane of a stacked
        // gate is crossed outside it on the way to its neighbour; counting
        // those read as a 0.9 m miss on runs the timer accepted. A real miss
        // shows as a run that does not finish.
        if (m >= 0) {
          this.margin = Math.min(this.margin, m);
          this.next++;
          this.reached++;
        }
      }
    }
    this.prev = [n, e, u];
  }
}

export interface RunOptions {
  /** Radio rate, Hz. */
  actHz?: number | undefined;
  gains?: TrackerGains | undefined;
  /** Give up after this long, s. */
  timeout?: number | undefined;
}

/** Fly one run of a plan from the start line. */
export function flyRun(
  env: PilotEnv,
  plan: Plan,
  course: Course,
  envelope: Envelope,
  rates: RateProfile,
  correction: Correction | null,
  opts: RunOptions = {},
): RunResult {
  const actHz = opts.actHz ?? 200;
  const dt = 1 / actHz;
  env.reset();
  const tracker = new Tracker(plan.traj, plan.startYaw, envelope, rates, correction, opts.gains ?? defaultTrackerGains());
  const obs: Observation = observation();
  const log: TrackerLog[] = [];
  const sticks: { t: number; s: StickInput }[] = [];
  const watch = new MarginWatch(course);
  const timeout = opts.timeout ?? plan.report.time * 1.6 + 5;
  let peak = 0;
  let fb2 = 0;
  while (!env.finished && !env.crashed && env.time < timeout) {
    env.observe(obs);
    const s = tracker.step(obs, log);
    sticks.push({ t: obs.t, s });
    const e = log[log.length - 1]!;
    if (e.err > peak) peak = e.err;
    fb2 += e.fb[0] ** 2 + e.fb[1] ** 2 + e.fb[2] ** 2;
    watch.update(obs.pos);
    env.advance(s, dt);
  }
  let laps: number[] = [];
  let holeShot: number | null = null;
  let total: number | null = null;
  if (hasTimer(env)) {
    const r = env.result();
    laps = r.laps.map((l) => l.time);
    holeShot = r.holeShot;
    total = r.total;
  }
  return {
    finished: env.finished,
    crashed: env.crashed,
    laps,
    holeShot,
    total,
    margin: watch.margin,
    peakError: peak,
    feedbackRms: Math.sqrt(fb2 / Math.max(1, log.length)),
    reached: watch.reached,
    log,
    sticks,
  };
}

export interface SessionOptions {
  laps: number;
  /** Aggression of each round, rising. */
  schedule?: number[];
  /** Practice runs per round. */
  runsPerRound?: number;
  /** Planner iterations for the first round; later rounds warm-start with fewer. */
  planIterations?: number;
  /** Required aperture margin to move on, m. */
  minMargin?: number;
  actHz?: number;
  log?: (s: string) => void;
}

export interface SessionResult {
  envelope: Envelope;
  best: { run: RunResult; plan: Plan; aggression: number } | null;
  history: { aggression: number; run: RunResult }[];
}

export function practise(
  env: PilotEnv,
  course: Course,
  obstacles: readonly Obstacle[],
  rates: RateProfile,
  opts: SessionOptions,
): SessionResult {
  const say = opts.log ?? (() => {});
  const envelope = measureEnvelope(env);
  say(
    `envelope: ${envelope.maxAccel.toFixed(1)} m/s^2 static (TWR ${envelope.twr.toFixed(2)}), ` +
      `losing ${(envelope.inflowLoss * 100).toFixed(1)}% per m/s of inflow`,
  );
  const schedule = opts.schedule ?? [0.5, 0.6, 0.7, 0.8, 0.9];
  const runsPerRound = opts.runsPerRound ?? 4;
  const minMargin = opts.minMargin ?? 0.25;
  const planner = new Planner(course, obstacles, { envelope, rates, aggression: schedule[0]! }, opts.laps);
  let x = planner.initial(10);
  if (planner.vias.length > 0) {
    say(`line: ${planner.segments} segments, ${planner.vias.length} of them free waypoints where it has to loop`);
  }

  // Learn the drag before anything else. The flat model knows thrust and
  // gravity; at racing speed drag is another g, and a line planned without it
  // asks for thrust the quad does not have and leaves the feedback to find out.
  // Two runs: the first is flown blind and may well crash, the second on the
  // first fit, which is close to the truth and therefore flies most of the
  // course and gives a better sample.
  {
    const probe = planner.optimise(x, { iterations: opts.planIterations ?? 200 });
    x = probe.x;
    for (let k = 0; k < 2; k++) {
      const run = flyRun(env, probe, course, envelope, rates, null, { actHz: opts.actHz });
      envelope.drag = fitDrag(run.log, envelope.drag);
      say(
        `drag probe ${k + 1}: ${run.finished ? 'finished' : run.crashed ? 'crashed' : 'did not finish'}, ` +
          `fb ${run.feedbackRms.toFixed(1)} m/s^2 -> drag ${envelope.drag.k1.toFixed(3)} v + ` +
          `${envelope.drag.k2.toFixed(4)} v|v|`,
      );
    }
  }
  const correction = new Correction(planner.segments, opts.laps);
  const history: { aggression: number; run: RunResult }[] = [];
  let best: SessionResult['best'] = null;

  for (let round = 0; round < schedule.length; round++) {
    const aggression = schedule[round]!;
    planner.limits.aggression = aggression;
    const plan = planner.optimise(x, { iterations: round === 0 ? 120 : 80 });
    x = plan.x;
    say(
      `round ${round + 1}, aggression ${(aggression * 100).toFixed(0)}%: planned lap ${plan.report.lapTime.toFixed(2)} s, ` +
        `run ${plan.report.time.toFixed(2)} s`,
    );
    let cleanThisRound = false;
    for (let k = 0; k < runsPerRound; k++) {
      const run = flyRun(env, plan, course, envelope, rates, correction, { actHz: opts.actHz });
      history.push({ aggression, run });
      const clean = run.finished && !run.crashed;
      say(
        `  practice ${k + 1}: ${clean ? 'clean' : run.crashed ? 'CRASHED' : 'did not finish'}` +
          `, laps ${run.laps.map((t) => t.toFixed(2)).join(' / ') || '-'}` +
          `, margin ${Number.isFinite(run.margin) ? run.margin.toFixed(2) : '-'} m` +
          `, peak err ${run.peakError.toFixed(2)} m, fb ${run.feedbackRms.toFixed(2)} m/s^2` +
          `, reached ${run.reached}`,
      );
      if (clean) {
        const bestLap = Math.min(...run.laps);
        const prevBest = best ? Math.min(...best.run.laps) : Infinity;
        if (bestLap < prevBest) best = { run, plan, aggression };
        if (run.margin >= minMargin) cleanThisRound = true;
      }
      // Learn up to where it went wrong, if it did.
      const upTo = run.crashed && run.log.length > 0 ? run.log[run.log.length - 1]!.phase - 0.5 : Infinity;
      correction.learn(run.log, 0.6, 2, upTo);
      if (clean && run.margin >= minMargin && run.feedbackRms < 2.5) break;
    }
    if (!cleanThisRound) {
      say(`  no clean run with ${minMargin} m to spare at ${(aggression * 100).toFixed(0)}% — stopping here`);
      break;
    }
  }
  return { envelope, best, history };
}
