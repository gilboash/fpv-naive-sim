/**
 * Maps. Render-space coordinates throughout: x right, y up, z toward the
 * viewer, metres.
 *
 * "A few simple maps with basic obstacles", per the brief, and no more than
 * that. What a pilot needs from a training scene is depth cues, a sense of
 * scale, and things to fly through — not scenery. Ground markings do most of
 * the work: without something textured underneath, a quad at 20 m/s over a flat
 * plane looks stationary.
 */

import { MeshBuilder } from './mesh.ts';
import type { Obstacle } from '../flight/collision.ts';
import { sixGateCourse } from '../race/course.ts';

/**
 * Render space to NED, for collision volumes.
 *
 * The scene is authored in render coordinates because that is where it is drawn,
 * and the physics needs NED. Both come out of the same call so a gate cannot end
 * up drawn in one place and solid in another.
 */
const north = (renderZ: number): number => -renderZ;
const east = (renderX: number): number => renderX;

export interface Track {
  name: string;
  /** Where the quad starts, in NED metres, and its heading in degrees. */
  start: { north: number; east: number; yawDeg: number };
  build(m: MeshBuilder, obstacles: Obstacle[]): void;
}

// The two greens have to be visibly different. An earlier pair differed by 0.03
// and the ground read as a flat sheet: at 20 m/s over an untextured plane a quad
// looks stationary, which defeats the purpose of having a scene at all.
const GRASS: [number, number, number] = [0.27, 0.37, 0.19];
const GRASS_ALT: [number, number, number] = [0.17, 0.25, 0.13];
const TARMAC: [number, number, number] = [0.22, 0.22, 0.24];
const GATE_A: [number, number, number] = [0.85, 0.25, 0.15];
const GATE_B: [number, number, number] = [0.95, 0.75, 0.15];
const POST: [number, number, number] = [0.9, 0.9, 0.92];

/** Chequered ground, which is what makes speed and height legible. */
function ground(m: MeshBuilder, half = 220, tile = 8): void {
  for (let x = -half; x < half; x += tile) {
    for (let z = -half; z < half; z += tile) {
      const alt = ((x / tile + z / tile) & 1) === 0;
      const c = alt ? GRASS : GRASS_ALT;
      m.groundQuad(x, z, x + tile, z + tile, 0, c[0], c[1], c[2]);
    }
  }
}

/**
 * A race gate: two posts and a top bar, with the opening a pilot aims at.
 * `cx, cz` is the centre of the opening at ground level.
 */
function gate(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  width: number,
  height: number,
  along: 'x' | 'z',
  colour: [number, number, number],
): void {
  const half = width / 2;
  const postR = 0.06;
  const bar = 0.09;
  // Collision radius is a little over the drawn one: props stick out past the
  // motors, and a pilot who clips a post with a blade has crashed.
  const hitR = postR + 0.06;
  if (along === 'x') {
    m.cylinder(cx - half, cz, 0, height, postR, 10, ...POST);
    m.cylinder(cx + half, cz, 0, height, postR, 10, ...POST);
    obs.push({ kind: 'cylinder', north: north(cz), east: east(cx - half), radius: hitR, height });
    obs.push({ kind: 'cylinder', north: north(cz), east: east(cx + half), radius: hitR, height });
    obs.push({
      kind: 'box',
      minNorth: north(cz + bar),
      maxNorth: north(cz - bar),
      minEast: east(cx - half - postR),
      maxEast: east(cx + half + postR),
      minUp: height,
      maxUp: height + bar * 2,
    });
    m.slab(cx - half - postR, height, cz - bar, cx + half + postR, height + bar * 2, cz + bar, ...colour);
    // Foot markers, so the gate reads as a gate from a distance.
    m.groundQuad(cx - half - 0.4, cz - 0.4, cx - half + 0.4, cz + 0.4, 0.01, ...colour);
    m.groundQuad(cx + half - 0.4, cz - 0.4, cx + half + 0.4, cz + 0.4, 0.01, ...colour);
  } else {
    m.cylinder(cx, cz - half, 0, height, postR, 10, ...POST);
    m.cylinder(cx, cz + half, 0, height, postR, 10, ...POST);
    obs.push({ kind: 'cylinder', north: north(cz - half), east: east(cx), radius: hitR, height });
    obs.push({ kind: 'cylinder', north: north(cz + half), east: east(cx), radius: hitR, height });
    obs.push({
      kind: 'box',
      minNorth: north(cz + half + postR),
      maxNorth: north(cz - half - postR),
      minEast: east(cx - bar),
      maxEast: east(cx + bar),
      minUp: height,
      maxUp: height + bar * 2,
    });
    m.slab(cx - bar, height, cz - half - postR, cx + bar, height + bar * 2, cz + half + postR, ...colour);
    m.groundQuad(cx - 0.4, cz - half - 0.4, cx + 0.4, cz - half + 0.4, 0.01, ...colour);
    m.groundQuad(cx - 0.4, cz + half - 0.4, cx + 0.4, cz + half + 0.4, 0.01, ...colour);
  }
}

