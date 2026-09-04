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
import { courseFromSpec, type TrackSpec } from './track-spec.ts';
import {
  circleCourse,
  CUBE_HALF,
  DOUBLE_CUBE,
  GATE_HALF_H,
  GATE_HALF_W,
  GATE_UP,
  SINGLE_CUBE,
  type CubeSpec,
  oneEightyCourse,
  raceVibesCourse,
  thrustCourse,
  type Course,
} from '../race/course.ts';

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
  /**
   * The race course this map carries, if any. A race belongs to a map: the
   * checkpoints have to be the gates that are actually standing there, or the
   * markers point at thin air.
   */
  course?: Course;
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
 * A rail between two points, drawn as a tube and collided as a run of boxes.
 *
 * It was a rectangular beam, which read as a plank rather than as the tubing a
 * real gate is welded from — and where a plank met a round post there was a
 * visible corner. A rod of the same radius as the posts buries its ends inside
 * them, so the frame reads as one continuous piece.
 *
 * Contact stays a run of axis-aligned boxes, because it does not care what the
 * rail looks like and a box round a diagonal one would be a large invisible
 * wall. An axis-aligned rail is exactly one box; only a diagonal needs three.
 */
function rail(
  m: MeshBuilder,
  obs: Obstacle[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  colour: readonly [number, number, number],
): void {
  m.rod([ax, ay, az], [bx, by, bz], radius, 12, colour[0]!, colour[1]!, colour[2]!);

  const dx = bx - ax;
  const dz = bz - az;
  const segments = Math.abs(dx) < 1e-6 || Math.abs(dz) < 1e-6 ? 1 : 3;
  for (let i = 0; i < segments; i++) {
    const f0 = i / segments;
    const f1 = (i + 1) / segments;
    const x0 = ax + dx * f0;
    const z0 = az + dz * f0;
    const x1 = ax + dx * f1;
    const z1 = az + dz * f1;
    obs.push({
      kind: 'box',
      minNorth: north(Math.max(z0, z1) + radius),
      maxNorth: north(Math.min(z0, z1) - radius),
      minEast: east(Math.min(x0, x1) - radius),
      maxEast: east(Math.max(x0, x1) + radius),
      minUp: Math.min(ay, by) - radius,
      maxUp: Math.max(ay, by) + radius,
    });
  }
}

/**
 * A banded upright, like the flag poles — and for the same reason as well as
 * the look: a plain column gives no sense of how far away it is or how fast you
 * are closing on it, and the bands give both. Yellow and white on a race gate,
 * since the gate's own colour is yellow and red belongs to the wrong-way marker.
 */
function bandedPost(
  m: MeshBuilder,
  obs: Obstacle[],
  px: number,
  pz: number,
  base: number,
  top: number,
  radius: number,
  hitRadius: number,
  colour: readonly [number, number, number],
): void {
  const span = top - base;
  const bands = Math.max(3, Math.round(span / 0.75));
  for (let i = 0; i < bands; i++) {
    const y0 = base + (i / bands) * span;
    const y1 = base + ((i + 1) / bands) * span;
    const c: readonly [number, number, number] = i % 2 === 0 ? colour : [0.97, 0.97, 0.97];
    m.cylinder(px, pz, y0, y1, radius, 12, c[0]!, c[1]!, c[2]!);
  }
  obs.push({ kind: 'cylinder', north: north(pz), east: east(px), radius: hitRadius, height: top });
}

/**
 * A race gate, at any heading, in MultiGP proportions.
 *
 * Two things this used to get wrong, both found by flying the circle:
 *
 *  - **It snapped to an axis.** The old signature took `'x' | 'z'`, so a gate
 *    facing 54 degrees was drawn facing 90. The next-checkpoint marker is built
 *    from the true direction, which is why the marker looked tilted relative to
 *    the gate — the marker was right and the gate was wrong.
 *  - **It read the direction out of `raceVibesCourse` by index.** Harmless while
 *    there was one race map; wrong on every gate of the three added after it.
 *    The direction is a parameter now, which is what it always should have been.
 */
function raceGate(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  up: number,
  halfWidth: number,
  halfHeight: number,
  /** Direction of travel through the gate, NED. */
  dirN: number,
  dirE: number,
  colour: readonly [number, number, number],
  /** Counting blocks beside the gate; 0 draws none, as on the practice map. */
  number: number,
  /** +1 or -1 to leave that post out, because a flag pole stands there. */
  skipSide: 0 | 1 | -1 = 0,
): void {
  // Proportions from a MultiGP gate: 3" tube round a 5 ft aperture, so the
  // frame stays in scale when the aperture changes.
  const postR = halfWidth * 0.065;
  const hitR = postR + 0.06;
  // The rails are the same tube as the posts. Equal radii is what makes the
  // corner disappear: the post's end cap sits inside the rail's surface.
  const bar = postR;
  const top = up + halfHeight;
  const bottom = Math.max(0.05, up - halfHeight);

  // Across the aperture, in render space. Render x is east and z is -north, so
  // "right of travel" — which in NED is (-dirE, dirN) — comes out as
  // (dirN, dirE). Same vector the checkpoint marker uses, which is the point.
  const rx = dirN;
  const rz = dirE;
  const rightX = cx + rx * halfWidth;
  const rightZ = cz + rz * halfWidth;
  const leftX = cx - rx * halfWidth;
  const leftZ = cz - rz * halfWidth;

  // The rails sit clear of the aperture rather than hanging into it: the top
  // rail's underside is at the top of the opening and the bottom rail's crown
  // at the bottom of it, so the hole a pilot sees is the hole the timer uses.
  const railY = top + bar;
  const railYBottom = bottom - bar;
  // The uprights run to the rail centres, so the rail's end caps are buried
  // inside them and the corner has no seam.
  const postTop = railY;

  if (skipSide !== 1) bandedPost(m, obs, rightX, rightZ, 0, postTop, postR, hitR, colour);
  if (skipSide !== -1) bandedPost(m, obs, leftX, leftZ, 0, postTop, postR, hitR, colour);

  // Rails between the post axes, so the joints interpenetrate rather than butt.
  rail(m, obs, leftX, railY, leftZ, rightX, railY, rightZ, bar, colour);
  if (railYBottom - bar > 0.06) {
    rail(m, obs, leftX, railYBottom, leftZ, rightX, railYBottom, rightZ, bar, colour);
  }

  // Direction chevron on the ground, pointing the way through.
  const dx = dirE;
  const dz = -dirN;
  for (let i = 0; i < 3; i++) {
    const t = 0.7 + i * 0.75;
    const px = cx + dx * t;
    const pz = cz + dz * t;
    const w = 0.4 - i * 0.08;
    m.groundQuad(px - w, pz - w, px + w, pz + w, 0.015 + i * 0.001, colour[0]!, colour[1]!, colour[2]!);
  }

  // Gate number: that many small blocks stacked beside the left post.
  const bx = leftX - rx * 0.5;
  const bz = leftZ - rz * 0.5;
  for (let i = 0; i < number; i++) {
    const y = 0.12 + i * 0.28;
    m.slab(bx - 0.11, y, bz - 0.11, bx + 0.11, y + 0.19, bz + 0.11, 0.95, 0.95, 0.98);
  }
}

/**
 * The flag: a tall striped pylon, with a marker on the ground on the side you
 * are meant to pass. No ring — a circle drawn round it invited a pilot to fly
 * the circle, which was never the rule.
 */
function flagPylon(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  height: number,
  dirN: number,
  dirE: number,
  side: 1 | -1,
  passWidth: number,
): void {
  // Striped yellow and white rather than the traditional red and white, for the
  // same reason the gates are yellow: red belongs to the wrong-way marker here,
  // and two of these poles are literally one side of a gate.
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const y0 = (i / bands) * height;
    const y1 = ((i + 1) / bands) * height;
    const c: [number, number, number] = i % 2 === 0 ? [0.95, 0.75, 0.15] : [0.97, 0.97, 0.97];
    m.cylinder(cx, cz, y0, y1, 0.24, 14, c[0], c[1], c[2]);
  }
  obs.push({ kind: 'cylinder', north: north(cz), east: east(cx), radius: 0.32, height });

  // Ground stripe on the passing side, along the direction of travel.
  const dx = dirE;
  const dz = -dirN;
  const rx = dirN;
  const rz = dirE;
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) * 1.5;
    const off = passWidth * 0.6 * side;
    const px = cx + rx * off + dx * t;
    const pz = cz + rz * off + dz * t;
    m.groundQuad(px - 0.35, pz - 0.35, px + 0.35, pz + 0.35, 0.016, 0.95, 0.75, 0.15);
  }
}

