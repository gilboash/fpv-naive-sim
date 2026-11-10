/**
 * Radio stick -> ESP32 stick, so a recorded human lap can be flown through the
 * board. Velocidrone calibrates each controller separately, so the same raw
 * value from the TX16S and the ESP32 is not the same stick in the game. Both
 * were measured against the game's own stick overlay (the green dots),
 * 2026-11-08: raw -> overlay px at 960x600 is a gain and a bias per axis.
 *
 * Radio (human5, r > 0.97 per axis): roll 109.13 + 16.94a, pitch 33.30 -
 * 16.99a, thr 31.54 - 18.88a, yaw 34.08 + 17.19a.
 * Board (held-step sweep): roll 109.2 + 17.2s, pitch 33.3 - 17.6s, yaw 34.0 +
 * 18.0s, thr 51.0 - 35.2t (t = 0..1). Pitch is NOT inverted.
 */
import type { Sticks } from './stick-port.ts';

const c1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** `thrTrim`: the match is good to ~1% of throttle, and 1% decided gate 1. */
export function toEsp(a0: number, a1: number, a2: number, a3: number, thrTrim = 0): Sticks {
  return {
    roll: c1((16.94 * a0 - 0.07) / 17.2),
    pitch: c1((16.99 * a1) / 17.6),
    throttle: Math.max(0, Math.min(1, (51.0 - 31.54 + 18.88 * a2) / 35.2 + (a2 > -0.9 ? thrTrim : 0))),
    yaw: c1((17.19 * a3 + 0.08) / 18.0),
  };
}