/** A render-space box, emitted as both geometry and a collision volume. */
function solid(
  m: MeshBuilder,
  obs: Obstacle[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  c: readonly [number, number, number],
): void {
  m.slab(x0, y0, z0, x1, y1, z1, c[0]!, c[1]!, c[2]!);
  obs.push({
    kind: 'box',
    minNorth: north(Math.max(z0, z1)),
    maxNorth: north(Math.min(z0, z1)),
    minEast: east(Math.min(x0, x1)),
    maxEast: east(Math.max(x0, x1)),
    minUp: Math.min(y0, y1),
    maxUp: Math.max(y0, y1),
  });
}

/** Floodlight mast. Tall, thin, and unforgiving — the thing you clip on a dive. */
function lightPole(m: MeshBuilder, obs: Obstacle[], cx: number, cz: number, height: number): void {
  m.cylinder(cx, cz, 0, height, 0.1, 10, 0.62, 0.64, 0.68);
  obs.push({ kind: 'cylinder', north: north(cz), east: east(cx), radius: 0.17, height });
  // Head, canted so it reads as a lamp rather than a lump.
  solid(m, obs, cx - 0.55, height, cz - 0.28, cx + 0.55, height + 0.16, cz + 0.28, [0.9, 0.88, 0.72]);
  solid(m, obs, cx - 0.1, height - 0.5, cz - 0.1, cx + 0.1, height, cz + 0.1, [0.5, 0.52, 0.56]);
}

/**
 * A tube to fly through, up in the air on two legs. The bore is the line; the
 * wall is what you hit when you get it wrong.
 */
function flyTube(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  halfLength: number,
  along: 'x' | 'z',
): void {
  const thickness = 0.16;
  m.tube(cx, cy, cz, radius, thickness, halfLength, along, 20, 0.72, 0.44, 0.24);
  obs.push({
    kind: 'ring',
    north: north(cz),
    east: east(cx),
    up: cy,
    radius,
    thickness,
    halfLength,
    axis: along === 'z' ? 'north' : 'east',
  });
  // Legs, offset to the ends so they do not block the approach.
  for (const s of [-1, 1]) {
    const lx = along === 'z' ? cx : cx + s * halfLength * 0.8;
    const lz = along === 'z' ? cz + s * halfLength * 0.8 : cz;
    m.cylinder(lx, lz, 0, cy - radius, 0.08, 8, 0.45, 0.47, 0.5);
    obs.push({ kind: 'cylinder', north: north(lz), east: east(lx), radius: 0.14, height: cy - radius });
  }
}

/** Square frame up in the air: the classic freestyle window. */
function squareFrame(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cy: number,
  cz: number,
  half: number,
  along: 'x' | 'z',
  colour: readonly [number, number, number],
): void {
  const t = 0.14;
  const d = 0.14;
  const bars: [number, number, number, number][] = [
    [cx - half - t, cy + half, cx + half + t, cy + half + t],
    [cx - half - t, cy - half - t, cx + half + t, cy - half],
    [cx - half - t, cy - half, cx - half, cy + half],
    [cx + half, cy - half, cx + half + t, cy + half],
  ];
  for (const [x0, y0, x1, y1] of bars) {
    if (along === 'z') {
      solid(m, obs, x0, y0, cz - d, x1, y1, cz + d, colour);
    } else {
      // Rotate the frame into the other plane: x becomes z.
      solid(m, obs, cx - d, y0, cz + (x0 - cx), cx + d, y1, cz + (x1 - cx), colour);
    }
  }
  // Legs down to the ground, clear of the opening.
  for (const s of [-1, 1]) {
    const lx = along === 'z' ? cx + s * (half + t) : cx;
    const lz = along === 'z' ? cz : cz + s * (half + t);
    m.cylinder(lx, lz, 0, cy - half, 0.07, 8, 0.45, 0.47, 0.5);
    obs.push({ kind: 'cylinder', north: north(lz), east: east(lx), radius: 0.13, height: cy - half });
  }
}

/**
 * A race gate: posts, a top bar, and a chevron on the ground showing the way
 * through. The number is spelled out in blocks beside it — a pilot needs to
 * know which gate is which when they are learning the line.
 */
function raceGate(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  up: number,
  halfWidth: number,
  halfHeight: number,
  along: 'x' | 'z',
  colour: readonly [number, number, number],
  number: number,
): void {
  const postR = 0.06;
  const hitR = postR + 0.06;
  const bar = 0.09;
  const top = up + halfHeight;
  const bottom = Math.max(0.05, up - halfHeight);

  if (along === 'x') {
    m.cylinder(cx - halfWidth, cz, 0, top, postR, 10, ...POST);
    m.cylinder(cx + halfWidth, cz, 0, top, postR, 10, ...POST);
    obs.push({ kind: 'cylinder', north: north(cz), east: east(cx - halfWidth), radius: hitR, height: top });
    obs.push({ kind: 'cylinder', north: north(cz), east: east(cx + halfWidth), radius: hitR, height: top });
    m.slab(cx - halfWidth - postR, top, cz - bar, cx + halfWidth + postR, top + bar * 2, cz + bar, colour[0]!, colour[1]!, colour[2]!);
    obs.push({
      kind: 'box',
      minNorth: north(cz + bar), maxNorth: north(cz - bar),
      minEast: east(cx - halfWidth - postR), maxEast: east(cx + halfWidth + postR),
      minUp: top, maxUp: top + bar * 2,
    });
    if (bottom > 0.06) {
      m.slab(cx - halfWidth, bottom - bar, cz - bar, cx + halfWidth, bottom, cz + bar, colour[0]!, colour[1]!, colour[2]!);
      obs.push({
        kind: 'box',
        minNorth: north(cz + bar), maxNorth: north(cz - bar),
        minEast: east(cx - halfWidth), maxEast: east(cx + halfWidth),
        minUp: bottom - bar, maxUp: bottom,
      });
    }
  } else {
    m.cylinder(cx, cz - halfWidth, 0, top, postR, 10, ...POST);
    m.cylinder(cx, cz + halfWidth, 0, top, postR, 10, ...POST);
    obs.push({ kind: 'cylinder', north: north(cz - halfWidth), east: east(cx), radius: hitR, height: top });
    obs.push({ kind: 'cylinder', north: north(cz + halfWidth), east: east(cx), radius: hitR, height: top });
    m.slab(cx - bar, top, cz - halfWidth - postR, cx + bar, top + bar * 2, cz + halfWidth + postR, colour[0]!, colour[1]!, colour[2]!);
    obs.push({
      kind: 'box',
      minNorth: north(cz + halfWidth + postR), maxNorth: north(cz - halfWidth - postR),
      minEast: east(cx - bar), maxEast: east(cx + bar),
      minUp: top, maxUp: top + bar * 2,
    });
  }

  // Direction chevron on the ground, pointing the way through.
  const cp = sixGateCourse.checkpoints[number - 1];
  const dx = cp && cp.kind === 'gate' ? cp.dirE : 0;
  const dz = cp && cp.kind === 'gate' ? -cp.dirN : -1;
  for (let i = 0; i < 3; i++) {
    const t = 0.7 + i * 0.75;
    const px = cx + dx * t;
    const pz = cz + dz * t;
    const w = 0.55 - i * 0.1;
    m.groundQuad(px - w, pz - w, px + w, pz + w, 0.015 + i * 0.001, colour[0]!, colour[1]!, colour[2]!);
  }

  // Gate number: that many small blocks stacked beside the left post.
  const bx = along === 'x' ? cx - halfWidth - 0.5 : cx + 0.5;
  const bz = along === 'x' ? cz + 0.4 : cz - halfWidth - 0.5;
  for (let i = 0; i < number; i++) {
    const y = 0.12 + i * 0.28;
    m.slab(bx - 0.11, y, bz - 0.11, bx + 0.11, y + 0.19, bz + 0.11, 0.95, 0.95, 0.98);
  }
}

/**
 * The flag: a tall pylon with a ring of markers showing the circle to fly, and
 * a gap in that ring on the side you are meant to enter from.
 */
function flagPylon(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  height: number,
  radius: number,
  direction: 1 | -1,
): void {
  m.cylinder(cx, cz, 0, height, 0.22, 14, 0.9, 0.25, 0.15);
  m.cylinder(cx, cz, height * 0.55, height * 0.75, 0.26, 14, 0.98, 0.98, 0.98);
  obs.push({ kind: 'cylinder', north: north(cz), east: east(cx), radius: 0.3, height });

  // Markers round the turn, spaced so the direction reads: they get taller the
  // way you are meant to go, which is legible from the air without a legend.
  const count = 12;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const px = cx + Math.cos(a) * radius;
    const pz = cz + Math.sin(a) * radius;
    const along = direction > 0 ? i / count : 1 - i / count;
    const h = 0.25 + along * 0.85;
    m.cylinder(px, pz, 0, h, 0.07, 6, 0.95, 0.75, 0.15);
    obs.push({ kind: 'cylinder', north: north(pz), east: east(px), radius: 0.12, height: h });
  }
}

