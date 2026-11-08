/**
 * A Velocidrone track, as one of ours.
 *
 * Velocidrone keeps every downloaded track in a SQLite database
 * (`~/Library/Application Support/com.velocidrone.velocidrone/user11.db`,
 * table `tracks`, column `value`) as JSON: `gates` — each with a race number —
 * and `barriers`, both as Unity transforms in fixed point. The prefab numbers
 * are named in the sibling `settings.db`, table `trackprefabs`.
 * `tools/velocidrone-import.ts` reads both; this file only converts.
 *
 * What the file says, and what has to be assumed, kept apart:
 *
 *  - **Said:** positions (centimetres, Unity: x, y up, z), rotations
 *    (quaternion w, x, y, z, x1000), scale (x100), the order of the course.
 *    Units were checked rather than assumed: the lap through the gates is
 *    301 m and the two fastest pilots' average speed times their lap time is
 *    294-296 m.
 *  - **Read from the orientation:** which way a gate is flown. Each prefab's
 *    model has its own forward axis (`FORWARD`); on Macabim those make every
 *    gate flow into the next — 16 into 17 in a straight line, 25 into the
 *    start gate — where the opposite reading makes U-turns out of straights.
 *  - **Assumed:** every aperture size (the game's meshes are not in the file),
 *    obstacle sizes, and how each flag is passed. A flag's orientation does not
 *    say it (Macabim's MGP flags point with the flow at 20-23 and against it at
 *    12), so a flag's direction and side are chosen as the combination that
 *    makes the shortest lap with the gates fixed (`chooseDirections`).
 *    `overrides` exists for when the pilot or the video says otherwise;
 *    `npm run dev` then /vd-map.html draws the course and edits them.
 *
 * Unity is left-handed with y up; NED is right-handed. north = z, east = x,
 * down = -y has determinant -1, which is exactly what turns one handedness
 * into the other without mirroring the track.
 */

import type { Obstacle } from '../flight/collision.ts';
import type { Checkpoint, Course, Flag, Gate } from '../race/course.ts';
import { planeAxes } from '../race/race.ts';
import { MeshBuilder } from './mesh.ts';
import { ground, lightPole, raceGate, raceScenery, solid, type Track } from './track.ts';

export interface VdTransform {
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
}

export interface VdObject {
  prefab: number;
  trans: VdTransform;
  gate?: number;
  start?: boolean;
  finish?: boolean;
  lap1only?: boolean;
}

export interface VdTrack {
  gates: VdObject[];
  barriers?: VdObject[];
}

export interface ImportOptions {
  name: string;
  /** prefab id -> name, from settings.db. */
  prefabs: Map<number, string>;
  laps?: number;
  /** Hand corrections, by race number. */
  overrides?: Record<number, VdOverride>;
}

/**
 * A correction to how one checkpoint is flown. Absolute, not relative to
 * whatever the search picked, so an override means the same thing after the
 * search changes.
 */
export interface VdOverride {
  /** Fly this gate against Velocidrone's arrow. */
  reverse?: boolean;
  /** A flag's direction of travel past the pole, compass degrees. */
  travel?: number;
  /** Which hand the pole is on as the pilot passes it. */
  side?: 'left' | 'right';
  /** Leave this race number out of the course. */
  skip?: boolean;
}

export interface Imported {
  track: Track;
  course: Course;
  /** One line per assumption or oddity, for the report. */
  notes: string[];
  /** The checkpoints in race order with what each one was read as. */
  table: { gate: number; prefab: string; kind: string; north: number; east: number; up: number; dir: string }[];
  /** Where the line is assumed to enter and leave each checkpoint, NEU, for drawing. */
  passes: { entry: [number, number, number]; exit: [number, number, number] }[];
}

// ------------------------------------------------------------------ geometry

type V3 = [number, number, number];