function pylon(m: MeshBuilder, obs: Obstacle[], cx: number, cz: number, height: number): void {
  m.cylinder(cx, cz, 0, height, 0.18, 12, 0.9, 0.45, 0.1);
  m.cylinder(cx, cz, height * 0.45, height * 0.55, 0.2, 12, 0.95, 0.95, 0.95);
  obs.push({ kind: 'cylinder', north: north(cz), east: east(cx), radius: 0.24, height });
}

/**
 * A ladder: two uprights and a stack of rungs, each gap a window.
 *
 * The trick it exists for is climbing it — through the bottom gap, over the
 * top, back through the next one up, and so on. That means the gaps have to be
 * generous enough to take at speed but close enough together that the loop
 * between them is tight, which is the whole exercise.
 */
function ladder(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  along: 'x' | 'z',
  width: number,
  gaps: number,
  gap: number,
  base: number,
): void {
  const half = width / 2;
  const railR = 0.11;
  const rung = 0.1;
  const top = base + gaps * gap;
  const railX = (s: number): number => (along === 'x' ? cx + s * half : cx);
  const railZ = (s: number): number => (along === 'x' ? cz : cz + s * half);
  for (const s of [-1, 1]) {
    m.cylinder(railX(s), railZ(s), 0, top, railR, 10, 0.75, 0.5, 0.2);
    obs.push({
      kind: 'cylinder',
      north: north(railZ(s)),
      east: east(railX(s)),
      radius: railR + 0.06,
      height: top,
    });
  }
  for (let i = 0; i <= gaps; i++) {
    const y = base + i * gap;
    if (along === 'x') {
      solid(m, obs, cx - half, y - rung, cz - rung, cx + half, y + rung, cz + rung, [0.85, 0.6, 0.25]);
    } else {
      solid(m, obs, cx - rung, y - rung, cz - half, cx + rung, y + rung, cz + half, [0.85, 0.6, 0.25]);
    }
  }
}

