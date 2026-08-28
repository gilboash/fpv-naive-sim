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

export interface Track {
  name: string;
  /** Where the quad starts, in NED metres, and its heading in degrees. */
  start: { north: number; east: number; yawDeg: number };
  build(m: MeshBuilder): void;
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
  if (along === 'x') {
    m.cylinder(cx - half, cz, 0, height, postR, 10, ...POST);
    m.cylinder(cx + half, cz, 0, height, postR, 10, ...POST);
    m.slab(cx - half - postR, height, cz - bar, cx + half + postR, height + bar * 2, cz + bar, ...colour);
    // Foot markers, so the gate reads as a gate from a distance.
    m.groundQuad(cx - half - 0.4, cz - 0.4, cx - half + 0.4, cz + 0.4, 0.01, ...colour);
    m.groundQuad(cx + half - 0.4, cz - 0.4, cx + half + 0.4, cz + 0.4, 0.01, ...colour);
  } else {
    m.cylinder(cx, cz - half, 0, height, postR, 10, ...POST);
    m.cylinder(cx, cz + half, 0, height, postR, 10, ...POST);
    m.slab(cx - bar, height, cz - half - postR, cx + bar, height + bar * 2, cz + half + postR, ...colour);
    m.groundQuad(cx - 0.4, cz - half - 0.4, cx + 0.4, cz - half + 0.4, 0.01, ...colour);
    m.groundQuad(cx - 0.4, cz + half - 0.4, cx + 0.4, cz + half + 0.4, 0.01, ...colour);
  }
}

function pylon(m: MeshBuilder, cx: number, cz: number, height: number): void {
  m.cylinder(cx, cz, 0, height, 0.18, 12, 0.9, 0.45, 0.1);
  m.cylinder(cx, cz, height * 0.45, height * 0.55, 0.2, 12, 0.95, 0.95, 0.95);
}

/** An open field with a landing pad. Somewhere to learn hovering and turns. */
export const openField: Track = {
  name: 'Open field',
  start: { north: 0, east: 0, yawDeg: 0 },
  build(m) {
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
      pylon(m, x, z, 4);
    }
  },
};

/** Straight line of gates. The first thing worth practising after hovering. */
export const gateRun: Track = {
  name: 'Gate run',
  start: { north: -30, east: 0, yawDeg: 0 },
  build(m) {
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
      gate(m, offsets[i]!, z, 3.2, heights[i]!, 'x', i % 2 === 0 ? GATE_A : GATE_B);
    }
    pylon(m, 12, 20, 5);
    pylon(m, -12, -20, 5);
    pylon(m, 14, -34, 5);
  },
};

/** A loop with gates at varying heights and a couple of turns. */
export const circuit: Track = {
  name: 'Circuit',
  start: { north: -34, east: 0, yawDeg: 0 },
  build(m) {
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
      gate(m, x, z, 3.2, h, along, i % 2 === 0 ? GATE_A : GATE_B);
    });
    for (const [x, z] of [
      [22, 22],
      [-22, 22],
      [22, -22],
      [-22, -22],
    ] as [number, number][]) {
      pylon(m, x, z, 6);
    }
  },
};

export const TRACKS: Track[] = [openField, gateRun, circuit];
