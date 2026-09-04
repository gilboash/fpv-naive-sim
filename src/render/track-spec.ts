/**
 * A track as data, so that building one does not mean writing code.
 *
 * Every map here was a TypeScript `build()` function until now, which meant a
 * new track was a pull request. This is the same thing expressed as JSON: a
 * list of pieces to place and, optionally, an ordered course through them.
 *
 * **It is not only a convenience — it removes a class of bug.** The invariant
 * this project keeps relearning is that the drawn scene, the solid one and the
 * timed one must come from a single source: markers over ground with no gates
 * on it, and collision volumes that drift from the mesh, both came from having
 * two descriptions of one thing. In a spec there is one entry per object and
 * the loader emits all three from it, so a track written by a stranger cannot
 * get that wrong.
 *
 * Coordinates are **NED with up positive** — north, east, up — matching the
 * physics and the course, not the renderer. The loader converts once. Angles
 * are compass headings in degrees: 0 north, 90 east.
 *
 * Untrusted by construction. A spec may arrive pasted from someone else, so
 * `validateTrackSpec` is the only way in, and it clamps rather than trusts:
 * a track cannot ask for a million cubes or put a gate a thousand kilometres
 * away, and an unknown version is refused rather than guessed at.
 */

import type { Checkpoint, Course, Gate } from '../race/course.ts';
import { GATE_HALF_H, GATE_HALF_W, GATE_UP } from '../race/course.ts';

/** Bumped when the meaning of a field changes. Unknown versions are refused. */
export const TRACK_SPEC_VERSION = 1;

/** Ceilings, so a pasted track cannot exhaust the machine it lands on. */
export const SPEC_LIMITS = {
  pieces: 400,
  checkpoints: 80,
  /** Metres from the origin. The ground plane is 220 m half-width. */
  extent: 300,
  height: 150,
  nameLength: 48,
} as const;

export interface Placement {
  north: number;
  east: number;
}

export type PieceSpec =
  | (Placement & { type: 'cube'; storeys?: number })
  | (Placement & { type: 'pole'; height: number })
  | (Placement & { type: 'pylon'; height: number })
  | (Placement & { type: 'ladder'; heading?: number; width?: number; gaps?: number; gap?: number; base?: number })
  | (Placement & { type: 'arch'; radius: number; heading?: number })
  | (Placement & { type: 'chimney'; bore?: number; base?: number; height?: number })
  | (Placement & { type: 'roundChimney'; radius?: number; base?: number; height?: number })
  | (Placement & { type: 'tube'; up: number; radius?: number; halfLength?: number; heading?: number })
  | (Placement & { type: 'window'; up: number; half?: number; heading?: number });

export type CheckpointSpec =
  | { gate: Placement & { heading: number; up?: number; halfWidth?: number; halfHeight?: number } }
  | { flag: Placement & { heading: number; side: 1 | -1; height?: number; passWidth?: number } }
  /** A run of evenly spaced gates on one heading. Twenty gates, one line. */
  | { gateLine: Placement & { heading: number; count: number; spacing: number; up?: number } }
  /** Gates evenly round a circle, each facing along the tangent. */
  | { gateRing: Placement & { count: number; radius: number; up?: number; clockwise?: boolean } };

export interface TrackSpec {
  version: number;
  name: string;
  start: { north: number; east: number; yawDeg: number };
  laps?: number;
  pieces?: PieceSpec[];
  course?: CheckpointSpec[];
}

export interface ValidationResult {
  ok: boolean;
  /** Everything wrong with it, not just the first thing. */
  errors: string[];
  /** The spec, with defaults filled in and numbers clamped. */
  spec: TrackSpec | null;
}

const PIECE_TYPES = new Set([
  'cube',
  'pole',
  'pylon',
  'ladder',
  'arch',
  'chimney',
  'roundChimney',
  'tube',
  'window',
]);

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Check and normalise a spec.
 *
 * Reports *every* problem rather than the first, because a pilot editing JSON
 * by hand wants the list, not a game of whack-a-mole. Coordinates are clamped
 * rather than rejected: a track that puts a gate slightly outside the ground
 * plane is a mistake worth fixing quietly, where one that asks for 1e9 is an
 * attack worth stopping.
 */