/**
 * A chimney: a square shaft held up in the air, open top and bottom.
 *
 * Dived rather than flown through — enter over the top, out of the bottom, and
 * the thing that makes it hard is that you cannot see the exit until you are
 * committed. Raised on legs so the bottom is an exit rather than the floor.
 */
function chimney(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  bore: number,
  base: number,
  height: number,
): void {
  const half = bore / 2;
  const wall = 0.18;
  const top = base + height;
  const brick: [number, number, number] = [0.55, 0.3, 0.26];
  // Four walls round the bore. Boxes rather than a tube, because a square
  // shaft reads as a chimney and a round one reads as the tubes already here.
  solid(m, obs, cx - half - wall, base, cz - half - wall, cx + half + wall, top, cz - half, brick);
  solid(m, obs, cx - half - wall, base, cz + half, cx + half + wall, top, cz + half + wall, brick);
  solid(m, obs, cx - half - wall, base, cz - half, cx - half, top, cz + half, brick);
  solid(m, obs, cx + half, base, cz - half, cx + half + wall, top, cz + half, brick);
  // Legs at the corners, clear of the bore.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = cx + sx * (half + wall / 2);
      const lz = cz + sz * (half + wall / 2);
      m.cylinder(lx, lz, 0, base, 0.09, 8, 0.45, 0.47, 0.5);
      obs.push({ kind: 'cylinder', north: north(lz), east: east(lx), radius: 0.15, height: base });
    }
  }
}

/**
 * A round chimney: a vertical shaft you drop down and come out of the bottom.
 *
 * The square one on the freestyle map is four walls and reads as masonry. This
 * is a pipe, and it flies differently — there is no corner to catch a prop on,
 * so the whole aperture is usable and the only question is whether you are
 * straight when you commit.
 *
 * Raised on legs, because a shaft standing on the ground is a hole with no
 * exit. Collision is a single upright ring, which is what the `'up'` axis on
 * `Ring` was added for.
 */
function roundChimney(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  radius: number,
  base: number,
  height: number,
  colour: readonly [number, number, number],
): void {
  const thickness = 0.16;
  const top = base + height;
  m.shaft(cx, cz, base, top, radius, thickness, 22, colour[0]!, colour[1]!, colour[2]!);
  obs.push({
    kind: 'ring',
    north: north(cz),
    east: east(cx),
    up: (base + top) / 2,
    radius,
    thickness,
    halfLength: height / 2,
    axis: 'up',
  });
  // Legs at the compass points, outside the bore.
  for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const lx = cx + Math.cos(a) * (radius + thickness * 0.5);
    const lz = cz + Math.sin(a) * (radius + thickness * 0.5);
    m.cylinder(lx, lz, 0, base, 0.09, 8, 0.45, 0.47, 0.5);
    obs.push({ kind: 'cylinder', north: north(lz), east: east(lx), radius: 0.15, height: base });
  }
}