function pylon(m: MeshBuilder, obs: Obstacle[], cx: number, cz: number, height: number): void {
  m.cylinder(cx, cz, 0, height, 0.18, 12, 0.9, 0.45, 0.1);
  m.cylinder(cx, cz, height * 0.45, height * 0.55, 0.2, 12, 0.95, 0.95, 0.95);
  obs.push({ kind: 'cylinder', north: north(cz), east: east(cx), radius: 0.24, height });
}

/** An open field with a landing pad. Somewhere to learn hovering and turns. */
export const openField: Track = {
  name: 'Open field',
  start: { north: 0, east: 0, yawDeg: 0 },
  build(m, obs) {
    ground(m);
    m.groundQuad(-6, -6, 6, 6, 0.02, ...TARMAC);
    m.groundQuad(-0.6, -0.6, 0.6, 0.6, 0.03, 0.9, 0.9, 0.2);
    // A few distant markers, purely for orientation.
    for (const [x, z] of [
      [40, 0],
      [-40, 0],
      [0, 40],
      [0, -40],
    ] as [number, number][]) {
      pylon(m, obs, x, z, 4);
    }
  },
};

/** Straight line of gates. The first thing worth practising after hovering. */
export const gateRun: Track = {
  name: 'Gate run',
  start: { north: -30, east: 0, yawDeg: 0 },
  build(m, obs) {
    ground(m);
    m.groundQuad(-2.5, -40, 2.5, 60, 0.01, ...TARMAC);
    // Staggered left and right, and at varying heights. Seven identical gates
    // in a straight line at one height nest perfectly behind each other: the
    // geometry is right and the scene is useless, because a pilot sees one
    // gate. Offsetting them makes the run readable and makes it a better
    // exercise than flying in a straight line.
    const offsets = [0, 2.2, -2.4, 2.6, -2.2, 1.8, 0];
    const heights = [2.6, 3.0, 2.3, 3.3, 2.5, 2.9, 2.6];
    for (let i = 0; i < offsets.length; i++) {
      // Track runs north; render z is -north, so gates march toward -z.
      const z = -(-20 + i * 14);
      gate(m, obs, offsets[i]!, z, 3.2, heights[i]!, 'x', i % 2 === 0 ? GATE_A : GATE_B);
    }
    pylon(m, obs, 12, 20, 5);
    pylon(m, obs, -12, -20, 5);
    pylon(m, obs, 14, -34, 5);
  },
};

