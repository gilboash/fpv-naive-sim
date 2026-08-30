/**
 * What a race course is made of.
 *
 * Checkpoints live in NED, like the physics, and carry the direction they must
 * be taken in — a gate flown backwards is not a gate flown. The renderer draws
 * an arrow from the same numbers, so what a pilot sees and what the timer
 * accepts cannot disagree.
 */

export interface Gate {
  kind: 'gate';
  /** Centre of the aperture. */
  north: number;
  east: number;
  /** Height of the aperture centre above the ground. */
  up: number;
  /** Unit vector, horizontal, pointing the way through. */
  dirN: number;
  dirE: number;
  halfWidth: number;
  halfHeight: number;
}

/**
 * A pylon you pass on a given side.
 *
 * It was a swept angle at first — stay inside a radius and turn 270 degrees the
 * right way — and it was the wrong rule twice over. It was unclear, because a
 * circle drawn on the ground says "fly this shape" when the shape is not the
 * point; and it was brittle, because a pilot flying round the drawn ring
 * strayed outside the radius and silently lost all their progress, so it never
 * completed however many times they went round.
 *
 * A flag is really a gate with one post: go past it, this way, on this side,
 * near enough. That is one plane crossing, the same test a gate uses.
 */
export interface Flag {
  kind: 'flag';
  north: number;
  east: number;
  height: number;
  /** Unit vector, horizontal: the way you are travelling as you pass it. */
  dirN: number;
  dirE: number;
  /**
   * Which side the pole must be on. +1 means you pass to the left of the
   * direction of travel (the pole on your right), -1 the other way.
   */
  side: 1 | -1;
  /** How far past the pole still counts, measured across the direction. */
  passWidth: number;
}

export type Checkpoint = Gate | Flag;

export interface Course {
  name: string;
  /** Where the quad sits before the start, NED, and its heading in degrees. */
  start: { north: number; east: number; yawDeg: number };
  checkpoints: Checkpoint[];
  defaultLaps: number;
}

const g = (
  north: number,
  east: number,
  up: number,
  headingDeg: number,
  halfWidth = 1.6,
  halfHeight = 1.3,
): Gate => {
  const r = (headingDeg * Math.PI) / 180;
  return {
    kind: 'gate',
    north,
    east,
    up,
    dirN: Math.cos(r),
    dirE: Math.sin(r),
    halfWidth,
    halfHeight,
  };
};

/**
 * A flag standing beside a gate, taken as one element.
 *
 * Needs no new kind of checkpoint and no new detector: it is a flag and a gate
 * in sequence, placed so they read as one thing. The pole sits off to one side
 * and must be passed on its *outside*, which puts the quad wide of the gate and
 * makes the gate a cut back rather than a straight line — a jink rather than a
 * corridor, which is the point of the element.
 *
 * `flagFirst` chooses which way round: pass the pole then take the gate, or
 * take the gate then round the pole on the way out.
 */
function flagGate(
  gate: Gate,
  flagFirst: boolean,
  offsetSide: 1 | -1,
  lateral = 4.5,
  along = 6,
): Checkpoint[] {
  // Across the gate's direction: right of travel is (-dirE, dirN) reversed —
  // the same convention the detectors use, where positive across is to the
  // right of the direction of travel.
  const acrossN = -gate.dirE * lateral * offsetSide;
  const acrossE = gate.dirN * lateral * offsetSide;
  // Before the gate if the flag comes first, after it if not.
  const s = flagFirst ? -1 : 1;
  const flag: Flag = {
    kind: 'flag',
    north: gate.north + gate.dirN * along * s + acrossN,
    east: gate.east + gate.dirE * along * s + acrossE,
    height: 6,
    dirN: gate.dirN,
    dirE: gate.dirE,
    // Passed on the outside of the pole, which is the same side it is offset
    // to: the quad goes wide, then cuts back through the gate.
    side: offsetSide,
    passWidth: 6,
  };
  return flagFirst ? [flag, gate] : [gate, flag];
}

/**
 * Six gates and three flags, on the open field.
 *
 * Deliberately simple: a short out-and-back so the timing and the sequencing
 * get exercised without the course itself being the hard part. Gates sit at
 * different heights, which is enough to stop a pilot flying the whole thing at
 * one altitude.
 *
 * Two of the flags stand beside a gate — once taken before it and once after,
 * so a pilot meets both orders on a single lap. The third is the turnaround at
 * the far end.
 */
export const sixGateCourse: Course = {
  name: 'Six gates and a flag',
  start: { north: -34, east: 0, yawDeg: 0 },
  defaultLaps: 3,
  checkpoints: [
    g(-20, 0, 2.2, 0),
    // Gate 2 is a flag-and-gate: round the pole on the right, then cut back in.
    ...flagGate(g(-4, 6, 2.4, 0), true, 1),
    g(10, 6, 2.4, 0),
    g(22, 0, 1.5, -90),
    // Passed heading west, keeping the pole to the north — the natural line
    // coming off gate 4 and turning back toward gate 6.
    {
      kind: 'flag',
      north: 26,
      east: -15,
      height: 7,
      dirN: 0,
      dirE: -1,
      side: -1,
      passWidth: 7,
    },
    // And this one the other way round: through the gate, then out around the
    // pole, so the pilot meets both orders on one lap.
    ...flagGate(g(10, -8, 3.2, 180), false, -1),
    g(-10, -6, 2.4, 180),
  ],
};

export const COURSES: Course[] = [sixGateCourse];