/**
 * A semicircular arch, built from quads round the arc rather than from
 * axis-aligned boxes.
 *
 * Boxes would have made a staircase, which is what an arch must not look like;
 * `quadColored` takes arbitrary corners, so the drawn surface follows the curve
 * exactly. Collision stays a box per segment, because contact does not care
 * what it looks like and an AABB per segment is a close enough fit to a
 * quarter-metre of arc.
 */
function arch(
  m: MeshBuilder,
  obs: Obstacle[],
  cx: number,
  cz: number,
  radius: number,
  halfDepth: number,
  thickness: number,
  along: 'x' | 'z',
  colour: readonly [number, number, number],
  segments = 18,
): void {
  type P = [number, number, number];
  // A point on the arc, at radius `rad`, offset `off` along the depth axis.
  const at = (t: number, rad: number, off: number): P =>
    along === 'x'
      ? [cx + Math.cos(t) * rad, Math.sin(t) * rad, cz + off]
      : [cx + off, Math.sin(t) * rad, cz + Math.cos(t) * rad];
  const shade = (f: number): [number, number, number] =>
    [colour[0]! * f, colour[1]! * f, colour[2]! * f];

  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI;
    const t1 = ((i + 1) / segments) * Math.PI;
    const outer = radius + thickness;
    const pts: P[] = [
      at(t0, radius, -halfDepth), at(t1, radius, -halfDepth),
      at(t1, outer, -halfDepth), at(t0, outer, -halfDepth),
      at(t0, radius, halfDepth), at(t1, radius, halfDepth),
      at(t1, outer, halfDepth), at(t0, outer, halfDepth),
    ];
    const [a, b, c, d, e, f, g2, h] = pts as [P, P, P, P, P, P, P, P];
    m.quadColored(d, c, g2, h, shade(1), shade(1), shade(1), shade(1));   // outer
    m.quadColored(e, f, b, a, shade(0.6), shade(0.6), shade(0.6), shade(0.6)); // inner (soffit)
    m.quadColored(a, b, c, d, shade(0.8), shade(0.8), shade(0.8), shade(0.8)); // side
    m.quadColored(h, g2, f, e, shade(0.8), shade(0.8), shade(0.8), shade(0.8)); // side
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
    }
    obs.push({
      kind: 'box',
      minNorth: north(maxZ),
      maxNorth: north(minZ),
      minEast: east(minX),
      maxEast: east(maxX),
      minUp: minY,
      maxUp: maxY,
    });
  }
}

/**
 * The freestyle map: a loop of gates to carry speed round, and things to play
 * with in the middle of it.
 *
 * Was "Circuit", and the gates are unchanged — what turned it into a freestyle
 * map is everything that is not a gate. There is no course on it and no timer:
 * that is the point of keeping one map where nothing is being measured.
 *
 * Two tracks were removed when this arrived. "Open field" was four pylons and a
 * landing pad, which is what an empty scene looks like once there is anywhere
 * better to go; "Gate run" was a staggered line, which the thrust line now does
 * properly and times.
 */
