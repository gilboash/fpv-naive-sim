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
  /** Unit vector pointing the way through. */
  dirN: number;
  dirE: number;
  /**
   * Vertical component of that direction. Zero — the default — is the gate
   * everyone means by the word: a vertical frame you fly through horizontally.
   *
   * ±1 makes the checkpoint a *horizontal* plane: the opening in the top of a
   * cube, dropped through rather than flown through. That is a different thing
   * to fly and it needed the plane test to stop assuming a horizontal normal,
   * which it had done since the first gate.
   */
  dirU?: number;
  /**
   * Half-extents in the plane. For an upright gate these are width and height;
   * for a horizontal one they are the two ground axes.
   */
  halfWidth: number;
  halfHeight: number;
  /**
   * `'none'` when the scenery is already there and this checkpoint only names
   * an opening in it — the faces and floors of a cube. Without it the map would
   * draw a gate frame inside the cube it belongs to.
   */
  frame?: 'none';
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

/**
 * The aperture every gate on every map has: **3.05 m tall**, which is twice
 * MultiGP's 5 ft gate, and 30% wider than that again.
 *
 * It was the MultiGP figure exactly, and flying it said otherwise — at 1.5 m
 * square the gates read as slots rather than gates from any distance, and the
 * course became about threading rather than about lines. Doubled on Gilboa's
 * call after flying it. The proportions of the frame still come off the
 * aperture, so the whole gate scales with this one number.
 *
 * Stated as "twice MultiGP" rather than quietly relabelled: the shape is the
 * standard one, the size is a simulator concession, and pretending otherwise
 * would make every lap time here mean less than it looks like it means.
 */
export const GATE_HALF_H = 1.524;

/**
 * And 30% wider than it is tall, so the aperture is 3.96 m across.
 *
 * Not a square, and that is the point: a gate is missed sideways far more often
 * than vertically, because the line into it is horizontal and the error that
 * matters is the one in the turn. Widening only the width keeps the height
 * honest — you still have to be at the right altitude.
 */
export const GATE_HALF_W = GATE_HALF_H * 1.3;

/**
 * Where the middle of that aperture sits on a gate standing on the ground: the
 * bottom of the opening about half a metre up, as the legs on a real one put
 * it. Courses raise individual gates above this deliberately; nothing lowers it.
 */
export const GATE_UP = GATE_HALF_H + 0.53;

