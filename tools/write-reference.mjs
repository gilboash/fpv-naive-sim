/**
 * Turn recorded reference laps into the data the page ships.
 *
 *   node tools/write-reference.mjs out/*.json
 *
 * Times and splits only. The videos stay out of the bundle and are served from
 * /reference/ on demand — a pilot who never presses play never fetches one,
 * which is what lets a 170 KB page offer a video at all.
 *
 * Regenerate whenever a course changes or the flight model does. A reference
 * lap is only meaningful against the model that flew it, which is why the build
 * stamp and the date go into the file rather than into someone's memory.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/write-reference.mjs <recorded-lap.json>...');
  process.exit(2);
}

const build = (() => {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return `${day}-${sha}`;
  } catch {
    return day;
  }
})();

/** The map name, lower-cased and hyphenated: "180s" and "Thrust line". */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const laps = [];
for (const f of files) {
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  if (!rec.laps || rec.laps.length === 0) {
    console.error(`  ${basename(f)}: no completed lap, skipped`);
    continue;
  }
  const best = Math.min(...rec.laps);
  const video = `${slug(rec.course)}.mp4`;
  const topSpeed = rec.samples.reduce((a, s) => Math.max(a, s.speed), 0);
  laps.push({
    course: rec.course,
    lap: Number(best.toFixed(3)),
    holeShot: Number((rec.holeShot ?? 0).toFixed(3)),
    splits: (rec.splits ?? []).map((d) => Number(d.toFixed(3))),
    topSpeed: Number(topSpeed.toFixed(2)),
    // Named optimistically: the file is claimed only if it has been rendered.
    // A src pointing at a 404 would give every pilot a broken player.
    video: existsSync(`reference/${video}`) ? video : null,
    build,
    generated: new Date().toISOString(),
  });
  console.log(
    `  ${rec.course}: ${best.toFixed(2)} s, ${(rec.splits ?? []).length} splits, ` +
      `${topSpeed.toFixed(1)} m/s top${existsSync(`reference/${video}`) ? `, video ${video}` : ', no video'}`,
  );
}

laps.sort((a, b) => a.course.localeCompare(b.course));
writeFileSync('src/race/reference-data.json', `${JSON.stringify(laps, null, 2)}\n`);
console.log(`src/race/reference-data.json: ${laps.length} course(s)`);