export const freestyle: Track = {
  name: 'Freestyle',
  start: { north: -34, east: 0, yawDeg: 0 },
  build(m, obs) {
    ground(m);
    // Positions in render space, flown as a loop. Same MultiGP aperture as
    // every race gate — a gate you can fly at any width teaches nothing about
    // the one you cannot — and the heading of each comes from the next in the
    // list, so the ground chevrons show the way round rather than a guess.
    const loop: [number, number, number][] = [
      [0, 30, GATE_UP],
      [0, 10, GATE_UP],
      [0, -10, GATE_UP + 1.2],
      [14, -26, GATE_UP],
      [30, -14, GATE_UP],
      [30, 8, GATE_UP + 1.5],
      [16, 26, GATE_UP],
      [-16, 26, GATE_UP],
      [-30, 8, GATE_UP + 1.5],
      [-30, -14, GATE_UP],
      [-14, -26, GATE_UP],
    ];
    loop.forEach(([x, z, h], i) => {
      const next = loop[(i + 1) % loop.length]!;
      // Render to NED for the direction: north is -z, east is x.
      const dn = -(next[1] - z);
      const de = next[0] - x;
      const len = Math.hypot(dn, de) || 1;
      raceGate(
        m, obs, x, z, h, GATE_HALF_W, GATE_HALF_H,
        dn / len, de / len,
        i % 2 === 0 ? GATE_A : GATE_B,
        0,
      );
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

    // Ladders. Four gaps each, and they face across the loop rather than along
    // it, so climbing one takes you out of the racing line and back into it.
    ladder(m, obs, -40, 14, 'z', 4.4, 4, 3.2, 2.4);
    ladder(m, obs, 40, 14, 'z', 4.4, 4, 3.2, 2.4);
    ladder(m, obs, 24, -38, 'x', 5.0, 3, 3.6, 3.0);

    // Chimneys, for dives. The tall one is the commitment: 18 m of shaft with
    // the exit out of sight until halfway down.
    chimney(m, obs, -12, 0, 3.0, 5, 18);
    chimney(m, obs, 18, 16, 3.4, 4, 11);

    // Arches. One over the main straight so it can be taken at speed, one out
    // wide and tall enough to roll through, and a small one across the loop.
    arch(m, obs, 0, -18, 7, 1.2, 0.5, 'x', [0.8, 0.78, 0.72]);
    arch(m, obs, -34, -22, 9, 1.4, 0.55, 'z', [0.72, 0.7, 0.68]);
    arch(m, obs, 34, 30, 5.5, 1.0, 0.45, 'z', [0.8, 0.78, 0.72]);

    // A block of cubes, joined side to side and stacked in floors.
    //
    // Deliberately a *block* rather than three cubes standing apart: the
    // interesting flying is the line that goes through several of them without
    // coming out, and that only exists when the faces line up. Adjacent cubes
    // share a post position, so the frame reads as one structure.
    //
    // Off to the east of the loop, clear of the ladders and the far gates, so
    // it is somewhere to go rather than something to dodge on the racing line.
    const cs = CUBE_HALF;
    const side = cs * 2;
    const blockE = 46;
    const blockN = -6;
    const heights = [
      [1, 2, 1],
      [2, 3, 2],
      [1, 2, 1],
    ];
    heights.forEach((row, r) => {
      row.forEach((storeys, c) => {
        cube(
          m,
          obs,
          {
            north: blockN + (1 - r) * side,
            east: blockE + (c - 1) * side,
            half: cs,
            storeys,
          },
          (r + c) % 2 === 0 ? GATE_B : GATE_A,
        );
      });
    });
  },
};

/**
 * A cube: four square openings, one on each side, built from the same tube as
 * the gates.
 *
 * A square rather than the gate's wider aperture, because the point of a cube
 * is that every face is the same — you can take it on any heading, and which
 * way you leave is a choice rather than something the shape decides for you.
 * The side is the gate's *height*, so a face is as tall as a gate is and
 * noticeably narrower, which is what makes it read as a different obstacle
 * rather than as a gate with extra sides.
 *
 * `storeys` stacks them sharing their rings, so a two-floor cube is one piece
 * of scenery with an upper and a lower line through it rather than two cubes
 * standing on each other.
 *
 * Not a checkpoint. It is scenery on Race vibes for now, deliberately outside
 * the course order, so a line through it can be worked out by flying before
 * anything is timed through it.
 */
function cube(
  m: MeshBuilder,
  obs: Obstacle[],
  spec: CubeSpec,
  colour: readonly [number, number, number],
): void {
  // NED to render, from the same spec the course routes through.
  const cx = spec.east;
  const cz = -spec.north;
  const half = spec.half;
  const storeys = spec.storeys;
  const radius = half * 0.085;
  const hitR = radius + 0.06;
  const side = half * 2;
  const top = side * storeys;
  const corners: [number, number][] = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
  ];

  // Four uprights, full height, banded like a gate's.
  for (const [px, pz] of corners) {
    bandedPost(m, obs, px, pz, 0, top, radius, hitR, colour);
  }

  // A ring at every floor, including the ground one — the bottom rails are what
  // stop a cube reading as four poles from a distance. The ground ring sits a
  // rail's width up so it is a rail rather than a kerb.
  for (let level = 0; level <= storeys; level++) {
    const y = level === 0 ? radius * 2 : side * level;
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      rail(m, obs, a[0], y, a[1], b[0], y, b[1], radius, colour);
    }
  }
}

/**
 * Freestyle hard: the same idea as Freestyle with the training wheels off.
 *
 * Where that map is a loop with things beside it, this one is vertical. Towers
 * of cubes to thread rather than fly round, poles at heights that make you
 * choose over or under, round chimneys to drop, and gates and ladders high
 * enough that reaching them is half the trick. No course and no timer — the
 * point is a playground, and a clock would turn it into a queue.
 *
 * Laid out in three bands rather than a circuit, so a pilot picks a direction
 * and commits: towers to the north, chimneys and poles through the middle, the
 * high stuff to the south.
 */
