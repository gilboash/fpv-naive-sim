/**
 * The sound track for a replay video: the page's own sound (src/audio.ts) made
 * again from the re-fly, offline.
 *
 * Same graph, same rules: SoundGraph is what the live page plays, and the cues
 * (crash, gong, gate, flag, lap) come from SoundCues hooked into the re-fly at
 * the points the live tick reads them. The difference is the clock. Live, the
 * graph is driven at 30 Hz from the render loop and an event sounds on the
 * next frame; here it is driven every 10 ms of flight time and an event sounds
 * on its own tick, since an OfflineAudioContext can be told the time exactly.
 *
 * Rendered in one-second blocks with `suspend()`: the re-fly runs one second
 * ahead, schedules that second, and lets the context render it. So the
 * automation lists stay short however long the flight is.
 */

import { airframeVoice, decodeGong, masterGainFor, SoundGraph } from '../audio.ts';
import type { Obstacle } from '../flight/collision.ts';
import { SoundCues } from '../sound-cues.ts';
import { ReplayRun, type FlightTape } from './tape.ts';

export const SOUND_RATE = 48000;
/** The level a video is mixed at: a volume slider at 75%, as on the page. */
const VIDEO_VOLUME = 0.75;
/** How often the motors are re-aimed, in ticks (10 ms). */
const DRIVE_TICKS = 10;
const BLOCK_S = 1;

/** Whether this browser can render sound offline at all. */
export function soundUnsupported(): boolean {
  return typeof OfflineAudioContext === 'undefined';
}

/**
 * Re-fly `tape` and render what it sounded like: mono, `SOUND_RATE`, exactly
 * `seconds` long (the video's length). `gong` follows the page's gong setting.
 */
export async function renderFlightSound(
  tape: FlightTape,
  obstacles: readonly Obstacle[],
  seconds: number,
  opts: { gong: boolean },
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Float32Array> {
  const length = Math.max(1, Math.round(seconds * SOUND_RATE));
  const ctx = new OfflineAudioContext(1, length, SOUND_RATE);
  const graph = new SoundGraph(ctx, ctx.destination, masterGainFor(VIDEO_VOLUME));
  const gong = opts.gong ? await decodeGong(ctx) : null;

  const run = new ReplayRun(tape, obstacles);
  const voice = airframeVoice(run.sim);
  const dt = tape.dt;
  const now = (): number => run.tick * dt;
  // Cues fire inside step(), before the tick counter moves on: the event
  // happened at the end of the step being taken.
  const cueAt = (): number => (run.tick + 1) * dt;
  run.cues = new SoundCues({
    noteCrash: (speed) => graph.bang(cueAt(), speed),
    noteStrike: (speed) => {
      if (gong) graph.strike(cueAt(), speed, gong);
    },
    noteCheckpoint: (kind) => graph.chime(cueAt(), kind),
  });

  const drive = (): void => graph.drive(now(), run.sim.telemetry.motorRpm, run.sim.telemetry.speed, voice.blades, voice.refRpm);
  // Fly up to the end of a block, aiming the motors every DRIVE_TICKS.
  const flyTo = (t: number): void => {
    const end = Math.min(tape.ticks, Math.round(t / dt));
    while (run.tick < end) {
      run.step();
      if (run.tick % DRIVE_TICKS === 0) drive();
    }
  };

  drive();
  flyTo(BLOCK_S);
  const blocks = Math.ceil(seconds / BLOCK_S);
  let cancelled = false;
  for (let b = 1; b < blocks; b++) {
    const at = b * BLOCK_S;
    void ctx.suspend(at).then(() => {
      if (!cancelled) {
        if (signal.aborted) cancelled = true;
        else {
          flyTo(at + BLOCK_S);
          onProgress(at / seconds);
        }
      }
      void ctx.resume();
    });
  }
  const buffer = await ctx.startRendering();
  graph.stop();
  if (cancelled || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  onProgress(1);
  // Normalised to 1 dB under full scale, at most 4x up: a video is played
  // beside other videos, not under a volume slider set for flying, and the
  // mix as the page plays it peaks around -10 dB.
  const pcm = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
  for (let i = 0; i < pcm.length; i++) pcm[i]! *= gain;
  return pcm;
}