const g = (
  north: number,
  east: number,
  up: number,
  headingDeg: number,
  halfWidth = GATE_HALF_W,
  halfHeight = GATE_HALF_H,
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
 * A flag pole that *is* one side of a gate.
 *
 * The pole stands exactly where that post would be and carries on well above
 * the top bar, so the gate and the flag are one piece of scenery rather than
 * two things near each other. That turns the element into a loop: both share
 * the same plane, so you cannot take them in one pass. Round the pole — over
 * the gate, since the pole is attached to it — and come back through the
 * aperture. Or the reverse, depending on the order.
 *
 * It was two separate obstacles at first, a pole a few metres off to the side,
 * which made a jink rather than a loop and did not read as one element at all.
 *
 * No new checkpoint kind and no new detector: it is still a flag and a gate in
 * sequence. The geometry does the work.
 */
function flagGate(gate: Gate, flagFirst: boolean, poleSide: 1 | -1): Checkpoint[] {
  // Right of the direction of travel, which is the convention the detectors
  // use for "across".
  const acrossN = -gate.dirE * gate.halfWidth * poleSide;
  const acrossE = gate.dirN * gate.halfWidth * poleSide;
  const flag: Flag = {
    kind: 'flag',
    north: gate.north + acrossN,
    east: gate.east + acrossE,
    // Tall: it has to be obvious that going over the gate is the way round it.
    height: gate.up + gate.halfHeight + 4.5,
    dirN: gate.dirN,
    dirE: gate.dirE,
    // Passed on the far side from the gate, so the pole is rounded rather than
    // clipped along with the aperture.
    side: poleSide,
    passWidth: 4,
  };
  return flagFirst ? [flag, gate] : [gate, flag];
}

/**
 * A cube: four square openings, open top and bottom, standing on the ground.
 *
 * Declared here rather than in the map, because a checkpoint through a cube is
 * only meaningful if the cube is where the timer thinks it is. The map draws
 * these; the course routes through them; one set of coordinates.
 */
export interface CubeSpec {
  north: number;
  east: number;
  /** Half the side of one storey. */
  half: number;
  storeys: number;
}

/**
 * A cube panel is 20% larger than a gate is tall, so an opening is 3.66 m
 * square against the gate's 3.05 m of height.
 *
 * Bigger than the gate on purpose: a cube face is taken at an angle far more
 * often than a gate is — you arrive at one on the way round something rather
 * than lined up on it — and it is entered blind on the drop through the top.
 */
export const CUBE_HALF = GATE_HALF_H * 1.2;

/** After gate 2: dropped into from above and left through the side. */
export const SINGLE_CUBE: CubeSpec = { north: 3, east: 16, half: CUBE_HALF, storeys: 1 };

/** After gate 5, before its pole: in low, up the shaft, then across both floors. */
export const DOUBLE_CUBE: CubeSpec = { north: 6, east: -20, half: CUBE_HALF, storeys: 2 };

/**
 * Openings are a little inside the frame, so a checkpoint that says you went
 * through the cube means you went through the hole rather than past the corner
 * of it.
 */
const OPENING = 0.85;

/** The horizontal opening at a floor level: 0 is the ground, `storeys` the top. */
function cubeFloor(c: CubeSpec, level: number, going: 1 | -1): Gate {
  return {
    kind: 'gate',
    north: c.north,
    east: c.east,
    up: c.half * 2 * level,
    dirN: 0,
    dirE: 0,
    dirU: going,
    halfWidth: c.half * OPENING,
    halfHeight: c.half * OPENING,
    frame: 'none',
  };
}

/**
 * One of the four side openings.
 *
 * `wallHeading` names *which* wall — 90 is the east one — and `travel` says
 * which way you go through it: +1 outward, -1 inward. The two are separate on
 * purpose, because the interesting case is entering and leaving by the same
 * face, and a single heading cannot say both. Getting that conflated put the
 * entry plane on the far wall the first time, so the cube could be entered by
 * flying straight past it.
 */
function cubeFace(c: CubeSpec, wallHeading: number, storey: number, travel: 1 | -1): Gate {
  const r = (wallHeading * Math.PI) / 180;
  const wallN = Math.round(Math.cos(r));
  const wallE = Math.round(Math.sin(r));
  const side = c.half * 2;
  return {
    kind: 'gate',
    north: c.north + wallN * c.half,
    east: c.east + wallE * c.half,
    up: side * (storey + 0.5),
    dirN: wallN * travel,
    dirE: wallE * travel,
    halfWidth: c.half * OPENING,
    halfHeight: c.half * OPENING,
    frame: 'none',
  };
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
    g(-20, 0, GATE_UP, 0),
    // Gate 2 is a flag-and-gate: round the pole on the right, then cut back in.
    ...flagGate(g(-4, 6, GATE_UP, 0), true, 1),
    // Straight off gate 2 and into the single cube from *above*: climb, drop
    // through the open top, and leave through the west face, which is the one
    // pointing back at the course. A dive with a wall to stop on.
    cubeFloor(SINGLE_CUBE, 1, -1),
    cubeFace(SINGLE_CUBE, -90, 0, 1),
    // Raised, so the course is not all at one height.
    g(10, 6, GATE_UP + 1.2, 0),
    g(22, 0, GATE_UP, -90),
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
    // Gate 5, and then the two-storey cube before its pole rather than after
    // it. In at ground level through the face nearest the course, up the shaft
    // and out of the top, then through the upper storey and the lower one
    // sideways — and only then round the pole, as the course always did.
    g(10, -8, GATE_UP + 1.8, 180),
    cubeFace(DOUBLE_CUBE, 90, 0, -1),
    cubeFloor(DOUBLE_CUBE, 1, 1),
    cubeFloor(DOUBLE_CUBE, 2, 1),
    // Out of the top and then *across* rather than back down the shaft: over
    // the lip, in through the upper storey's north face, out its south side,
    // then round and north through the ground storey. Diving back down the
    // shaft you had just climbed was the first version and flew as a repeat of
    // the move you had already made.
    cubeFace(DOUBLE_CUBE, 0, 1, -1),
    cubeFace(DOUBLE_CUBE, 180, 0, -1),
    // The pole that stands on gate 5, taken after the cube.
    {
      kind: 'flag',
      north: 10,
      east: -8 + GATE_HALF_W,
      height: GATE_UP + 1.8 + GATE_HALF_H + 4.5,
      dirN: -1,
      dirE: 0,
      side: -1,
      passWidth: 4,
    },
    g(-10, -6, GATE_UP, 180),
  ],
};