export const freestyleHard: Track = {
  name: 'Freestyle hard',
  start: { north: -60, east: 0, yawDeg: 0 },
  build(m, obs) {
    ground(m);
    m.groundQuad(-8, 52, 8, 68, 0.02, ...TARMAC);

    const cs = CUBE_HALF;
    const side = cs * 2;

    // Towers. Height is the difficulty: a four-storey tower is a wall with
    // holes in it, and the line through one is a commitment made on entry.
    const towers: [number, number, number][] = [
      [-26, 26, 4],
      [-18, 34, 6],
      [-8, 26, 3],
      [2, 36, 5],
      [12, 26, 4],
      [22, 34, 6],
      [30, 26, 3],
    ];
    for (const [x, z, storeys] of towers) {
      cube(m, obs, { north: north(z), east: east(x), half: cs, storeys }, storeys % 2 ? GATE_A : GATE_B);
    }
    // Two of them joined, so there is one line that runs through both.
    cube(m, obs, { north: north(34), east: east(-18) - side, half: cs, storeys: 6 }, GATE_B);

    // Poles at every height, close enough together that going over one puts
    // you under the next. The tallest is deliberately taller than anything
    // else here — it is the thing you orient by from the far end.
    const poles: [number, number, number][] = [
      [-34, 6, 7],
      [-24, -2, 14],
      [-14, 8, 4],
      [-4, -6, 20],
      [6, 6, 9],
      [16, -2, 26],
      [26, 8, 5],
      [34, -4, 12],
    ];
    for (const [x, z, h] of poles) lightPole(m, obs, x, z, h);

    // Round chimneys. Three sizes at three heights: the tight one is a dive
    // you line up from above, the wide one you can take at speed.
    roundChimney(m, obs, -20, -18, 1.5, 6, 12, [0.62, 0.36, 0.3]);
    roundChimney(m, obs, 0, -14, 2.2, 4, 9, [0.55, 0.42, 0.34]);
    roundChimney(m, obs, 20, -20, 1.2, 10, 14, [0.62, 0.36, 0.3]);

    // High gates: the same aperture as a race gate, up where you have to climb
    // to it. Alternating headings so a run through them is a corkscrew.
    const high: [number, number, number, number, number][] = [
      [-28, -34, 6, 1, 0],
      [-14, -40, 10, 0, 1],
      [0, -34, 14, 1, 0],
      [14, -40, 9, 0, -1],
      [28, -34, 5, -1, 0],
    ];
    high.forEach(([x, z, up, dn, de], i) => {
      raceGate(m, obs, x, z, up, GATE_HALF_W, GATE_HALF_H, dn, de, i % 2 ? GATE_A : GATE_B, 0);
    });

    // Ladders, tall. Climbing one is the exercise; the gaps are the windows.
    ladder(m, obs, -36, -30, 'z', 4.6, 6, 3.4, 3.0);
    ladder(m, obs, 36, -30, 'z', 4.6, 6, 3.4, 3.0);
    ladder(m, obs, 8, -52, 'x', 5.2, 5, 3.8, 4.0);

    // One arch over the start, so the first thing a pilot does is go through
    // something.
    arch(m, obs, 0, 46, 8, 1.3, 0.5, 'x', [0.8, 0.78, 0.72]);
  },
};

/**
 * Draw a course's own checkpoints as scenery.
 *
 * The single source is the checkpoint list the timer reads, so a gate cannot be
 * drawn somewhere the timer will not accept it — the whole class of bug that
 * makes a race feel broken. Every race map goes through here, which is also why
 * a new course is a list of coordinates rather than a new pile of geometry.
 */