/** Unity position (cm) to NED-with-up-positive metres. */
function toNEU(p: readonly number[]): V3 {
  return [p[2]! / 100, p[0]! / 100, p[1]! / 100];
}

/** Rotate a Unity-local vector by a Unity quaternion (w, x, y, z), into NEU. */
function axisNEU(rot: readonly number[], local: V3): V3 {
  let [w, x, y, z] = rot as [number, number, number, number];
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n;
  x /= n;
  y /= n;
  z /= n;
  const [vx, vy, vz] = local;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  const ux = vx + w * tx + (y * tz - z * ty);
  const uy = vy + w * ty + (z * tx - x * tz);
  const uz = vz + w * tz + (x * ty - y * tx);
  return [uz, ux, uy];
}

const scaleOf = (t: VdTransform): V3 => [t.scale[0] / 100, t.scale[1] / 100, t.scale[2] / 100];

function horizontal(v: V3): [number, number] {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Yaw of a horizontal axis, for laying out boxes. */
function yawOf(rot: readonly number[]): number {
  const f = axisNEU(rot, [0, 0, 1]);
  return Math.atan2(f[1], f[0]);
}

// ------------------------------------------------------------------ what each prefab is

/**
 * The local axis each prefab is flown along. Established from Macabim's flow,
 * not from documentation: the start grid sits south of the canvas start gate
 * (+z north), the hurdle's trigger square is approached from the south and
 * the dive gate's from above (-x for both), and the WDC gates' -z makes each
 * one lead into the next.
 */
const FORWARD: Record<string, V3> = {
  DefaultSquare: [-1, 0, 0],
  WDCGate: [0, 0, -1],
};
const forwardOf = (prefab: string): V3 => FORWARD[prefab] ?? [0, 0, 1];

type Kind =
  | { kind: 'gate'; normal: V3; halfWidth: number; halfHeight: number; centre: V3; invisible: boolean; a1?: V3; a2?: V3 }
  | { kind: 'flag'; pole: V3; height: number; passWidth: number; invisible: boolean };

/**
 * Read one checkpoint. Sizes here are estimates and are marked as such in the
 * notes; the orientation conventions were established from the track itself
 * (see CLAUDE.md, "Velocidrone import").
 */
function readCheckpoint(o: VdObject, prefab: string, notes: string[]): Kind {
  const t = o.trans;
  const p = toNEU(t.pos);
  const s = scaleOf(t);
  if (prefab === 'DefaultSquare') {
    // An invisible trigger square. Its plane faces along local x and spans
    // local y by local z, a metre per unit of scale: over the MGP hurdle on
    // this track it comes out as a 3.1 x 2 m window centred 1.5 m up, and over
    // the dive gate as a horizontal 1.3 x 1.4 m opening 3.5 m up.
    const normal = axisNEU(t.rot, forwardOf(prefab));
    const ly = axisNEU(t.rot, [0, 1, 0]);
    const lz = axisNEU(t.rot, [0, 0, 1]);
    return { kind: 'gate', normal, halfWidth: s[1] / 2, halfHeight: s[2] / 2, centre: p, invisible: true, a1: ly, a2: lz };
  }
  if (prefab === 'DefaultInvisibleFlagPole' || prefab.endsWith('Flag') || prefab.includes('Flag')) {
    // A pole you pass. How is not in the file — see the header — so the
    // direction search offers every heading and both sides.
    const invisible = prefab.includes('Invisible');
    return { kind: 'flag', pole: [p[0], p[1], 0], height: invisible ? 4 : 4 * s[1], passWidth: 4, invisible };
  }
  // Everything else is a framed gate. Aperture sizes are estimates, but the
  // WDC gate's width is pinned by the track itself: every pole on Macabim that
  // stands on a WDC post (1, 5, 10, 13/14, 23) is 1.6-1.8 m from the gate's
  // centre, and side-by-side pairs are 3.1-3.4 m apart, i.e. they share a
  // post. So posts at ~1.7 m and an opening of ~3.1 m. Height: 2.5 m overall
  // (the spacing of the stacked pairs), opening 2.0 m with the bottom 0.25 up.
  // A 2.5 m guess first left two posts 0.7 m apart between paired gates, with
  // a gap the planner tried to thread.
  let hw = 1.55;
  let hh = 1.0;
  let cy = 1.25;
  if (prefab === 'WDCGate') {
    // as above
  } else if (prefab === 'DefaultCanvasGate1') {
    hw = 0.75;
    hh = 0.6;
    cy = 0.75;
  } else {
    notes.push(`gate ${o.gate}: unknown gate prefab "${prefab}", sized as a 2.5 x 2 m opening`);
  }
  const up = axisNEU(t.rot, [0, 1, 0]);
  const centre: V3 = [p[0] + up[0] * cy * s[1], p[1] + up[1] * cy * s[1], p[2] + up[2] * cy * s[1]];
  return {
    kind: 'gate',
    normal: axisNEU(t.rot, forwardOf(prefab)),
    halfWidth: hw * s[0],
    halfHeight: hh * s[1],
    centre,
    invisible: false,
  };
}

// ------------------------------------------------------------------ direction search

interface State {
  /** The checkpoint as flown in this state. */
  cp: Checkpoint;
  /** Extra metres charged for choosing this state, to break ties sensibly. */
  bias?: number;
  entry: V3;
  exit: V3;
}

const LEAD = 2; // metres either side of a checkpoint the line is assumed straight

function statesFor(k: Kind, ov: VdOverride | undefined): State[] {
  const out: State[] = [];
  if (k.kind === 'gate') {
    const l = Math.hypot(...k.normal) || 1;
    const n: V3 = [k.normal[0] / l, k.normal[1] / l, k.normal[2] / l];
    // One state: the gate's own arrow, or against it if told.
    for (const sgn of [ov?.reverse ? -1 : 1]) {
      const dN = n[0] * sgn;
      const dE = n[1] * sgn;
      const dU = n[2] * sgn;
      // Our in-plane axes for this normal, and the square's extents along them.
      let halfWidth = k.halfWidth;
      let halfHeight = k.halfHeight;
      if (k.a1 && k.a2) {
        const [ax] = planeAxes(dN, dE, Math.abs(dU) > 0.999 ? Math.sign(dU) : dU);
        const along1 = Math.abs(k.a1[0] * ax[0] + k.a1[1] * ax[1] + k.a1[2] * ax[2]);
        const along2 = Math.abs(k.a2[0] * ax[0] + k.a2[1] * ax[1] + k.a2[2] * ax[2]);
        if (along2 > along1) [halfWidth, halfHeight] = [k.halfHeight, k.halfWidth];
      }
      const vertical = Math.abs(dU) > 0.7;
      const gate: Gate = {
        kind: 'gate',
        north: k.centre[0],
        east: k.centre[1],
        up: k.centre[2],
        // A near-vertical normal is snapped: the timer and the marker treat
        // |dirU| > 0.999 as a horizontal plane, and a dive gate tilted a few
        // degrees is a dive gate.
        dirN: vertical ? 0 : dN / Math.hypot(dN, dE),
        dirE: vertical ? 0 : dE / Math.hypot(dN, dE),
        ...(vertical ? { dirU: Math.sign(dU) } : Math.abs(dU) > 1e-3 ? { dirU: 0 } : {}),
        halfWidth,
        halfHeight,
        ...(k.invisible ? { frame: 'none' as const } : {}),
      };
      const d: V3 = vertical ? [0, 0, Math.sign(dU)] : [gate.dirN, gate.dirE, 0];
      out.push({
        cp: gate,
        entry: [k.centre[0] - d[0] * LEAD, k.centre[1] - d[1] * LEAD, k.centre[2] - d[2] * LEAD],
        exit: [k.centre[0] + d[0] * LEAD, k.centre[1] + d[1] * LEAD, k.centre[2] + d[2] * LEAD],
      });
    }
    return out;
  }
  const headings = ov?.travel !== undefined ? [ov.travel] : Array.from({ length: 16 }, (_, i) => i * 22.5);
  const sides: (1 | -1)[] = ov?.side ? [ov.side === 'left' ? 1 : -1] : [1, -1];
  for (const h of headings) {
    for (const side of sides) {
      const dirN = Math.cos((h * Math.PI) / 180);
      const dirE = Math.sin((h * Math.PI) / 180);
      const flag: Flag = {
        kind: 'flag',
        north: k.pole[0],
        east: k.pole[1],
        height: k.height,
        dirN,
        dirE,
        side,
        passWidth: k.passWidth,
        ...(k.invisible ? { invisible: true as const } : {}),
      };
      // Passing point: across = (-dirE, dirN), and across x side > 0 is the
      // legal side, exactly as Race.testFlag has it — so side +1 puts the
      // quad right of the pole and the pole on the pilot's left.
      const w = 1.5;
      const pN = k.pole[0] - dirE * side * w;
      const pE = k.pole[1] + dirN * side * w;
      const up = 1.8;
      out.push({ cp: flag, entry: [pN - dirN * LEAD, pE - dirE * LEAD, up], exit: [pN + dirN * LEAD, pE + dirE * LEAD, up] });
    }
  }
  return out;
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Pick every checkpoint's direction (and every flag's side) together, as the
 * combination with the shortest closed lap — a cyclic Viterbi over at most
 * eight states per checkpoint. A pilot takes the short way round, and a gate
 * flown the long way round is a loop nobody would fly.
 */
function chooseDirections(states: State[][]): number[] {
  const n = states.length;
  let best = Infinity;
  let bestPath: number[] = [];
  for (let s0 = 0; s0 < states[0]!.length; s0++) {
    let cost = states[0]!.map((st, j) => (j === s0 ? (st.bias ?? 0) : Infinity));
    const back: number[][] = [];
    for (let i = 1; i < n; i++) {
      const prev = states[i - 1]!;
      const cur = states[i]!;
      const next = cur.map(() => Infinity);
      const arg = cur.map(() => -1);
      for (let a = 0; a < prev.length; a++) {
        if (!Number.isFinite(cost[a]!)) continue;
        for (let b = 0; b < cur.length; b++) {
          const c = cost[a]! + dist(prev[a]!.exit, cur[b]!.entry) + (cur[b]!.bias ?? 0);
          if (c < next[b]!) {
            next[b] = c;
            arg[b] = a;
          }
        }
      }
      back.push(arg);
      cost = next;
    }
    for (let b = 0; b < states[n - 1]!.length; b++) {
      const c = cost[b]! + dist(states[n - 1]![b]!.exit, states[0]![s0]!.entry);
      if (c < best) {
        best = c;
        const path = [b];
        for (let i = n - 2; i >= 0; i--) path.unshift(back[i]![path[0]!]!);
        bestPath = path;
      }
    }
  }
  return bestPath;
}

// ------------------------------------------------------------------ scenery

/** Crude solids for the barrier prefabs that stand near the line. */
function barrier(m: MeshBuilder, obs: Obstacle[], o: VdObject, name: string): string | null {
  const p = toNEU(o.trans.pos);
  const s = scaleOf(o.trans);
  // Render space: x = east, z = -north.
  const cx = p[1];
  const cz = -p[0];
  const box = (hw: number, hd: number, h: number, colour: [number, number, number], base = p[2]) => {
    // Axis-aligned bounds of a footprint rotated by the object's yaw.
    const yaw = yawOf(o.trans.rot);
    const ex = Math.abs(Math.cos(yaw)) * hw + Math.abs(Math.sin(yaw)) * hd;
    const ez = Math.abs(Math.sin(yaw)) * hw + Math.abs(Math.cos(yaw)) * hd;
    solid(m, obs, cx - ex, Math.max(0, base), cz - ez, cx + ex, Math.max(0, base) + h, cz + ez, colour);
  };
  const trunk = (r: number, h: number) => {
    m.cylinder(cx, cz, 0, h, r, 8, 0.36, 0.27, 0.18);
    m.cylinder(cx, cz, h * 0.6, h * 1.25, r * 4, 8, 0.2, 0.42, 0.16);
    obs.push({ kind: 'cylinder', north: p[0], east: p[1], radius: r, height: h });
  };
  if (name === 'DefaultStreetLamp') lightPole(m, obs, cx, cz, 6);
  else if (name === 'FoldingTable') box(0.9 * s[0], 0.4 * s[2], 0.75 * s[1], [0.85, 0.85, 0.82]);
  else if (name === 'OpenChair') box(0.25 * s[0], 0.25 * s[2], 0.9 * s[1], [0.25, 0.3, 0.5]);
  else if (/Palm|Elm|Oak|MapleMountain|Cedar|Tree/i.test(name)) trunk(0.35 * Math.max(s[0], 1), 4 * s[1]);
  else if (/Bush|Hedge/i.test(name)) {
    m.cylinder(cx, cz, 0, 1.1 * s[1], 0.8 * s[0], 8, 0.22, 0.4, 0.15);
    obs.push({ kind: 'cylinder', north: p[0], east: p[1], radius: 0.8 * s[0], height: 1.1 * s[1] });
  } else if (name === 'DefaultMGPHurdle') box(1.25 * s[0], 0.05, 0.5 * s[1], [0.95, 0.95, 0.95], 0);
  else if (name === 'DefaultTBSFlag') {
    m.cylinder(cx, cz, 0, 3, 0.06, 6, 0.1, 0.1, 0.1);
    obs.push({ kind: 'cylinder', north: p[0], east: p[1], radius: 0.08, height: 3 });
  } else if (name === 'MGPDiveGate') {
    // Four corner posts round the opening the invisible square above names.
    for (const [dx, dz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]] as const) {
      m.cylinder(cx + dx, cz + dz, 0, 3.4, 0.06, 6, 0.9, 0.5, 0.1);
      obs.push({ kind: 'cylinder', north: p[0] - dz, east: p[1] + dx, radius: 0.08, height: 3.4 });
    }
  } else if (name === 'BlockWhite') {
    // A unit cube scaled and rolled: on this track, the X across the blocked
    // lower gate. Its axis-aligned bound is what the line has to stay out of.
    const ax = axisNEU(o.trans.rot, [s[0] / 2, 0, 0]);
    const ay = axisNEU(o.trans.rot, [0, s[1] / 2, 0]);
    const az = axisNEU(o.trans.rot, [0, 0, s[2] / 2]);
    const eN = Math.abs(ax[0]) + Math.abs(ay[0]) + Math.abs(az[0]);
    const eE = Math.abs(ax[1]) + Math.abs(ay[1]) + Math.abs(az[1]);
    const eU = Math.abs(ax[2]) + Math.abs(ay[2]) + Math.abs(az[2]);
    solid(m, obs, cx - eE, Math.max(0, p[2] - eU), cz - eN, cx + eE, p[2] + eU, cz + eN, [0.95, 0.95, 0.95]);
  } else if (/StartGrid|Slab|BluePrint/i.test(name)) return null; // flat, or a tool
  else {
    box(1.5 * s[0], 1.5 * s[2], 2.5 * s[1], [0.5, 0.48, 0.45]);
    return `barrier "${name}" near the line drawn as a 3 x 3 x 2.5 m block`;
  }
  return null;
}

