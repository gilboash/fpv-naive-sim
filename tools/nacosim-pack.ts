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
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
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

/** The files that go in the zip, relative to edgetx/, sorted. */
function sources(root: string): string[] {
  const files: string[] = [];
  walk(root, 'SCRIPTS/NacoSim', files);
  // Only NacoSim: SCRIPTS/TOOLS also holds dev probes that are not a release.
  // Compiled copies are the radio's own cache and are never part of one.
  const keep = files.filter((f) => !f.endsWith('.luac'));
  keep.push('SCRIPTS/TOOLS/NacoSim.lua', 'README.md');
  return keep.sort();
}

export function packKey(root: string): string {
  return sources(root).map((f) => `${f}:${statSync(join(root, f)).mtimeMs}:${statSync(join(root, f)).size}`).join('|');
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
      const dest = join(tmp, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, f), dest);
      utimesSync(dest, FIXED_TIME, FIXED_TIME);
    }
    const out = join(tmp, 'out.zip');
    try {
      execFileSync('zip', ['-X', '-q', out, '-@'], { cwd: tmp, input: files.join('\n') + '\n' });
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
