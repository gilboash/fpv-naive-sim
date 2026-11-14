/**
 * Buildings for the freestyle maps: industrial chimneys you dive into and fly
 * out of at the foot, and three kinds of hangar with holes in the roof.
 *
 * Same rule as the rest of the scenery: every call emits the drawn geometry and
 * its collision volumes together, so what you see is what you hit. Render space
 * throughout (x east, y up, z south); collision is NED, converted here.
 *
 * `quadColored` gives every face an upward normal, so the scene's lighting
 * cannot shade a curved surface. Round things here are shaded by hand: each
 * facet's colour is scaled by how far it faces the sun (`facing`).
 */
import type { MeshBuilder } from './mesh.ts';
import type { Obstacle } from '../flight/collision.ts';

type RGB = readonly [number, number, number];
type P = [number, number, number];

/** The sun's horizontal direction in render space, from the renderer's light vector (0.42, 0.82, 0.39). */
const SUN_ANGLE = Math.atan2(0.39, 0.42);
const facing = (a: number): number => 0.72 + 0.28 * Math.cos(a - SUN_ANGLE);
const mul = (c: RGB, f: number): [number, number, number] => [c[0] * f, c[1] * f, c[2] * f];

/** A render-space AABB as a collision box. */
function hit(obs: Obstacle[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  obs.push({
    kind: 'box',
    minNorth: -Math.max(z0, z1),
    maxNorth: -Math.min(z0, z1),
    minEast: Math.min(x0, x1),
    maxEast: Math.max(x0, x1),
    minUp: Math.min(y0, y1),
    maxUp: Math.max(y0, y1),
  });
}

/** A box, drawn (with real normals) and solid. */
function block(m: MeshBuilder, obs: Obstacle[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB): void {
  m.slab(x0, y0, z0, x1, y1, z1, c[0], c[1], c[2]);
  hit(obs, x0, y0, z0, x1, y1, z1);
}

/** Collision box around a set of points: for sloped and curved panels. */
function hitAround(obs: Obstacle[], pts: P[]): void {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
  }
  hit(obs, x0, y0, z0, x1, y1, z1);
}

/** A flat-shaded quad, both sides (the renderer does not cull, but winding is kept consistent). */
function face(m: MeshBuilder, a: P, b: P, c: P, d: P, col: RGB): void {
  m.quadColored(a, b, c, d, col, col, col, col);
}

// ---------------------------------------------------------------------------
// Industrial chimney
// ---------------------------------------------------------------------------

export interface StackSpec {
  /** Centre, render space. */
  x: number;
  z: number;
  /** Bore radius, m: the hole you dive into. */
  bore: number;
  /** Height, m. */
  height: number;
  /** Compass bearings of the flue openings at the foot, degrees (0 north, 90 east). */
  openings: number[];
  /** Opening width and height, m. */
  openW: number;
  openH: number;
  /** Red and white aviation bands round the top, as on a real tall stack. */
  bands?: boolean;
}

/**
 * An industrial chimney: a tapered round stack standing on the ground, open at
 * the top, with flue openings at the foot. Dive in the top, pull out at the
 * bottom of the bore and leave sideways through an opening.
 *
 * The bore is a constant radius (the walls thicken toward the base, as a real
 * stack's do), so the collision is a few stacked upright rings, the bottom one
 * carrying `gaps` for the openings.
 */
export function industrialChimney(m: MeshBuilder, obs: Obstacle[], s: StackSpec): void {
  const S = 36;
  const R = s.bore;
  const H = s.height;
  const wallBase = 0.35 + 0.12 * R;
  const wallTop = 0.22;
  const outer = (y: number): number => R + wallBase + (wallTop - wallBase) * (y / H);
  // Compass bearing to render angle: east = cos a, north = -sin a.
  const gapA = s.openings.map((deg) => {
    const b = (deg * Math.PI) / 180;
    return Math.atan2(-Math.cos(b), Math.sin(b));
  });
  const halfAngle = Math.asin(Math.min(0.95, s.openW / 2 / R));
  const inGap = (a: number): boolean =>
    gapA.some((g) => {
      let d = a - g;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      return Math.abs(d) < halfAngle;
    });

  const brick: RGB = [0.58, 0.34, 0.27];
  const red: RGB = [0.78, 0.17, 0.13];
  const white: RGB = [0.9, 0.9, 0.88];
  const soot: RGB = [0.16, 0.14, 0.13];
  const colourAt = (y: number): RGB => {
    if (s.bands && y > H * 0.72) return Math.floor((y - H * 0.72) / (H * 0.056)) % 2 === 0 ? red : white;
    // Weathered: a touch darker toward the top, where the smoke goes.
    return mul(brick, 1 - 0.18 * (y / H));
  };

  // Height bands to draw: the opening line, then courses up to the top.
  const levels: number[] = [0, s.openH];
  const course = s.bands ? H * 0.056 : H / 8;
  for (let y = s.openH + course; y < H - 0.01; y += course) levels.push(y);
  if (s.bands) {
    for (let y = H * 0.72; y < H - 0.01; y += H * 0.056) levels.push(y);
  }
  levels.push(H);
  const ys = [...new Set(levels.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);

  const at = (a: number, r: number, y: number): P => [s.x + Math.cos(a) * r, y, s.z + Math.sin(a) * r];
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k]!;
    const y1 = ys[k + 1]!;
    const col = colourAt((y0 + y1) / 2);
    const inner = mul(y1 > H * 0.85 ? soot : brick, y1 > H * 0.85 ? 1 : 0.42);
    for (let i = 0; i < S; i++) {
      const a0 = (i / S) * Math.PI * 2;
      const a1 = ((i + 1) / S) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      const open = y1 <= s.openH + 1e-6 && inGap(mid);
      if (open) continue;
      const f = facing(mid);
      face(m, at(a0, outer(y0), y0), at(a1, outer(y0), y0), at(a1, outer(y1), y1), at(a0, outer(y1), y1), mul(col, f));
      face(m, at(a0, R, y1), at(a1, R, y1), at(a1, R, y0), at(a0, R, y0), inner);
      // The opening's jambs and lintel, where an open segment meets a closed one.
      if (y1 <= s.openH + 1e-6) {
        const prevOpen = inGap(mid - (Math.PI * 2) / S);
        const nextOpen = inGap(mid + (Math.PI * 2) / S);
        const jamb = mul(brick, 0.55);
        if (prevOpen) face(m, at(a0, R, y0), at(a0, outer(y0), y0), at(a0, outer(y1), y1), at(a0, R, y1), jamb);
        if (nextOpen) face(m, at(a1, outer(y0), y0), at(a1, R, y0), at(a1, R, y1), at(a1, outer(y1), y1), jamb);
      }
    }
  }
  // Lintels over the openings.
  for (let i = 0; i < S; i++) {
    const a0 = (i / S) * Math.PI * 2;
    const a1 = ((i + 1) / S) * Math.PI * 2;
    if (!inGap((a0 + a1) / 2)) continue;
    const y = s.openH;
    face(m, at(a0, R, y), at(a1, R, y), at(a1, outer(y), y), at(a0, outer(y), y), mul(brick, 0.4));
  }
  // The collar: a cast lip round the top, slightly proud of the wall.
  const collarR = outer(H) + 0.22;
  const cy0 = H - 0.9;
  const cy1 = H + 0.25;
  const dark: RGB = [0.3, 0.3, 0.32];
  for (let i = 0; i < S; i++) {
    const a0 = (i / S) * Math.PI * 2;
    const a1 = ((i + 1) / S) * Math.PI * 2;
    const f = facing((a0 + a1) / 2);
    face(m, at(a0, collarR, cy0), at(a1, collarR, cy0), at(a1, collarR, cy1), at(a0, collarR, cy1), mul(dark, f));
    face(m, at(a0, R, cy1), at(a1, R, cy1), at(a1, collarR, cy1), at(a0, collarR, cy1), mul(dark, 0.8));
    face(m, at(a0, outer(cy0), cy0), at(a1, outer(cy0), cy0), at(a1, collarR, cy0), at(a0, collarR, cy0), mul(dark, 0.6));
  }
  // A maintenance ladder up the outside, on the side away from the openings.
  const ladderA = (gapA[0] ?? 0) + Math.PI * 0.75;
  for (const side of [-1, 1]) {
    const a = ladderA + (side * 0.22) / outer(0);
    m.rod(at(a, outer(0) + 0.18, 0.5), at(a, outer(H) + 0.18, H - 1), 0.035, 4, 0.35, 0.35, 0.37);
  }
  for (let y = 1; y < H - 1.2; y += 0.6) {
    const r = outer(y) + 0.18;
    m.rod(at(ladderA - 0.22 / r, r, y), at(ladderA + 0.22 / r, r, y), 0.025, 4, 0.35, 0.35, 0.37);
  }

  // Collision: three stacked rings, each as thick as its section's base; the
  // bottom one carries the openings.
  const gaps = s.openings.map((deg) => ({ bearing: (deg * Math.PI) / 180, halfAngle, top: s.openH }));
  const cuts = [0, Math.max(s.openH + 0.5, H / 3), (2 * H) / 3, H + 0.25];
  for (let k = 0; k < 3; k++) {
    const y0 = cuts[k]!;
    const y1 = cuts[k + 1]!;
    const thick = (k === 2 ? collarR : outer(y0)) - R;
    obs.push({
      kind: 'ring',
      north: -s.z,
      east: s.x,
      up: (y0 + y1) / 2,
      radius: R,
      thickness: thick,
      halfLength: (y1 - y0) / 2,
      axis: 'up',
      ...(k === 0 ? { gaps } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Hangars
// ---------------------------------------------------------------------------

/**
 * Local frame for a building: `u` along its length, `v` across it, from a
 * centre and an axis. Lets one description serve a building facing either way.
 */
function frame(x: number, z: number, along: 'x' | 'z', flip = false): (u: number, y: number, v: number) => P {
  const k = flip ? -1 : 1;
  return along === 'x' ? (u, y, v) => [x + k * u, y, z + v] : (u, y, v) => [x + v, y, z + k * u];
}

/** A box given in a building's local frame. */
function localBlock(
  m: MeshBuilder, obs: Obstacle[], L: (u: number, y: number, v: number) => P,
  u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, c: RGB,
): void {
  const a = L(u0, y0, v0);
  const b = L(u1, y1, v1);
  block(m, obs, a[0], a[1], a[2], b[0], b[1], b[2], c);
}

export interface QuonsetSpec {
  x: number;
  z: number;
  /** The open front is at the low-x (or low-z, north) end; flip puts it at the other. */
  flip?: boolean;
  /** Radius of the half-cylinder, m. */
  radius: number;
  /** Length, m. */
  length: number;
  along: 'x' | 'z';
  /** Roof holes as [arc panel, bay] pairs; arc panels count 0..15 from one side over to the other. */
  holes: [number, number][];
  /** Close the far end with a wall and a door of this width and height; omit to leave both ends open. */
  backDoor?: [number, number];
  colour?: RGB;
}

/**
 * A Quonset hangar: a corrugated half-cylinder. Fly in the open end, out of
 * the back door or up through a skylight. Panels (16 round the arc, one bay
 * every ~4 m) are each a collision box, and a hole is a missing panel.
 */
export function quonsetHangar(m: MeshBuilder, obs: Obstacle[], s: QuonsetSpec): void {
  const A = 16;
  const B = Math.max(2, Math.round(s.length / 4));
  const bay = s.length / B;
  const T = 0.22;
  const L = frame(s.x, s.z, s.along, s.flip);
  const steel = s.colour ?? [0.62, 0.64, 0.65];
  const holes = new Set(s.holes.map(([i, j]) => `${i},${j}`));
  const solidAt = (i: number, j: number): boolean => i >= 0 && i < A && j >= 0 && j < B && !holes.has(`${i},${j}`);
  // A point on the arc: t across from 0 (one foot) to pi (the other).
  const pt = (t: number, r: number, u: number): P => L(u, Math.sin(t) * r, Math.cos(t) * r);

  for (let j = 0; j < B; j++) {
    const u0 = -s.length / 2 + j * bay;
    const u1 = u0 + bay;
    for (let i = 0; i < A; i++) {
      if (!solidAt(i, j)) continue;
      const t0 = (i / A) * Math.PI;
      const t1 = ((i + 1) / A) * Math.PI;
      const tm = (t0 + t1) / 2;
      // Shade by which way the panel faces: the arc's outward normal in render
      // space is (cos t, sin t) across the building.
      const nx = s.along === 'x' ? 0 : Math.cos(tm);
      const nz = s.along === 'x' ? Math.cos(tm) : 0;
      const lit = 0.66 + 0.2 * Math.sin(tm) + 0.14 * (nx * Math.cos(SUN_ANGLE) + nz * Math.sin(SUN_ANGLE));
      // Corrugation reads as alternating strips.
      const tone = mul(steel, lit * (i % 2 === 0 ? 1 : 0.93));
      const ro = s.radius + T;
      const pts: P[] = [pt(t0, s.radius, u0), pt(t1, s.radius, u0), pt(t1, ro, u0), pt(t0, ro, u0),
        pt(t0, s.radius, u1), pt(t1, s.radius, u1), pt(t1, ro, u1), pt(t0, ro, u1)];
      const [a, b, c, d, e, f, g, h] = pts as [P, P, P, P, P, P, P, P];
      face(m, d, c, g, h, tone);
      face(m, e, f, b, a, mul(steel, 0.55));
      // Edges only where they show: at the ends, at a hole.
      const edge = mul(steel, 0.55);
      if (!solidAt(i, j - 1)) face(m, a, b, c, d, edge);
      if (!solidAt(i, j + 1)) face(m, h, g, f, e, edge);
      if (i > 0 && !solidAt(i - 1, j)) face(m, a, d, h, e, edge);
      if (i < A - 1 && !solidAt(i + 1, j)) face(m, b, f, g, c, edge);
      hitAround(obs, pts);
    }
    // A rib at each bay line, a little proud of the skin.
    for (let i = 0; i < A; i++) {
      const t0 = (i / A) * Math.PI;
      const t1 = ((i + 1) / A) * Math.PI;
      const r1 = s.radius + T + 0.1;
      const w = 0.12;
      face(m, pt(t0, r1, u0 - w), pt(t1, r1, u0 - w), pt(t1, r1, u0 + w), pt(t0, r1, u0 + w), mul(steel, 0.5));
    }
  }
  // Concrete apron in front of the open end, so the mouth reads from a distance.
  const ap0 = L(-s.length / 2 - 8, 0.02, -s.radius);
  const ap1 = L(-s.length / 2, 0.02, s.radius);
  m.groundQuad(Math.min(ap0[0], ap1[0]), Math.min(ap0[2], ap1[2]), Math.max(ap0[0], ap1[0]), Math.max(ap0[2], ap1[2]), 0.02, 0.5, 0.5, 0.48);

  if (s.backDoor) {
    // End wall in vertical strips under the arch, with the door cut out. Drawn
    // as trapezoids whose tops follow the arch exactly (boxes would step and
    // leave slivers of sky along the curve); solid as boxes under that line.
    const [dw, dh] = s.backDoor;
    const u = s.length / 2;
    const strips = Math.round((s.radius * 2) / 1.2);
    const sw = (s.radius * 2) / strips;
    const wall: RGB = mul(steel, 0.8);
    const arcY = (v: number): number => Math.sqrt(Math.max(0, s.radius * s.radius - v * v));
    for (let k = 0; k < strips; k++) {
      const v0 = -s.radius + k * sw;
      const v1 = v0 + sw;
      const inDoor = Math.abs((v0 + v1) / 2) < dw / 2;
      const bottom = inDoor ? dh : 0;
      const t0 = arcY(v0);
      const t1 = arcY(v1);
      if (Math.max(t0, t1) <= bottom) continue;
      const col = k % 2 ? wall : mul(wall, 0.94);
      for (const uu of [u - T, u]) {
        face(m, L(uu, bottom, v0), L(uu, bottom, v1), L(uu, Math.max(bottom, t1), v1), L(uu, Math.max(bottom, t0), v0), col);
      }
      if (inDoor) face(m, L(u - T, bottom, v0), L(u, bottom, v0), L(u, bottom, v1), L(u - T, bottom, v1), mul(wall, 0.6));
      const top = Math.min(t0, t1);
      if (top > bottom + 0.05) {
        const p0 = L(u - T, bottom, v0);
        const p1 = L(u, top, v1);
        hit(obs, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2]);
      }
    }
    // Door posts, so the opening reads.
    localBlock(m, obs, L, u - T - 0.05, 0, -dw / 2 - 0.25, u + 0.05, dh, -dw / 2, [0.95, 0.75, 0.15]);
    localBlock(m, obs, L, u - T - 0.05, 0, dw / 2, u + 0.05, dh, dw / 2 + 0.25, [0.95, 0.75, 0.15]);
    localBlock(m, obs, L, u - T - 0.05, dh - 0.25, -dw / 2, u + 0.05, dh, dw / 2, [0.95, 0.75, 0.15]);
  }
}

export interface GableSpec {
  x: number;
  z: number;
  /** The open front is at the low-x (or low-z, north) end; flip puts it at the other. */
  flip?: boolean;
  /** Width across, length along the ridge, m. */
  width: number;
  length: number;
  along: 'x' | 'z';
  /** Wall height at the eaves, and the ridge height, m. */
  eave: number;
  ridge: number;
  /** Front (u < 0 end) door width and height; the back has a smaller one. */
  frontDoor: [number, number];
  backDoor: [number, number];
  /** Roof holes as [side (0 or 1), strip from the eave (0..3), bay] triples. */
  holes: [number, number, number][];
  /** Tie beams across the inside at eave height, every this many bays (0 for none). */
  beamEvery?: number;
  wall?: RGB;
  roof?: RGB;
}

/**
 * A portal-frame hangar with a pitched roof: big doors at the front, a small
 * one at the back, holes in the roof panels, and tie beams across the inside to
 * thread between.
 */
export function gableHangar(m: MeshBuilder, obs: Obstacle[], s: GableSpec): void {
  const L = frame(s.x, s.z, s.along, s.flip);
  const hw = s.width / 2;
  const hl = s.length / 2;
  const T = 0.3;
  const wall = s.wall ?? [0.7, 0.73, 0.77];
  const roof = s.roof ?? [0.36, 0.38, 0.42];
  const S = 4;
  const B = Math.max(2, Math.round(s.length / 4.5));
  const bay = s.length / B;

  // Side walls, in panels so the corrugation shows.
  for (const side of [-1, 1]) {
    for (let j = 0; j < B; j++) {
      const u0 = -hl + j * bay;
      const v0 = side < 0 ? -hw : hw - T;
      localBlock(m, obs, L, u0, 0, v0, u0 + bay, s.eave, v0 + T, j % 2 ? wall : mul(wall, 0.93));
    }
  }
  // End walls: door, then the posts either side of it, the header over it and
  // the gable triangle above the eaves.
  const end = (u: number, dw: number, dh: number, inward: number): void => {
    const u0 = inward > 0 ? u : u - T;
    const u1 = u0 + T;
    const jamb: RGB = [0.95, 0.75, 0.15];
    localBlock(m, obs, L, u0, 0, -hw, u1, s.eave, -dw / 2, wall);
    localBlock(m, obs, L, u0, 0, dw / 2, u1, s.eave, hw, wall);
    localBlock(m, obs, L, u0, dh, -dw / 2, u1, s.eave, dw / 2, mul(wall, 0.9));
    // Yellow door frame, so the opening reads from across the field.
    localBlock(m, obs, L, u0 - 0.05, 0, -dw / 2 - 0.25, u1 + 0.05, dh, -dw / 2, jamb);
    localBlock(m, obs, L, u0 - 0.05, 0, dw / 2, u1 + 0.05, dh, dw / 2 + 0.25, jamb);
    localBlock(m, obs, L, u0 - 0.05, dh - 0.25, -dw / 2, u1 + 0.05, dh, dw / 2, jamb);
    // Gable: drawn as a true triangle, solid as steps under the slope.
    const rise = s.ridge - s.eave;
    for (const f of [u0, u1]) {
      face(m, L(f, s.eave, -hw), L(f, s.eave, hw), L(f, s.ridge, 0), L(f, s.ridge, 0), mul(wall, 0.88));
    }
    // Each step as wide as the triangle at the middle of its band, so the
    // solid never pokes out past the drawn wall by more than half a step.
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const v = hw * (1 - (k + 0.5) / steps);
      const a = L(u0, s.eave + (rise * k) / steps, -v);
      const b = L(u1, s.eave + (rise * (k + 1)) / steps, v);
      hit(obs, a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  };
  end(-hl, s.frontDoor[0], s.frontDoor[1], 1);
  end(hl, s.backDoor[0], s.backDoor[1], -1);

  // Roof: two planes, S strips from eave to ridge, B bays along.
  const holes = new Set(s.holes.map(([a, b, c]) => `${a},${b},${c}`));
  const over = 0.6; // eave overhang
  const RT = 0.2;
  for (let side = 0; side < 2; side++) {
    const sg = side === 0 ? -1 : 1;
    const vAt = (k: number): number => sg * (hw + over) * (1 - k / S);
    const yAt = (k: number): number => s.eave - over * ((s.ridge - s.eave) / hw) + (s.ridge - s.eave + over * ((s.ridge - s.eave) / hw)) * (k / S);
    // Facing: roof planes tilt toward +v or -v.
    const nx = s.along === 'x' ? 0 : sg;
    const nz = s.along === 'x' ? sg : 0;
    const lit = 0.82 + 0.18 * (nx * Math.cos(SUN_ANGLE) + nz * Math.sin(SUN_ANGLE));
    for (let j = 0; j < B; j++) {
      const u0 = -hl - (j === 0 ? 0.4 : 0) + j * bay;
      const u1 = -hl + (j + 1) * bay + (j === B - 1 ? 0.4 : 0);
      for (let k = 0; k < S; k++) {
        if (holes.has(`${side},${k},${j}`)) continue;
        const a = L(u0, yAt(k), vAt(k));
        const b = L(u0, yAt(k + 1), vAt(k + 1));
        const c = L(u1, yAt(k + 1), vAt(k + 1));
        const d = L(u1, yAt(k), vAt(k));
        const up = (p: P): P => [p[0], p[1] + RT, p[2]];
        const tone = mul(roof, lit * (j % 2 ? 1 : 0.94));
        face(m, up(a), up(b), up(c), up(d), tone);
        face(m, d, c, b, a, mul(roof, 0.8));
        const edge = mul(roof, 0.6);
        // Hole edges.
        if (holes.has(`${side},${k - 1},${j}`)) face(m, a, d, up(d), up(a), edge);
        if (holes.has(`${side},${k + 1},${j}`)) face(m, b, up(b), up(c), c, edge);
        if (holes.has(`${side},${k},${j - 1}`)) face(m, a, up(a), up(b), b, edge);
        if (holes.has(`${side},${k},${j + 1}`)) face(m, d, c, up(c), up(d), edge);
        hitAround(obs, [a, b, c, d, up(a), up(b), up(c), up(d)]);
      }
    }
  }
  // Ridge cap.
  localBlock(m, obs, L, -hl - 0.4, s.ridge, -0.35, hl + 0.4, s.ridge + RT + 0.15, 0.35, mul(roof, 0.75));

  // Tie beams across the inside at the eaves: the things to thread between.
  const every = s.beamEvery ?? 2;
  if (every > 0) {
    for (let j = every; j < B; j += every) {
      const u = -hl + j * bay;
      localBlock(m, obs, L, u - 0.18, s.eave - 0.6, -hw + T, u + 0.18, s.eave - 0.1, hw - T, [0.25, 0.27, 0.3]);
    }
  }
  // Concrete apron at the front.
  const ap0 = L(-hl - 10, 0, -hw);
  const ap1 = L(-hl, 0, hw);
  m.groundQuad(Math.min(ap0[0], ap1[0]), Math.min(ap0[2], ap1[2]), Math.max(ap0[0], ap1[0]), Math.max(ap0[2], ap1[2]), 0.02, 0.5, 0.5, 0.48);
}

export interface FlatSpec {
  x: number;
  z: number;
  /** Size along x and z, and wall height, m. */
  sx: number;
  sz: number;
  height: number;
  /** Doors by side: 'n' 's' 'e' 'w' with width and height. */
  doors: { side: 'n' | 's' | 'e' | 'w'; width: number; height: number }[];
  /** Roof grid size, and which cells are open skylights, as [i along x, k along z]. */
  grid: [number, number];
  holes: [number, number][];
  /** Interior columns at the roof grid's inner corners, every this many cells (0 for none). */
  columnsEvery?: number;
}

/**
 * A flat-roofed hangar, low and wide: doors on two or more sides, a roof grid
 * with open skylights, and columns inside. In one door, out another, or up
 * through the roof.
 */
export function flatHangar(m: MeshBuilder, obs: Obstacle[], s: FlatSpec): void {
  const T = 0.3;
  const x0 = s.x - s.sx / 2;
  const x1 = s.x + s.sx / 2;
  const z0 = s.z - s.sz / 2;
  const z1 = s.z + s.sz / 2;
  const H = s.height;
  const wall: RGB = [0.74, 0.7, 0.62];
  const trim: RGB = [0.85, 0.3, 0.18];
  // A wall along one side, with its door cut out. `t` runs along the wall.
  const side = (which: 'n' | 's' | 'e' | 'w'): void => {
    const alongX = which === 'n' || which === 's';
    const len = alongX ? s.sx : s.sz;
    const door = s.doors.find((d) => d.side === which);
    const put = (a: number, b: number, y0: number, y1: number, c: RGB): void => {
      // a..b along the wall from its start corner.
      if (b - a < 0.01) return;
      if (alongX) {
        const zz = which === 'n' ? z0 : z1 - T;
        block(m, obs, x0 + a, y0, zz, x0 + b, y1, zz + T, c);
      } else {
        const xx = which === 'w' ? x0 : x1 - T;
        block(m, obs, xx, y0, z0 + a, xx + T, y1, z0 + b, c);
      }
    };
    if (!door) {
      // Panels, so a long blank wall still has some texture.
      const n = Math.max(1, Math.round(len / 5));
      for (let i = 0; i < n; i++) put((len * i) / n, (len * (i + 1)) / n, 0, H, i % 2 ? wall : mul(wall, 0.94));
      return;
    }
    const d0 = len / 2 - door.width / 2;
    const d1 = len / 2 + door.width / 2;
    put(0, d0, 0, H, wall);
    put(d1, len, 0, H, wall);
    put(d0, d1, door.height, H, mul(wall, 0.9));
    put(d0 - 0.3, d0, 0, door.height, trim);
    put(d1, d1 + 0.3, 0, door.height, trim);
  };
  side('n');
  side('s');
  side('e');
  side('w');
  // A stripe of trim along the top of the walls.
  block(m, obs, x0 - 0.1, H - 0.6, z0 - 0.1, x1 + 0.1, H, z0 + 0.05, trim);
  block(m, obs, x0 - 0.1, H - 0.6, z1 - 0.05, x1 + 0.1, H, z1 + 0.1, trim);

  // Roof panels, skylights missing.
  const [gi, gk] = s.grid;
  const cx = s.sx / gi;
  const cz = s.sz / gk;
  const holes = new Set(s.holes.map(([i, k]) => `${i},${k}`));
  const roof: RGB = [0.42, 0.43, 0.45];
  for (let i = 0; i < gi; i++) {
    for (let k = 0; k < gk; k++) {
      if (holes.has(`${i},${k}`)) continue;
      block(m, obs, x0 + i * cx, H, z0 + k * cz, x0 + (i + 1) * cx, H + 0.4, z0 + (k + 1) * cz, (i + k) % 2 ? roof : mul(roof, 0.93));
    }
  }
  // Columns inside.
  const every = s.columnsEvery ?? 2;
  if (every > 0) {
    for (let i = every; i < gi; i += every) {
      for (let k = every; k < gk; k += every) {
        const px = x0 + i * cx;
        const pz = z0 + k * cz;
        m.cylinder(px, pz, 0, H, 0.22, 10, 0.3, 0.32, 0.36);
        obs.push({ kind: 'cylinder', north: -pz, east: px, radius: 0.3, height: H });
      }
    }
  }
}