export function validateTrackSpec(input: unknown, builtInNames: string[] = []): ValidationResult {
  const errors: string[] = [];
  const fail = (m: string): null => {
    errors.push(m);
    return null;
  };

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['not an object — a track is a JSON object'], spec: null };
  }
  const raw = input as Record<string, unknown>;

  if (raw.version !== TRACK_SPEC_VERSION) {
    // Refused rather than guessed at: a format that silently reinterprets old
    // data is how a track quietly becomes a different track.
    return {
      ok: false,
      errors: [`version ${String(raw.version)} — this build reads version ${TRACK_SPEC_VERSION}`],
      spec: null,
    };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, SPEC_LIMITS.nameLength) : '';
  if (name.length === 0) fail('name is missing');
  // Stored by name, and the map a pilot picks is found by name — so a
  // collision would silently repoint someone at a different track. This
  // project has been bitten twice by identity through position; a duplicate
  // name is the same mistake wearing a different hat.
  if (builtInNames.includes(name)) fail(`"${name}" is already a built-in map — choose another name`);

  const startRaw = (raw.start ?? {}) as Record<string, unknown>;
  const start = {
    north: finite(startRaw.north) ? clamp(startRaw.north, -SPEC_LIMITS.extent, SPEC_LIMITS.extent) : 0,
    east: finite(startRaw.east) ? clamp(startRaw.east, -SPEC_LIMITS.extent, SPEC_LIMITS.extent) : 0,
    yawDeg: finite(startRaw.yawDeg) ? startRaw.yawDeg : 0,
  };
  if (!finite(startRaw.north) || !finite(startRaw.east)) {
    fail('start needs north and east');
  }

  const pieces: PieceSpec[] = [];
  const rawPieces = Array.isArray(raw.pieces) ? raw.pieces : [];
  if (rawPieces.length > SPEC_LIMITS.pieces) {
    fail(`${rawPieces.length} pieces — the limit is ${SPEC_LIMITS.pieces}`);
  }
  rawPieces.slice(0, SPEC_LIMITS.pieces).forEach((p, i) => {
    const o = p as Record<string, unknown>;
    if (typeof o?.type !== 'string' || !PIECE_TYPES.has(o.type)) {
      fail(`piece ${i + 1}: unknown type ${JSON.stringify(o?.type)}`);
      return;
    }
    if (!finite(o.north) || !finite(o.east)) {
      fail(`piece ${i + 1} (${o.type}): needs north and east`);
      return;
    }
    const out: Record<string, unknown> = { ...o };
    out.north = clamp(o.north, -SPEC_LIMITS.extent, SPEC_LIMITS.extent);
    out.east = clamp(o.east, -SPEC_LIMITS.extent, SPEC_LIMITS.extent);
    for (const k of ['up', 'height', 'base', 'radius', 'bore', 'half', 'width', 'gap', 'halfLength']) {
      if (o[k] !== undefined) {
        if (!finite(o[k])) {
          fail(`piece ${i + 1} (${o.type}): ${k} is not a number`);
          return;
        }
        out[k] = clamp(o[k] as number, 0, SPEC_LIMITS.height);
      }
    }
    if (o.storeys !== undefined) out.storeys = clamp(Math.round(Number(o.storeys) || 1), 1, 8);
    if (o.gaps !== undefined) out.gaps = clamp(Math.round(Number(o.gaps) || 1), 1, 12);
    // Checked field by field above rather than by a type assertion alone —
    // the cast is the last step, not the argument.
    pieces.push(out as unknown as PieceSpec);
  });

  const course: CheckpointSpec[] = [];
  const rawCourse = Array.isArray(raw.course) ? raw.course : [];
  rawCourse.forEach((c, i) => {
    const o = c as Record<string, unknown>;
    const key = ['gate', 'flag', 'gateLine', 'gateRing'].find((k) => o?.[k] !== undefined);
    if (!key) {
      fail(`checkpoint ${i + 1}: expected one of gate, flag, gateLine, gateRing`);
      return;
    }
    const body = o[key] as Record<string, unknown>;
    if (!finite(body?.north) || !finite(body?.east) || !finite(body?.heading ?? 0)) {
      fail(`checkpoint ${i + 1} (${key}): needs north, east and heading`);
      return;
    }
    if (key === 'flag' && body.side !== 1 && body.side !== -1) {
      fail(`checkpoint ${i + 1} (flag): side must be 1 or -1`);
      return;
    }
    if (key === 'gateLine' || key === 'gateRing') {
      const count = Math.round(Number(body.count) || 0);
      if (count < 1 || count > SPEC_LIMITS.checkpoints) {
        fail(`checkpoint ${i + 1} (${key}): count must be 1 to ${SPEC_LIMITS.checkpoints}`);
        return;
      }
      body.count = count;
    }
    course.push(o as CheckpointSpec);
  });

  const total = countCheckpoints(course);
  if (total > SPEC_LIMITS.checkpoints) {
    fail(`${total} checkpoints — the limit is ${SPEC_LIMITS.checkpoints}`);
  }

  const laps = finite(raw.laps) ? clamp(Math.round(raw.laps), 1, 20) : 3;

  if (errors.length > 0) return { ok: false, errors, spec: null };
  return {
    ok: true,
    errors: [],
    spec: { version: TRACK_SPEC_VERSION, name, start, laps, pieces, course },
  };
}

