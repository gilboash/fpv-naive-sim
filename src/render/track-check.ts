/**
 * Is this track flyable enough to save?
 *
 * Structural checks only, and that limit is deliberate. The tempting answer is
 * to have the machine pilot attempt the course and refuse anything it cannot
 * complete — but that pilot cannot fly *Race vibes*, one of this project's own
 * maps, so using it as a gate would reject good tracks and teach pilots to
 * distrust the check. A check that is wrong sometimes is worse than a narrower
 * one that is right always.
 *
 * So this asks the questions that have a definite answer: is the start clear,
 * can each gate actually be flown through, are two checkpoints distinguishable,
 * is anything buried in the ground. Everything softer is a **warning** — said
 * out loud and not in the way of saving, because "this looks like a long way
 * between gates" is an opinion and the pilot is the one flying it.
 */

import type { Checkpoint, Course } from '../race/course.ts';
import { clearance, type Obstacle } from '../flight/collision.ts';
import { MeshBuilder } from './mesh.ts';
import type { Track } from './track.ts';

export interface TrackCheck {
  ok: boolean;
  /** Things that stop a track being saved. */
  errors: string[];
  /** Things worth saying that are still the pilot's call. */
  warnings: string[];
  obstacles: number;
}

/** Half the width of a 5" quad, plus the margin a pilot needs not to clip. */
const QUAD_CLEARANCE = 0.45;

/** Beyond this between consecutive checkpoints, a coordinate is likely a typo. */
const LONG_HOP_M = 250;

/** Nearer than this and the timer cannot tell two checkpoints apart. */
const MIN_SEPARATION_M = 2;

function blocked(obstacles: Obstacle[], north: number, east: number, up: number, margin: number): boolean {
  // `clearance` pushes a point out of anything solid; if it moved, the point
  // was inside something. Reusing it means the check and the flight model agree
  // on what "inside" means, which two separate implementations would not.
  const out = clearance(obstacles, north, east, up, margin);
  return Math.abs(out.north - north) > 1e-6 || Math.abs(out.east - east) > 1e-6;
}

/**
 * Can something be flown through this aperture?
 *
 * The rule is **the centre must be clear**, not the whole cross-section, and
 * that distinction matters: sampling the edges as well failed Race vibes on its
 * own cube openings, because a cube face is framed by the cube — the rails are
 * right there at the edge by construction. A gate you can only take through the
 * middle is a tight gate, not a broken one.
 *
 * The edges are still sampled, as a warning. Knowing a gate is tight is worth
 * saying; refusing to save it is not.
 */
function apertureBlocked(
  obstacles: Obstacle[],
  cp: Checkpoint,
): { centre: boolean; tightEdges: number } {
  if (cp.kind !== 'gate') return { centre: false, tightEdges: 0 };
  const dU = cp.dirU ?? 0;
  // Across the aperture, the same vector the crossing test uses.
  const ax = Math.abs(dU) > 0.999 ? [0, 1, 0] : [-cp.dirE, cp.dirN, 0];
  const ay = Math.abs(dU) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  const w = cp.halfWidth * 0.6;
  const h = cp.halfHeight * 0.6;
  const at = (sx: number, sy: number): boolean =>
    blocked(
      obstacles,
      cp.north + ax[0]! * w * sx + ay[0]! * h * sy,
      cp.east + ax[1]! * w * sx + ay[1]! * h * sy,
      cp.up + ax[2]! * w * sx + ay[2]! * h * sy,
      QUAD_CLEARANCE,
    );
  let tight = 0;
  for (const [sx, sy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as [number, number][]) {
    if (at(sx, sy)) tight++;
  }
  return { centre: at(0, 0), tightEdges: tight };
}

/**
 * Check a built track.
 *
 * Takes the `Track` rather than the spec, because the questions are about the
 * scene that comes out — a piece and a checkpoint can each be individually
 * reasonable and still end up inside one another.
 */
export function checkTrack(track: Track): TrackCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const obstacles: Obstacle[] = [];
  track.build(new MeshBuilder(), obstacles);

  const start = track.start;
  if (blocked(obstacles, start.north, start.east, 1.2, QUAD_CLEARANCE)) {
    errors.push('the start line is inside something — move it, or move what is on it');
  }

  const course: Course | undefined = track.course;
  if (course) {
    const cps = course.checkpoints;
    if (cps.length < 2) {
      errors.push('a course needs at least two checkpoints — a lap runs from the first back to it');
    }

    cps.forEach((cp, i) => {
      const label = `checkpoint ${i + 1}`;
      if (cp.kind === 'gate') {
        if (cp.up - cp.halfHeight < 0.2) {
          errors.push(`${label}: its opening is in the ground — raise it`);
        }
        const aperture = apertureBlocked(obstacles, cp);
        if (aperture.centre) {
          errors.push(`${label}: something is standing in the gate — it cannot be flown through`);
        } else if (aperture.tightEdges >= 3) {
          warnings.push(`${label}: tight — there is barely room either side of the line through it`);
        }
      } else if (cp.height < 2) {
        warnings.push(`${label}: a flag pole under 2 m is hard to see`);
      }

      const next = cps[(i + 1) % cps.length]!;
      const nextUp = next.kind === 'gate' ? next.up : next.height;
      const thisUp = cp.kind === 'gate' ? cp.up : cp.height;
      const gap = Math.hypot(next.north - cp.north, next.east - cp.east, nextUp - thisUp);
      if (gap < MIN_SEPARATION_M) {
        errors.push(
          `${label} and ${i + 2 > cps.length ? 1 : i + 2} are ${gap.toFixed(1)} m apart — ` +
            'the timer cannot tell them apart',
        );
      } else if (gap > LONG_HOP_M) {
        warnings.push(`${label} to the next is ${gap.toFixed(0)} m — check the coordinates`);
      }
    });

    // The start should be behind the first checkpoint, not past it, or the
    // opening lap is flown backwards and the hole shot is nonsense.
    const first = cps[0]!;
    const ahead =
      (start.north - first.north) * first.dirN + (start.east - first.east) * first.dirE;
    if (ahead > 0) {
      warnings.push(
        'the start is past the first checkpoint rather than behind it — the first lap will ' +
          'begin by turning round',
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, obstacles: obstacles.length };
}
