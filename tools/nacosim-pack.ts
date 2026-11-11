/**
 * Builds the NacoSim download for the website from `edgetx/` in this repo, so
 * the zip on the page can never drift from the scripts: there is no committed
 * copy to forget to update. Used by vite.config.ts at build time (emitted into
 * dist/downloads) and by the dev server (served on demand).
 *
 * The zip is deterministic — fixed timestamps, sorted file list, no extra
 * attributes — so the sha256 printed on the page is the sha256 of the file
 * that is served, however many times it is rebuilt.
 *
 * Needs the `zip` command; the build fails loudly without it, because a page
 * with a dead download link is worse than a failed build. Plain strip-types
 * TypeScript (no enums or parameter properties), like the other tools.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RcPack {
  version: string;
  /** Versioned file name, e.g. NacoSim-0.5.0.zip. */
  name: string;
  data: Buffer;
  sha256: string;
  /** Changes when any packed source file changes. */
  key: string;
}

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

function walk(dir: string, base: string, out: string[]): void {
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(dir, rel, out);
    else out.push(rel);
  }
}

/** One file in the zip: where it is, and where it goes. */
interface Source {
  src: string;
  dest: string;
}

/**
 * The files that go in the zip, sorted by destination. `edgetx/maps-local/` is
 * git-ignored and holds maps that are not published in the repository; when it
 * exists on the machine doing the build, its maps ride along into
 * SCRIPTS/NacoSim/maps/ so a deployment built here carries them.
 */
function sources(root: string): Source[] {
  const files: string[] = [];
  walk(root, 'SCRIPTS/NacoSim', files);
  // Only NacoSim and its memory check: SCRIPTS/TOOLS also holds dev probes.
  // Compiled copies are the radio's own cache and are never part of one.
  const out: Source[] = files.filter((f) => !f.endsWith('.luac')).map((f) => ({ src: f, dest: f }));
  out.push({ src: 'SCRIPTS/TOOLS/NacoSim.lua', dest: 'SCRIPTS/TOOLS/NacoSim.lua' });
  out.push({ src: 'SCRIPTS/TOOLS/NacoMem.lua', dest: 'SCRIPTS/TOOLS/NacoMem.lua' });
  out.push({ src: 'README.md', dest: 'README.md' });
  if (existsSync(join(root, 'maps-local'))) {
    for (const e of readdirSync(join(root, 'maps-local'))) {
      if (e.endsWith('.map')) out.push({ src: `maps-local/${e}`, dest: `SCRIPTS/NacoSim/maps/${e}` });
    }
  }
  return out.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
}

export function packKey(root: string): string {
  return sources(root).map((f) => `${f.dest}:${statSync(join(root, f.src)).mtimeMs}:${statSync(join(root, f.src)).size}`).join('|');
}

export function packRc(repoRoot: string): RcPack {
  const root = join(repoRoot, 'edgetx');
  const settings = readFileSync(join(root, 'SCRIPTS/NacoSim/settings.lua'), 'utf8');
  const m = /S\.APP\s*=\s*"([^"]+)"/.exec(settings);
  if (!m) throw new Error('nacosim-pack: S.APP version not found in edgetx/SCRIPTS/NacoSim/settings.lua');
  const version = m[1]!;
  const files = sources(root);

  const tmp = mkdtempSync(join(tmpdir(), 'nacosim-pack-'));
  try {
    for (const f of files) {
      const dest = join(tmp, f.dest);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, f.src), dest);
      utimesSync(dest, FIXED_TIME, FIXED_TIME);
    }
    const out = join(tmp, 'out.zip');
    try {
      execFileSync('zip', ['-X', '-q', out, '-@'], { cwd: tmp, input: files.map((f) => f.dest).join('\n') + '\n' });
    } catch (err) {
      throw new Error(`nacosim-pack: could not run \`zip\` (${(err as Error).message}). Install it, or the download link on rc.html would be dead.`);
    }
    const data = readFileSync(out);
    return {
      version,
      name: `NacoSim-${version}.zip`,
      data,
      sha256: createHash('sha256').update(data).digest('hex'),
      key: packKey(root),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