/** A loop with gates at varying heights and a couple of turns. */
export const circuit: Track = {
  name: 'Circuit',
  start: { north: -34, east: 0, yawDeg: 0 },
  build(m, obs) {
    ground(m);
    const gates: [number, number, number, 'x' | 'z'][] = [
      [0, 30, 2.6, 'x'],
      [0, 10, 3.4, 'x'],
      [0, -10, 2.2, 'x'],
      [14, -26, 2.8, 'z'],
      [30, -14, 3.0, 'x'],
      [30, 8, 2.4, 'x'],
      [16, 26, 3.2, 'z'],
      [-16, 26, 3.2, 'z'],
      [-30, 8, 2.4, 'x'],
      [-30, -14, 3.0, 'x'],
      [-14, -26, 2.8, 'z'],
    ];
    gates.forEach(([x, z, h, along], i) => {
      gate(m, obs, x, z, 3.2, h, along, i % 2 === 0 ? GATE_A : GATE_B);
    });
    for (const [x, z] of [
      [22, 22],
      [-22, 22],
      [22, -22],
      [-22, -22],
    ] as [number, number][]) {
      pylon(m, obs, x, z, 6);
    }

    // Freestyle furniture. The gates are a line to fly; these are things to
    // play with, and to have opinions about — which is what they are here for.
    lightPole(m, obs, 8, 34, 11);
    lightPole(m, obs, -8, 34, 11);
    lightPole(m, obs, 36, -2, 13);
    lightPole(m, obs, -36, -2, 13);
    lightPole(m, obs, 0, -40, 9);

    // A tube on the main straight, and one across it high up.
    // Kept short: at 7 m long a 3 m bore is a tunnel rather than an obstacle,
    // and it reads from the outside as a solid disc until you are close.
    flyTube(m, obs, 0, 4.5, 0, 1.55, 2.2, 'z');
    flyTube(m, obs, -24, 9, 18, 1.8, 2, 'x');

    // Windows: one low enough to thread on the straight, two high.
    squareFrame(m, obs, 22, 5.5, 4, 1.8, 'x', GATE_B);
    squareFrame(m, obs, -20, 12, -12, 2.4, 'z', GATE_A);
    squareFrame(m, obs, 6, 16, 30, 2.6, 'z', GATE_B);
  },
};

