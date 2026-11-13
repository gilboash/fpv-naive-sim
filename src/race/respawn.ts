/**
 * Where a "respawn at the last gate" puts the quad.
 *
 * Just past the checkpoint you last cleared, on the ground, facing the one you
 * are due at next. Facing the next one rather than along the gate you came
 * through, because on a course of turnarounds (the 180s) the gate's own
 * direction points away from where you have to go.
 *
 * For a flag the spot is on the side you pass it, half the pass width out from
 * the pole, so the respawn does not drop you on the pole. A cube's floor has no
 * horizontal direction, so its spot is under the opening. Pure, so it can be
 * tested without a page; the scene pushes the spot clear of obstacles after.
 */
import type { Checkpoint } from './course.ts';

/** How far past the checkpoint, metres: clear of its frame, not far down the course. */
export const RESPAWN_PAST = 3;

export interface RespawnPose {
  north: number;
  east: number;
  yawDeg: number;
}

export function respawnPose(at: Checkpoint, toward: Checkpoint | null): RespawnPose {
  let n = at.north;
  let e = at.east;
  if (at.kind === 'flag') {
    // Right of the direction of travel is (-dirE, dirN), as in the flag test.
    const off = (at.side * at.passWidth) / 2;
    n += -at.dirE * off;
    e += at.dirN * off;
  }
  n += at.dirN * RESPAWN_PAST;
  e += at.dirE * RESPAWN_PAST;
  let yawRad = Math.atan2(at.dirE, at.dirN);
  if (toward) {
    const dn = toward.north - n;
    const de = toward.east - e;
    if (Math.hypot(dn, de) > 0.5) yawRad = Math.atan2(de, dn);
  }
  return { north: n, east: e, yawDeg: (yawRad * 180) / Math.PI };
}