/**
 * A straight line of gates, a turn, and a straight line back.
 *
 * The drill this exists for is acceleration and braking: 20 gates at a fixed
 * height and spacing with nothing to think about but throttle, so the only
 * variable is how hard you can push and how late you can brake. It is also the
 * one course where identical gates in a line are the point rather than the
 * mistake the gate run made — the receding frames read as a tunnel, and the
 * numbered blocks beside them say which is which.
 *
 * One lap, because an out-and-back over half a kilometre is already a lap.
 */
function straightRun(
  count: number,
  east: number,
  fromNorth: number,
  spacing: number,
  heading: number,
  up: number,
): Gate[] {
  const out: Gate[] = [];
  const step = heading === 0 ? spacing : -spacing;
  for (let i = 0; i < count; i++) out.push(g(fromNorth + i * step, east, up, heading));
  return out;
}

export const thrustCourse: Course = {
  name: 'Thrust line',
  start: { north: -148, east: -8, yawDeg: 0 },
  defaultLaps: 1,
  checkpoints: [
    ...straightRun(20, -8, -130, 14, 0, GATE_UP),
    // The turn. Rounded to the outside of the return line, so the natural line
    // off the last gate is a right-hand U — and the pole is what stops anyone
    // cutting the corner and calling it a lap.
    {
      kind: 'flag',
      north: 152,
      east: 0,
      height: 9,
      dirN: 1,
      dirE: 0,
      side: 1,
      passWidth: 14,
    },
    ...straightRun(20, 8, 136, 14, 180, GATE_UP),
  ],
};

/**
 * Twenty gates evenly round a circle, so a lap *is* the circle.
 *
 * Nothing here is a straight: the exercise is holding a constant radius and a
 * constant height while the quad wants to do neither, which is the thing that
 * separates a tidy pilot from a fast one. The gates face along the tangent, so
 * a gate taken square means the turn was right at that instant.
 */
export const circleCourse: Course = {
  name: 'Circle',
  // On the circle, a little before the first gate, already pointing along it.
  start: { north: 57.96, east: -15.53, yawDeg: 75 },
  defaultLaps: 3,
  checkpoints: (() => {
    const R = 60;
    const n = 20;
    const out: Gate[] = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      // Position on the circle, and the tangent, which is what a gate faces.
      const north = R * Math.cos(th);
      const east = R * Math.sin(th);
      const heading = (Math.atan2(Math.cos(th), -Math.sin(th)) * 180) / Math.PI;
      out.push(g(north, east, GATE_UP, heading));
    }
    return out;
  })(),
};

/**
 * Two rows of gates flown as a comb: through one, hard 180, back through the
 * next.
 *
 * Every gate in a row faces the same axis and the *direction* alternates, so
 * the course is nothing but turnarounds — ten of them, then a transit to the
 * second row and ten more coming back. It is the drill for the thing that
 * actually costs time on a real track, which is not the straight.
 *
 * The rows are far enough apart that the transit is a breath rather than
 * another turn, and the last gate of the second row lines up with the first of
 * the first, so the lap closes without a detour.
 */
export const oneEightyCourse: Course = {
  name: '180s',
  start: { north: -25, east: -54, yawDeg: 0 },
  defaultLaps: 2,
  checkpoints: (() => {
    const out: Gate[] = [];
    const span = 12;
    const first = -54;
    // Row one, working east: north, south, north…
    for (let i = 0; i < 10; i++) {
      out.push(g(0, first + i * span, GATE_UP, i % 2 === 0 ? 0 : 180));
    }
    // Row two, working back west. The first of these is taken southbound,
    // which is the way you leave the last gate of row one — so the transit is
    // a straight line rather than yet another turn.
    for (let j = 0; j < 10; j++) {
      out.push(g(-55, first + (9 - j) * span, GATE_UP, j % 2 === 0 ? 180 : 0));
    }
    return out;
  })(),
};

export const COURSES: Course[] = [sixGateCourse, thrustCourse, circleCourse, oneEightyCourse];