/**
 * The race course, drawn from the same checkpoint list the timer uses.
 *
 * Not a second copy of the layout: `sixGateCourse` is the single source, so a
 * gate cannot be drawn somewhere the timer will not accept, which is the whole
 * class of bug that makes a race feel broken.
 */
export const raceField: Track = {
  name: 'Race — six gates',
  start: sixGateCourse.start,
  build(m, obs) {
    ground(m);
    m.groundQuad(-6, -6, 6, 6, 0.02, ...TARMAC);

    sixGateCourse.checkpoints.forEach((cp, i) => {
      const colour = i % 2 === 0 ? GATE_A : GATE_B;
      if (cp.kind === 'gate') {
        // NED to render: x = east, z = -north.
        const cx = cp.east;
        const cz = -cp.north;
        // The gate's direction is horizontal in NED; a gate faces across it.
        const alongZ = Math.abs(cp.dirN) > Math.abs(cp.dirE);
        raceGate(m, obs, cx, cz, cp.up, cp.halfWidth, cp.halfHeight, alongZ ? 'x' : 'z', colour, i + 1);
      } else {
        flagPylon(m, obs, cp.east, -cp.north, cp.height, cp.radius, cp.direction);
      }
    });
  },
};

export const TRACKS: Track[] = [raceField, openField, gateRun, circuit];