/** How many checkpoints a course expands to, generators included. */
export function countCheckpoints(course: CheckpointSpec[]): number {
  let n = 0;
  for (const c of course) {
    if ('gateLine' in c) n += c.gateLine.count;
    else if ('gateRing' in c) n += c.gateRing.count;
    else n += 1;
  }
  return n;
}

const DEG = Math.PI / 180;

function gateAt(
  north: number,
  east: number,
  up: number,
  headingDeg: number,
  halfWidth = GATE_HALF_W,
  halfHeight = GATE_HALF_H,
): Gate {
  const r = headingDeg * DEG;
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
}

/**
 * Expand a course spec into the checkpoints the timer reads.
 *
 * The generators are the reason this is worth having: a ring of twenty gates is
 * one line here and twenty entries otherwise, and a hand-written circle would
 * never be exactly round.
 */
export function expandCourse(spec: CheckpointSpec[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const c of spec) {
    if ('gate' in c) {
      const g = c.gate;
      out.push(gateAt(g.north, g.east, g.up ?? GATE_UP, g.heading, g.halfWidth, g.halfHeight));
    } else if ('flag' in c) {
      const f = c.flag;
      const r = f.heading * DEG;
      out.push({
        kind: 'flag',
        north: f.north,
        east: f.east,
        height: f.height ?? 7,
        dirN: Math.cos(r),
        dirE: Math.sin(r),
        side: f.side,
        passWidth: f.passWidth ?? 6,
      });
    } else if ('gateLine' in c) {
      const l = c.gateLine;
      const r = l.heading * DEG;
      for (let i = 0; i < l.count; i++) {
        out.push(
          gateAt(
            l.north + Math.cos(r) * l.spacing * i,
            l.east + Math.sin(r) * l.spacing * i,
            l.up ?? GATE_UP,
            l.heading,
          ),
        );
      }
    } else {
      const g = c.gateRing;
      const dir = g.clockwise === false ? -1 : 1;
      for (let i = 0; i < g.count; i++) {
        const th = ((i / g.count) * Math.PI * 2 * dir);
        // On the circle, facing along the tangent — the same construction the
        // built-in Circle map uses, so a hand-written ring flies like it.
        const heading = (Math.atan2(Math.cos(th) * dir, -Math.sin(th) * dir) / DEG);
        out.push(
          gateAt(
            g.north + Math.cos(th) * g.radius,
            g.east + Math.sin(th) * g.radius,
            g.up ?? GATE_UP,
            heading,
          ),
        );
      }
    }
  }
  return out;
}

/** The course a spec describes, or null when it has none. */
export function courseFromSpec(spec: TrackSpec): Course | null {
  if (!spec.course || spec.course.length === 0) return null;
  return {
    name: spec.name,
    start: spec.start,
    checkpoints: expandCourse(spec.course),
    defaultLaps: spec.laps ?? 3,
  };
}