// ------------------------------------------------------------------ the import

export function trackFromVelocidrone(raw: VdTrack, opts: ImportOptions): Imported {
  const notes: string[] = [];
  const nameOf = (id: number): string => opts.prefabs.get(id) ?? `prefab${id}`;

  // The course: everything with a race number, in order. Velocidrone allows a
  // number to repeat; on Macabim the second "gate 1" is the lower half of a
  // stacked pair under gate 18, crossed out by two white blocks, 46 m from
  // where gate 1 belongs. Keep the one nearest the previous checkpoint.
  const numbered = raw.gates.filter((g) => typeof g.gate === 'number' && !opts.overrides?.[g.gate!]?.skip);
  numbered.sort((a, b) => a.gate! - b.gate!);
  const byNumber = new Map<number, VdObject[]>();
  for (const g of numbered) byNumber.set(g.gate!, [...(byNumber.get(g.gate!) ?? []), g]);
  const ordered: VdObject[] = [];
  const decorative: VdObject[] = [];
  for (const [num, list] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length === 1) {
      ordered.push(list[0]!);
      continue;
    }
    const prev = ordered[ordered.length - 1];
    const ref = prev ? toNEU(prev.trans.pos) : toNEU(list[0]!.trans.pos);
    list.sort((a, b) => dist(toNEU(a.trans.pos), ref) - dist(toNEU(b.trans.pos), ref));
    ordered.push(list[0]!);
    for (const extra of list.slice(1)) {
      decorative.push(extra);
      const q = toNEU(extra.trans.pos);
      notes.push(
        `gate number ${num} appears ${list.length} times; kept the ${nameOf(list[0]!.prefab)} nearest gate ${num - 1}, ` +
          `treated the ${nameOf(extra.prefab)} at ${q[0].toFixed(1)} N ${q[1].toFixed(1)} E as scenery`,
      );
    }
  }
  // Start/finish first, as our timer expects: the hole shot is gate one.
  const sf = ordered.findIndex((g) => g.start || g.finish);
  if (sf > 0) ordered.push(...ordered.splice(0, sf));

  const kinds = ordered.map((g) => readCheckpoint(g, nameOf(g.prefab), notes));
  const states = kinds.map((k, i) => statesFor(k, opts.overrides?.[ordered[i]!.gate!]));
  // Most poles on Macabim stand on a gate's post, and the shortest way "past"
  // such a pole is through the gate it stands on — which is the one move the
  // element exists to forbid. A flag is passed outside every opening.
  const openings = kinds.filter((k) => k.kind === 'gate' && Math.abs(k.normal[2]) < 0.7) as Extract<Kind, { kind: 'gate' }>[];
  for (const list of states) {
    for (const st of list) {
      if (st.cp.kind !== 'flag') continue;
      const mN = (st.entry[0] + st.exit[0]) / 2;
      const mE = (st.entry[1] + st.exit[1]) / 2;
      const inside = openings.some((g) => Math.hypot(mN - g.centre[0], mE - g.centre[1]) < g.halfWidth + 0.2);
      if (inside) st.bias = (st.bias ?? 0) + 50;
    }
  }
  const pick = chooseDirections(states);
  const checkpoints: Checkpoint[] = pick.map((j, i) => states[i]![j]!.cp);
  const passes = pick.map((j, i) => {
    const st = states[i]![j]!;
    return { entry: st.entry, exit: st.exit };
  });

  // Start: Velocidrone's start grid, facing the first gate.
  const grid = (raw.barriers ?? []).find((b) => nameOf(b.prefab) === 'DefaultStartGrid');
  const first = checkpoints[0]!;
  const startNEU = grid ? toNEU(grid.trans.pos) : [first.north - 15, first.east, 0];
  if (!grid) notes.push('no start grid on the track; starting 15 m south of the first gate');
  const yawDeg = (Math.atan2(first.east - startNEU[1]!, first.north - startNEU[0]!) * 180) / Math.PI;

  const course: Course = {
    name: opts.name,
    start: { north: startNEU[0]!, east: startNEU[1]!, yawDeg },
    checkpoints,
    defaultLaps: opts.laps ?? 3,
  };

  // Scenery: only what stands near the line. Sheds and bleachers 30 m off the
  // course are context, not obstacles, and every obstacle costs tick time.
  let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
  for (const cp of checkpoints) {
    minN = Math.min(minN, cp.north); maxN = Math.max(maxN, cp.north);
    minE = Math.min(minE, cp.east); maxE = Math.max(maxE, cp.east);
  }
  const pad = 10;
  const near = (o: VdObject) => {
    const p = toNEU(o.trans.pos);
    return p[0] > minN - pad && p[0] < maxN + pad && p[1] > minE - pad && p[1] < maxE + pad;
  };
  const barriers = (raw.barriers ?? []).filter(near);
  notes.push(
    `${barriers.length} of ${(raw.barriers ?? []).length} barriers stand within ${pad} m of the course and are solid; ` +
      'their sizes are estimates, as are all aperture sizes',
  );

  const track: Track = {
    name: opts.name,
    course,
    start: course.start,
    build(m, obs) {
      ground(m);
      for (const b of barriers) {
        const note = barrier(m, obs, b, nameOf(b.prefab));
        if (note && !notes.includes(note)) notes.push(note);
      }
      for (const d of decorative) {
        const k = readCheckpoint(d, nameOf(d.prefab), []);
        if (k.kind !== 'gate' || k.invisible) continue;
        const [hN, hE] = horizontal(k.normal);
        raceGate(m, obs, k.centre[1], -k.centre[0], k.centre[2], k.halfWidth, k.halfHeight, hN, hE, [0.7, 0.7, 0.72], 0);
      }
      raceScenery(m, obs, course);
    },
  };

  const table = checkpoints.map((cp, i) => {
    const g = ordered[i]!;
    const dir =
      cp.kind === 'gate'
        ? cp.dirU
          ? cp.dirU > 0 ? 'up' : 'down'
          : `${(((Math.atan2(cp.dirE, cp.dirN) * 180) / Math.PI + 360) % 360).toFixed(0).padStart(3)}deg`
        : `${((Math.atan2(cp.dirE, cp.dirN) * 180) / Math.PI + 360) % 360 | 0}deg, pole on ${cp.side > 0 ? 'left' : 'right'}`;
    return {
      gate: g.gate!,
      prefab: nameOf(g.prefab),
      kind: cp.kind === 'gate' ? (cp.frame === 'none' ? 'trigger' : 'gate') : cp.invisible ? 'pole (invisible)' : 'flag',
      north: cp.north,
      east: cp.east,
      up: cp.kind === 'gate' ? cp.up : 0,
      dir,
    };
  });
  return { track, course, notes, table, passes };
}

/** Exposed for the checks. */
export const _internal = { toNEU, axisNEU, chooseDirections, statesFor, readCheckpoint };

/** What `tools/velocidrone-import.ts` writes to measurements/velocidrone/<slug>/track.json. */
export interface SavedVdTrack {
  name: string;
  velocidroneId: number;
  downloaded: string;
  /** Only the prefabs this track uses: id -> name. */
  prefabs: Record<string, string>;
  track: VdTrack;
  /** Hand corrections, by race number, once the video has been checked. */
  overrides?: ImportOptions['overrides'];
  /** Its directory under measurements/velocidrone, added by the dev server. */
  slug?: string;
}

export function trackFromSaved(saved: SavedVdTrack): Imported {
  const prefabs = new Map(Object.entries(saved.prefabs).map(([k, v]) => [Number(k), v]));
  return trackFromVelocidrone(saved.track, {
    // Marked, so nobody mistakes it for a built-in or for the real thing:
    // apertures and obstacles are estimates.
    name: `VD: ${saved.name}`,
    prefabs,
    ...(saved.overrides ? { overrides: saved.overrides } : {}),
  });
}
