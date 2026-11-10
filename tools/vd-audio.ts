/**
 * Listen to the game: GO tone and gate beeps, live, through BlackHole.
 *
 * The countdown is three short beeps and a long tone (GO); every checkpoint
 * passed is a short beep after it. Counting those is a far better pass
 * detector than anything read off the picture.
 *
 * Times are on the caller's clock (`clock()`, seconds) at the *start* of the
 * sound, refined to 2 ms inside the 50 ms analysis window.
 */
import { spawn } from 'node:child_process';

export const SR = 22050;

export interface Listener {
  /** Call when Race Start is pressed: from now a long tone after 2+ short ones is GO. */
  arm(): void;
  stop(): Buffer; // the audio as 16-bit mono PCM
  events: [number, number][];
}

export function listen(clock: () => number, on: { go?: (at: number) => void; beep?: (at: number, len: number) => void }): Listener {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':BlackHole 2ch', '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pcm: Buffer[] = [];
  const events: [number, number][] = [];
  let audioStart = NaN;
  let carry = Buffer.alloc(0);
  let consumed = 0; // samples already analysed
  const WIN = Math.round(0.05 * SR);
  let base = 0.0005;
  let onTone = false;
  let onsetAt = 0;
  let shorts = 0;
  let armed = false;
  let went = false;

  const refine = (buf: Buffer, off: number, at: number, thr: number): number => {
    const S = Math.round(0.002 * SR);
    for (let j = 0; j + S <= WIN; j += S) {
      let s = 0;
      for (let q = 0; q < S; q++) {
        const v = buf.readInt16LE(off + (j + q) * 2) / 32768;
        s += v * v;
      }
      if (Math.sqrt(s / S) > thr) return at + j / SR;
    }
    return at;
  };

  ff.stdout.on('data', (c: Buffer) => {
    if (!Number.isFinite(audioStart)) audioStart = clock() - c.length / 2 / SR;
    pcm.push(c);
    carry = Buffer.concat([carry, c]);
    let off = 0;
    while (carry.length - off >= WIN * 2) {
      let s = 0;
      for (let j = 0; j < WIN; j++) {
        const v = carry.readInt16LE(off + j * 2) / 32768;
        s += v * v;
      }
      const rms = Math.sqrt(s / WIN);
      const at = audioStart + consumed / SR;
      const hi = Math.max(4 * base, 0.003);
      if (!onTone && rms > hi) {
        onTone = true;
        onsetAt = refine(carry, off, at, hi);
      } else if (onTone && rms < Math.max(2 * base, 0.0015)) {
        onTone = false;
        const len = at - onsetAt;
        events.push([onsetAt, len]);
        if (armed && !went) {
          if (len < 0.5) shorts++;
          else if (shorts >= 2) {
            went = true;
            on.go?.(onsetAt);
          }
        } else if (went && len < 0.5) on.beep?.(onsetAt, len);
      }
      if (!onTone) base += (rms - base) * 0.01;
      off += WIN * 2;
      consumed += WIN;
    }
    carry = carry.subarray(off);
  });
  return {
    arm: () => (armed = true),
    stop: () => {
      ff.kill('SIGINT');
      return Buffer.concat(pcm);
    },
    events,
  };
}
