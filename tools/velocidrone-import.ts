/**
 * Pull a track out of Velocidrone's local database and save it for fpvsim.
 *
 *   npm run vd:import -- <name substring> [--db path/to/user11.db]
 *   npm run vd:import -- --list [substring]
 *
 * Velocidrone keeps downloaded tracks in SQLite, not as files:
 *   ~/Library/Application Support/com.velocidrone.velocidrone/user11.db
 *     table tracks(id, scene_id, name, value)   value is the track JSON
 *   ~/Library/Application Support/com.velocidrone.velocidrone/settings.db
 *     table trackprefabs(id, name, type)        what each prefab number is
 * Both are opened read-only; the game's files are never written.
 *
 * Writes measurements/velocidrone/<slug>/track.json — git-ignored on purpose:
 * the track is its author's work (see .gitignore).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ImportOptions, trackFromVelocidrone, type VdTrack } from '../src/render/velocidrone.ts';

const VD = join(homedir(), 'Library/Application Support/com.velocidrone.velocidrone');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function slugOf(name: string): string {
  return decodeURIComponent(name.replace(/\+/g, ' '))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function main(): number {
  const user = new DatabaseSync(arg('db') ?? join(VD, 'user11.db'), { readOnly: true });
  const settings = new DatabaseSync(arg('settings') ?? join(VD, 'settings.db'), { readOnly: true });
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--db') && !all[i - 1]?.startsWith('--settings'));
  const wanted = (positional[0] ?? '').toLowerCase();

  type Row = { id: number; name: string; value: string; date: string };
  const rows = user.prepare('select id, name, value, date from tracks').all() as Row[];
  const matches = rows.filter((r) => decodeURIComponent(r.name.replace(/\+/g, ' ')).toLowerCase().includes(wanted));
  if (process.argv.includes('--list') || matches.length !== 1) {
    if (!process.argv.includes('--list')) {
      console.error(matches.length === 0 ? `no track matching "${wanted}"` : `${matches.length} tracks match "${wanted}" — be more specific:`);
    }
    for (const r of matches.slice(0, 40)) console.log(`  ${r.id}  ${decodeURIComponent(r.name.replace(/\+/g, ' '))}  (${r.date})`);
    return process.argv.includes('--list') ? 0 : 2;
  }
  const row = matches[0]!;
  const name = decodeURIComponent(row.name.replace(/\+/g, ' '));
  let raw: VdTrack;
  try {
    raw = JSON.parse(row.value) as VdTrack;
  } catch {
    // Newer tracks are stored encoded rather than as plain JSON; not handled yet.
    console.error(`${name}: the stored track is not plain JSON (newer encoded format?) — not supported yet`);
    return 1;
  }
  const prefabs = new Map<number, string>();
  for (const p of settings.prepare('select id, name from trackprefabs').all() as { id: number; name: string }[]) {
    prefabs.set(p.id, p.name);
  }
  const used = new Set([...raw.gates, ...(raw.barriers ?? [])].map((o) => o.prefab));
  const usedNames = Object.fromEntries([...used].sort((a, b) => a - b).map((id) => [id, prefabs.get(id) ?? '?']));

  const out = join('measurements', 'velocidrone', slugOf(name));
  mkdirSync(out, { recursive: true });
  // Hand corrections are the only part of this file a person wrote, so a
  // re-import keeps them.
  const file = join(out, 'track.json');
  const kept = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { overrides?: unknown }).overrides : undefined;
  writeFileSync(
    file,
    JSON.stringify({ name, velocidroneId: row.id, downloaded: row.date, prefabs: usedNames, track: raw, ...(kept ? { overrides: kept } : {}) }, null, 1),
  );

  const imp = trackFromVelocidrone(raw, { name, prefabs, ...(kept ? { overrides: kept as ImportOptions['overrides'] } : {}) });
  console.log(`${name}: ${imp.course.checkpoints.length} checkpoints, start ${imp.course.start.north.toFixed(1)} N ${imp.course.start.east.toFixed(1)} E facing ${imp.course.start.yawDeg.toFixed(0)} deg`);
  for (const r of imp.table) {
    console.log(`  ${String(r.gate).padStart(2)}  ${r.kind.padEnd(16)} ${r.prefab.padEnd(26)} ${r.north.toFixed(1).padStart(6)} N ${r.east.toFixed(1).padStart(6)} E ${r.up.toFixed(2).padStart(5)} up   ${r.dir}`);
  }
  for (const n of imp.notes) console.log(`  note: ${n}`);
  console.log(`wrote ${out}/track.json`);
  return 0;
}

process.exit(main());
