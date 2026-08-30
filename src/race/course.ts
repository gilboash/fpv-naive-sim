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

export interface Flag {
  kind: 'flag';
  north: number;
  east: number;
  height: number;
  /** Must be inside this to be circling it. */
  radius: number;
  /** +1 anticlockwise seen from above, -1 clockwise. */
  direction: 1 | -1;
  /** How much of a turn counts as "round it", radians. */
  sweep: number;
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
 * Six gates and a flag, on the open field.
 *
 * Deliberately simple: a short out-and-back with one direction change and one
 * pylon turn, so the timing and the sequencing get exercised without the course
 * itself being the hard part. Gate 4 is low and gate 5 is high, which is enough
 * to stop a pilot flying the whole thing at one altitude.
 *
 * The flag sits at the far end and is circled anticlockwise, which is the turn
 * a pilot arrives at naturally coming up the left of the field.
 */
export const sixGateCourse: Course = {
  name: 'Six gates and a flag',
  start: { north: -34, east: 0, yawDeg: 0 },
  defaultLaps: 3,
  checkpoints: [
    g(-20, 0, 2.2, 0),
    g(-4, 6, 2.4, 0),
    g(10, 6, 2.4, 0),
    g(22, 0, 1.5, -90),
    {
      kind: 'flag',
      north: 30,
      east: -14,
      height: 6,
      radius: 9,
      direction: 1,
      sweep: (270 * Math.PI) / 180,
    },
    g(10, -8, 3.2, 180),
    g(-10, -6, 2.4, 180),
  ],
};

export const COURSES: Course[] = [sixGateCourse];
