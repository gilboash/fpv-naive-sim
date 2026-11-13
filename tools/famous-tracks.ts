/**
 * Builds the web sim's famous tracks from the radio's map files, so the two apps
 * fly one layout from one source.
 *
 *   npm run tracks:famous          writes src/render/famous-tracks.ts
 *   npm run tracks:famous -- --check   fails if that file is out of date
 *
 * The .map files in edgetx/SCRIPTS/NacoSim/maps are the source (format in
 * edgetx/README.md). They were converted from Velocidrone files, so the layouts
 * are other designers' work: see the credits in edgetx/README.md and on /web.
 * Each track is moved so its gates are centred on the origin, on the ground
 * plane, and validated with the same function a pilot's own track goes through.
 *
 * Generated as TypeScript rather than imported as `?raw` because the flight
 * checks run under plain Node, which has no Vite to resolve that.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTrackSpec, type CheckpointSpec, type TrackSpec } from '../src/render/track-spec.ts';

const MAPS = 'edgetx/SCRIPTS/NacoSim/maps';
const OUT = 'src/render/famous-tracks.ts';

/** Which maps, in menu order. The micro track is left out: 1.2 x 0.8 m gates are for whoops. */
const PICK = ['macabim', 'mgp-q2024-1', 'mgp-q2024-2', 'mgp-q2024-3'];
/** Clearer names on the web than the radio's short ones. */
const NAMES: Record<string, string> = {
  'mgp-q2024-1': 'MultiGP Qualifier 2024 #1',
  'mgp-q2024-2': 'MultiGP Qualifier 2024 #2',
  'mgp-q2024-3': 'MultiGP Qualifier 2024 #3',
};

const r1 = (v: number): number => Math.round(v * 10) / 10;

export function specFromMap(key: string, text: string): TrackSpec {
  let name = key;
  let start = { north: 0, east: 0, yawDeg: 0 };
  const course: CheckpointSpec[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [tag, ...rest] = line.split(/\s+/);
    const n = rest.map(Number);
    if (tag === 'name') name = rest.join(' ');
    else if (tag === 'start') start = { east: n[0]!, north: n[1]!, yawDeg: n[2]! };
    // g <x east> <y north> <z up> <heading> <half width> <half height>
    // The maps put some openings exactly 0.2 m off the grass, which is the
    // track check's floor; 10 cm more keeps them clear of rounding.
    else if (tag === 'g') course.push({ gate: { east: n[0]!, north: n[1]!, up: r1(Math.max(n[2]!, n[5]! + 0.3)), heading: n[3]!, halfWidth: n[4]!, halfHeight: n[5]! } });
    // f <x> <y> <pole height> <heading> <side> <pass width>
    else if (tag === 'f') course.push({ flag: { east: n[0]!, north: n[1]!, height: n[2]!, heading: n[3]!, side: n[4] as 1 | -1, passWidth: n[5]! } });
  }
  name = NAMES[key] ?? name;
  // Two gates side by side (Macabim's double gate) whose estimated widths
  // overlap: narrow both to half their spacing, so they share one post.
  const gates = course.flatMap((c) => ('gate' in c ? [c.gate] : []));
  for (const a of gates) {
    for (const b of gates) {
      if (a === b || a.heading !== b.heading || Math.abs(a.up! - b.up!) > 0.5) continue;
      const gap = Math.hypot(a.north - b.north, a.east - b.east);
      if (gap < a.halfWidth! + b.halfWidth! && gap > 1) {
        a.halfWidth = b.halfWidth = r1(gap / 2 - 0.05);
      }
    }
  }
  // A flag pole standing by a gate is that gate's post in this sim (the drawn
  // gate leaves the post out and the pole stands in for it). The converted
  // positions are estimates and put some poles 0.2-0.3 m off the post,
  // so snap each such pole onto the post it stands for.
  for (const c of course) {
    if (!('flag' in c)) continue;
    const f = c.flag;
    for (const d of course) {
      if (!('gate' in d)) continue;
      const g = d.gate;
      if (Math.hypot(f.north - g.north, f.east - g.east) >= g.halfWidth! + 0.4) continue;
      const h = (g.heading * Math.PI) / 180;
      const acrossN = -Math.sin(h);
      const acrossE = Math.cos(h);
      const along = (f.north - g.north) * acrossN + (f.east - g.east) * acrossE;
      const s = along >= 0 ? 1 : -1;
      f.north = g.north + s * g.halfWidth! * acrossN;
      f.east = g.east + s * g.halfWidth! * acrossE;
      break;
    }
  }
  // Centre on the origin, so the track sits in the middle of the ground.
  const ns = course.map((c) => ('gate' in c ? c.gate : 'flag' in c ? c.flag : start));
  const mid = (vals: number[]): number => r1((Math.min(...vals) + Math.max(...vals)) / 2);
  const cn = mid(ns.map((p) => p.north));
  const ce = mid(ns.map((p) => p.east));
  for (const p of ns) {
    p.north = r1(p.north - cn);
    p.east = r1(p.east - ce);
  }
  start = { north: r1(start.north - cn), east: r1(start.east - ce), yawDeg: start.yawDeg };
  return { version: 1, name, start, course };
}

function main(): number {
  const specs: TrackSpec[] = [];
  for (const key of PICK) {
    const spec = specFromMap(key, readFileSync(join(MAPS, `${key}.map`), 'utf8'));
    const v = validateTrackSpec(spec);
    if (!v.ok) {
      console.error(`${key}: ${v.errors.join('; ')}`);
      return 1;
    }
    specs.push(spec);
    console.log(`${spec.name}: ${spec.course!.length} checkpoints`);
  }
  const body =
    `/**\n * Generated by tools/famous-tracks.ts from edgetx/SCRIPTS/NacoSim/maps. Do not edit:\n` +
    ` * change the .map file and run \`npm run tracks:famous\`.\n *\n` +
    ` * Gate layouts of tracks designed by others (Macabim; the MultiGP 2024 qualifiers),\n` +
    ` * converted from their Velocidrone files for practice. Sizes, directions and flag\n` +
    ` * sides are estimates. Credits in edgetx/README.md.\n */\n` +
    `import type { TrackSpec } from './track-spec.ts';\n\n` +
    `export const FAMOUS_TRACK_SPECS: TrackSpec[] = ${JSON.stringify(specs, null, 2)};\n`;
  if (process.argv.includes('--check')) {
    const now = readFileSync(OUT, 'utf8');
    if (now !== body) {
      console.error(`${OUT} is out of date: run npm run tracks:famous`);
      return 1;
    }
    console.log(`${OUT} is up to date`);
    return 0;
  }
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
  return 0;
}

process.exit(main());