function raceScenery(m: MeshBuilder, obs: Obstacle[], course: Course): void {
  const cps = course.checkpoints;
  let drawn = 0;
  cps.forEach((cp) => {
    // Every race gate is yellow, deliberately. The next-checkpoint marker says
    // green or red, and alternating red and yellow gates put a large red
    // structure next to a small red warning — the one colour that has to mean
    // "wrong way" cannot also mean "gate". Gates are told apart by the counting
    // blocks beside them, not by colour.
    const colour = GATE_B;
    if (cp.kind === 'gate') {
      // Some checkpoints only name an opening in scenery that is already
      // standing — the faces and floors of a cube. Drawing a gate frame there
      // would put a gate inside the cube it belongs to.
      if (cp.frame === 'none') return;
      // NED to render: x = east, z = -north.
      const cx = cp.east;
      const cz = -cp.north;
      // If a flag stands where one of this gate's posts would be, that post is
      // the flag pole — skip it here and let the pylon draw it, or the two end
      // up inside each other.
      const attached = cps.find(
        (o) =>
          o.kind === 'flag' &&
          Math.hypot(o.north - cp.north, o.east - cp.east) < cp.halfWidth + 0.2,
      );
      const skipSide = attached
        ? // Which post: positive across is right of the direction of travel.
          -(attached.north - cp.north) * cp.dirE + (attached.east - cp.east) * cp.dirN > 0
          ? 1
          : -1
        : 0;
      drawn++;
      raceGate(
        m, obs, cx, cz, cp.up, cp.halfWidth, cp.halfHeight,
        cp.dirN, cp.dirE, colour, drawn, skipSide,
      );
    } else {
      flagPylon(m, obs, cp.east, -cp.north, cp.height, cp.dirN, cp.dirE, cp.side, cp.passWidth);
    }
  });
}

/**
 * The original race course: six gates and three flags on an open field.
 *
 * Renamed from "Race — six gates" once there were four race maps and the count
 * stopped being the interesting thing about it. It is the mixed one — gates,
 * flags, a flag that *is* a gate post, and turns in both directions.
 */
export const raceField: Track = {
  name: 'Race vibes',
  course: raceVibesCourse,
  start: raceVibesCourse.start,
  build(m, obs) {
    ground(m);
    m.groundQuad(-6, -6, 6, 6, 0.02, ...TARMAC);
    raceScenery(m, obs, raceVibesCourse);

    // Both cubes are on the course now — dropped into from above after gate 2,
    // and climbed after gate 5. They are drawn from the same specs the
    // checkpoints are built from, so the hole the timer wants and the hole that
    // is there are the same hole.
    cube(m, obs, SINGLE_CUBE, GATE_B);
    cube(m, obs, DOUBLE_CUBE, GATE_B);
  },
};

/**
 * Forty gates in two straight lines with a pole to turn round.
 *
 * The tarmac strips under each line are load-bearing rather than decoration:
 * over 280 m of chequered grass there is nothing to judge closing speed
 * against, and a thrust run is exactly the case where that matters.
 */
export const thrustLine: Track = {
  name: 'Thrust line',
  course: thrustCourse,
  start: thrustCourse.start,
  build(m, obs) {
    ground(m, 320, 8);
    m.groundQuad(-11, -165, -5, 165, 0.01, ...TARMAC);
    m.groundQuad(5, -165, 11, 165, 0.01, ...TARMAC);
    raceScenery(m, obs, thrustCourse);
    // Distance markers down the outside, so the run has a sense of progress
    // that twenty identical gates on their own do not give.
    for (let z = -150; z <= 150; z += 25) pylon(m, obs, -22, z, 3.5);
    for (let z = -150; z <= 150; z += 25) pylon(m, obs, 22, z, 3.5);
  },
};

/** Twenty gates round a 60 m circle. A lap is the circle. */
export const circleTrack: Track = {
  name: 'Circle',
  course: circleCourse,
  start: circleCourse.start,
  build(m, obs) {
    ground(m);
    // The racing line, painted. A circle of gates with nothing between them
    // gives no cue at all about whether the radius is holding.
    const R = 60;
    const seg = 72;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const inner = R - 2.5;
      const outer = R + 2.5;
      m.quadColored(
        [Math.sin(a0) * inner, 0.01, -Math.cos(a0) * inner],
        [Math.sin(a1) * inner, 0.01, -Math.cos(a1) * inner],
        [Math.sin(a1) * outer, 0.01, -Math.cos(a1) * outer],
        [Math.sin(a0) * outer, 0.01, -Math.cos(a0) * outer],
        TARMAC, TARMAC, TARMAC, TARMAC,
      );
    }
    raceScenery(m, obs, circleCourse);
    // A mast at the centre. On a circle there is no horizon feature that stays
    // put, and without one it is genuinely hard to tell a circle from a spiral.
    lightPole(m, obs, 0, 0, 16);
  },
};

