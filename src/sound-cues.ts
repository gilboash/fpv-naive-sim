/**
 * When the sim makes a sound: a crash, a strike on scenery (the gong), a
 * checkpoint, a lap. Read off the model and the race in the 1 kHz tick and
 * handed to a sink, which only queues; nothing here touches audio.
 *
 * One class for both places that need the rules: the live page (main.ts) and
 * the replay video (src/replay/sound.ts), so a video sounds a crash, a gong or
 * a chime exactly where the live flight did.
 *
 * Pure TypeScript, no DOM, like src/flight.
 */

import type { FlightSim } from './flight/sim.ts';
import type { Race } from './race/race.ts';

/** Below this a scrape is not a strike, m/s. */
export const STRIKE_MIN_SPEED = 1.5;
/**
 * And one strike at a time, seconds.
 *
 * Longer than it looks like it needs to be, for two reasons: contact against a
 * post persists for well over a second — measured at 1 368 ticks for a single
 * gate strike, which without a cooldown is 1 368 gongs — and the sample rings
 * for 4.7 s, so two of them half a second apart is mud rather than emphasis.
 */
export const STRIKE_COOLDOWN_S = 1.5;

export interface CueSink {
  noteCrash(speed: number): void;
  noteStrike(speed: number): void;
  noteCheckpoint(kind: 'gate' | 'flag' | 'lap'): void;
}

export class SoundCues {
  private sink: CueSink;
  private wasCrashed: boolean | null = null;
  private strikeCooldown = 0;
  private lastCrossings = -1;
  private lastLaps = -1;

  constructor(sink: CueSink) {
    this.sink = sink;
  }

  /** Right after the physics step, before anything respawns the quad. */
  afterSim(sim: FlightSim): void {
    if (this.wasCrashed === null) this.wasCrashed = sim.crashed;
    if (sim.crashed !== this.wasCrashed) {
      if (sim.crashed) this.sink.noteCrash(sim.crashSpeed);
      this.wasCrashed = sim.crashed;
    }
    // Contact persists for many ticks while the quad slides down a post, and
    // every one of them reports an impact: the cooldown keeps it one strike.
    if (this.strikeCooldown > 0) this.strikeCooldown -= sim.dt;
    if (sim.obstacleImpact > STRIKE_MIN_SPEED && this.strikeCooldown <= 0) {
      this.sink.noteStrike(sim.obstacleImpact);
      this.strikeCooldown = STRIKE_COOLDOWN_S;
    }
  }

  /**
   * After the race has stepped. The race's counters never reset, so noticing a
   * crossing is a comparison. A completed lap wins over the gate that completed
   * it: they land on the same crossing, and two sounds at once is noise.
   */
  afterRace(race: Race): void {
    if (this.lastCrossings < 0) {
      this.lastCrossings = race.crossings;
      this.lastLaps = race.lapsCompleted;
      return;
    }
    if (race.crossings === this.lastCrossings) return;
    this.lastCrossings = race.crossings;
    if (race.lapsCompleted !== this.lastLaps) {
      this.lastLaps = race.lapsCompleted;
      this.sink.noteCheckpoint('lap');
    } else {
      this.sink.noteCheckpoint(race.lastCrossing);
    }
  }
}
