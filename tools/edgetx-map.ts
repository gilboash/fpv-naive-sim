/**
 * Turns a course from the web sim (or a Velocidrone import) into a NacoSim map
 * file for the radio: a few lines of text per track, one file per track, in
 * edgetx/SCRIPTS/NacoSim/maps/. The radio reads them from the SD card, so a
 * track is data, not code, and anyone can drop one in.
 *
 *   node --experimental-strip-types tools/edgetx-map.ts --builtin "Race vibes" [--name race-vibes] [--out dir]
 *   node --experimental-strip-types tools/edgetx-map.ts --course course.json  --name macabim    [--out dir]
 *
 * --course takes JSON { name, start: {north, east, yawDeg}, checkpoints: [...] }
 * exactly as `Course` in src/race/course.ts. Only upright gates and flags come
 * across: the radio sim has no horizontal planes (cube drop-throughs), so those
 * checkpoints are skipped and reported. Obstacles are not carried either.
 *
 * Map file (version 1), one record per line, # starts a comment:
 *   nacosim-map 1
 *   name <display name>
 *   start <x east> <y north> <heading deg>
 *   g <x> <y> <z> <heading> <half width> <half height>      upright gate
 *   f <x> <y> <pole height> <heading> <side +1|-1> <pass width>   flag
 * Coordinates in metres, x east, y north, z up; heading is compass degrees, the
 * direction of travel through the checkpoint; flag side +1 = you pass on the
 * RIGHT of the pole (it is on your left), -1 the other way: the rule is the web
 * sim's `testFlag` in src/race/race.ts, `across * side > 0`. Plain strip-types
 * TypeScript.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Course } from '../src/race/course.ts';

const r1 = (v: number): string => String(Math.round(v * 10) / 10);
const heading = (dirN: number, dirE: number): number => {
  let h = (Math.atan2(dirE, dirN) * 180) / Math.PI;
  if (h < 0) h += 360;
  return Math.round(h * 10) / 10 % 360;
};

export interface Converted {
  text: string;
  gates: number;
  flags: number;
  skipped: string[];
}

export function convert(course: Course, displayName: string): Converted {
  const lines: string[] = ['nacosim-map 1', `name ${displayName}`];
  lines.push(`# from "${course.name}": ${course.checkpoints.length} checkpoints`);
  lines.push(`start ${r1(course.start.east)} ${r1(course.start.north)} ${r1(course.start.yawDeg)}`);
  let gates = 0;
  let flags = 0;
  const skipped: string[] = [];
  course.checkpoints.forEach((cp, i) => {
    if (cp.kind === 'gate') {
      if (cp.dirU) {
        skipped.push(`checkpoint ${i + 1}: horizontal gate (cube opening)`);
        lines.push(`# checkpoint ${i + 1} skipped: horizontal gate`);
        return;
      }
      gates++;
      lines.push(`g ${r1(cp.east)} ${r1(cp.north)} ${r1(cp.up)} ${heading(cp.dirN, cp.dirE)} ${r1(cp.halfWidth)} ${r1(cp.halfHeight)}`);
    } else {
      flags++;
      lines.push(`f ${r1(cp.east)} ${r1(cp.north)} ${r1(cp.height)} ${heading(cp.dirN, cp.dirE)} ${cp.side} ${r1(cp.passWidth)}`);
    }
  });
  return { text: lines.join('\n') + '\n', gates, flags, skipped };
}

/** Reads a map file back and returns what it holds, to check a conversion. */
export function readBack(text: string): { gates: number; flags: number; start: number[] } {
  let gates = 0;
  let flags = 0;
  let start: number[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'g') gates++;
    else if (t[0] === 'f') flags++;
    else if (t[0] === 'start') start = t.slice(1).map(Number);
  }
  return { gates, flags, start };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string): string | undefined => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const out = arg('out') ?? 'edgetx/SCRIPTS/NacoSim/maps';
  let course: Course | undefined;
  const builtin = arg('builtin');
  const file = arg('course');
  if (builtin) {
    const { TRACKS } = await import('../src/render/track.ts');
    course = TRACKS.find((t) => t.name === builtin)?.course;
    if (!course) throw new Error(`no built-in race map called "${builtin}" (with a course)`);
  } else if (file) {
    course = JSON.parse(readFileSync(file, 'utf8')) as Course;
  } else {
    throw new Error('give --builtin "<map name>" or --course <course.json>');
  }
  const slug = arg('name') ?? course.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`--name must be lowercase letters, digits and dashes: "${slug}"`);
  const display = (arg('title') ?? slug.replace(/-/g, ' '));
  const c = convert(course, display);

  const back = readBack(c.text);
  if (back.gates !== c.gates || back.flags !== c.flags) throw new Error('read-back does not match what was written');
  mkdirSync(out, { recursive: true });
  const path = join(out, `${slug}.map`);
  writeFileSync(path, c.text);
  console.log(`${path}: ${c.gates} gates, ${c.flags} flags, ${c.text.length} bytes; verified by reading it back`);
  for (const s of c.skipped) console.log(`  skipped ${s}`);
}

if (process.argv[1]?.endsWith('edgetx-map.ts')) await main();