/** Two combs of ten gates: through one, hard 180, back through the next. */
export const oneEightyTrack: Track = {
  name: '180s',
  course: oneEightyCourse,
  start: oneEightyCourse.start,
  build(m, obs) {
    ground(m);
    // A strip under each row, running the length of it.
    m.groundQuad(-60, -4, 60, 4, 0.01, ...TARMAC);
    m.groundQuad(-60, 51, 60, 59, 0.01, ...TARMAC);
    raceScenery(m, obs, oneEightyCourse);
    // Turn markers off each end, at the radius the row spacing implies.
    for (const x of [-66, 66]) {
      pylon(m, obs, x, 0, 4);
      pylon(m, obs, x, 55, 4);
    }
  },
};

/**
 * Build a `Track` from a spec.
 *
 * The point of the whole exercise is here: one entry in the spec produces the
 * mesh, the collision volume and — for a checkpoint — the timed plane, from a
 * single call. A track written by someone else cannot have a gate that is drawn
 * but not solid, or a marker over ground with no gate on it, because there is
 * nowhere for the two to disagree.
 *
 * Headings arrive as compass degrees and the helpers underneath take render
 * axes, so the conversion happens once, here.
 */
export function trackFromSpec(spec: TrackSpec): Track {
  const course = courseFromSpec(spec);
  // Which gate and flag pieces the course already covers. Everything else of
  // that kind is scenery: not every gate on a track is part of the race, and a
  // gate you fly through for its own sake is a perfectly good obstacle.
  const inCourse = new Set(spec.order ?? []);
  // The helpers below want a render axis rather than a heading, and every one
  // of them is axis-aligned. A heading nearer north than east spans x.
  const axisFor = (headingDeg = 0): 'x' | 'z' =>
    Math.abs(Math.cos((headingDeg * Math.PI) / 180)) > 0.5 ? 'x' : 'z';

  return {
    name: spec.name,
    ...(course ? { course } : {}),
    start: spec.start,
    build(m, obs) {
      ground(m);
      for (const p of spec.pieces ?? []) {
        // Spec is NED; the scene is x = east, z = -north.
        const cx = p.east;
        const cz = -p.north;
        switch (p.type) {
          case 'gate': {
            // Drawn here only when it is not in the order — a checkpoint's frame
            // comes from raceScenery below, so that the drawn gate and the timed
            // one are one object rather than two.
            if (p.id && inCourse.has(p.id)) break;
            const r = ((p.heading ?? 0) * Math.PI) / 180;
            raceGate(
              m, obs, cx, cz, p.up ?? GATE_UP, GATE_HALF_W, GATE_HALF_H,
              Math.cos(r), Math.sin(r), GATE_A, 0,
            );
            break;
          }
          case 'flag': {
            if (p.id && inCourse.has(p.id)) break;
            const r = ((p.heading ?? 0) * Math.PI) / 180;
            flagPylon(m, obs, cx, cz, p.height ?? 7, Math.cos(r), Math.sin(r), p.side, p.passWidth ?? 6);
            break;
          }
          case 'cube':
            cube(m, obs, { north: p.north, east: p.east, half: CUBE_HALF, storeys: p.storeys ?? 1 }, GATE_B);
            break;
          case 'pole':
            lightPole(m, obs, cx, cz, p.height);
            break;
          case 'pylon':
            pylon(m, obs, cx, cz, p.height);
            break;
          case 'ladder':
            ladder(m, obs, cx, cz, axisFor(p.heading), p.width ?? 4.6, p.gaps ?? 4, p.gap ?? 3.2, p.base ?? 2.4);
            break;
          case 'arch':
            arch(m, obs, cx, cz, p.radius, 1.2, 0.5, axisFor(p.heading), [0.8, 0.78, 0.72]);
            break;
          case 'chimney':
            chimney(m, obs, cx, cz, p.bore ?? 3, p.base ?? 4, p.height ?? 12);
            break;
          case 'roundChimney':
            roundChimney(m, obs, cx, cz, p.radius ?? 1.6, p.base ?? 5, p.height ?? 12, [0.62, 0.36, 0.3]);
            break;
          case 'tube':
            flyTube(m, obs, cx, p.up, cz, p.radius ?? 1.6, p.halfLength ?? 2.2, axisFor(p.heading));
            break;
          case 'window':
            squareFrame(m, obs, cx, p.up, cz, p.half ?? 2, axisFor(p.heading), GATE_A);
            break;
        }
      }
      if (course) raceScenery(m, obs, course);
    },
  };
}

export const TRACKS: Track[] = [
  raceField,
  thrustLine,
  circleTrack,
  oneEightyTrack,
  freestyle,
  freestyleHard,
];
