/**
 * The learning pilot, headless: measure the quad, practise a course, fly the
 * best lap it can, and write down the sticks.
 *
 *   npm run learn -- <course> [--laps N] [--schedule 0.5,0.6,...] [--runs K]
 *                    [--mass 1.3] [--latency 0.03] [--noise 0.05] [--hz 200]
 *                    [--rates path/to/log.bbl] [--out dir]
 *
 * Writes, into --out (default measurements/learned/<course>):
 *   sticks.csv   t, throttle, roll, pitch, yaw — the best run at radio rate
 *   lap.json     the same run in replay-video's format
 *   session.json what was measured and how each practice run went
 *
 * The stick trace is what was flown *with feedback*. It is not a recording to
 * play back blind: this model diverges within milliseconds of a 1e-4 stick
 * difference, so an open-loop replay of a whole lap leaves the course. The
 * trace is the output for watching, comparing and, later, driving a virtual
 * joystick from a closed loop.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACKS } from '../src/render/track.ts';
import { MeshBuilder } from '../src/render/mesh.ts';
import type { Obstacle } from '../src/flight/collision.ts';
import { defaultRates, type RateProfile } from '../src/flight/rates.ts';
import { readHeaderOnly } from '../src/flight/blackbox.ts';
import { tuneFromHeader } from '../src/flight/tune.ts';
import { FpvsimEnv } from '../src/pilot/env.ts';
import { practise } from '../src/pilot/practice.ts';
import { trackFromSaved, type SavedVdTrack } from '../src/render/velocidrone.ts';
import type { Track } from '../src/render/track.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const flagged = new Set<string>();
  process.argv.forEach((a, i) => {
    if (a.startsWith('--')) flagged.add(process.argv[i + 1] ?? '');
  });
  const wanted = process.argv.slice(2).find((a) => !a.startsWith('--') && !flagged.has(a)) ?? 'Circle';
  const raceMaps = TRACKS.filter((t) => t.course);
  let track: Track | undefined = raceMaps.find((t) => t.name.toLowerCase().includes(wanted.toLowerCase()));
  // --vd <track.json>: a Velocidrone import (npm run vd:import), not a built-in.
  const vdFile = arg('vd');
  if (vdFile) {
    const imp = trackFromSaved(JSON.parse(readFileSync(vdFile, 'utf8')) as SavedVdTrack);
    track = imp.track;
    for (const n of imp.notes) console.log(`import: ${n}`);
  }
  if (!track || !track.course) {
    console.error(`no race map matching "${wanted}" — have: ${raceMaps.map((t) => t.name).join(', ')}`);
    return 2;
  }
  const course = track.course;
  const laps = Number(arg('laps') ?? (vdFile ? course.defaultLaps : 2));

  let rates: RateProfile = defaultRates();
  // --vd-rates: the rates in measurements/velocidrone/quad-settings.json (the
  // Velocidrone quad's, as shown on its settings screen), Betaflight curve.
  if (process.argv.includes('--vd-rates')) {
    const q = JSON.parse(readFileSync('measurements/velocidrone/quad-settings.json', 'utf8')).rates as Record<'roll' | 'pitch' | 'yaw', { rcRate: number; rate: number; rcExpo: number }>;
    const ax = [q.roll, q.pitch, q.yaw] as const;
    rates = { type: 'betaflight', rcRate: ax.map((a) => a.rcRate * 100) as [number, number, number], rate: ax.map((a) => a.rate * 100) as [number, number, number], expo: ax.map((a) => a.rcExpo * 100) as [number, number, number] };
    console.log(`rates: Velocidrone quad (${[0, 1, 2].map((i) => Math.round(200 * ax[i]!.rcRate / (1 - ax[i]!.rate))).join('/')} deg/s at full stick)`);
  }
  const ratesFile = arg('rates');
  if (ratesFile) {
    const header = readHeaderOnly(new Uint8Array(readFileSync(ratesFile)));
    rates = tuneFromHeader(header.raw).rates;
    console.log(`rates from ${ratesFile}: ${rates.type}`);
  }

  const obstacles: Obstacle[] = [];
  track.build(new MeshBuilder(), obstacles);
  const env = new FpvsimEnv({
    rates,
    course,
    obstacles,
    laps,
    massScale: arg('mass') ? Number(arg('mass')) : undefined,
    latency: arg('latency') ? Number(arg('latency')) : undefined,
    posNoise: arg('noise') ? Number(arg('noise')) : undefined,
    velNoise: arg('noise') ? Number(arg('noise')) : undefined,
  });

  console.log(`\x1b[1m${track.name}\x1b[0m — ${course.checkpoints.length} checkpoints, ${laps} laps, ${obstacles.length} obstacles`);
  const t0 = performance.now();
  const session = practise(env, course, obstacles, rates, {
    laps,
    schedule: arg('schedule')?.split(',').map(Number),
    runsPerRound: arg('runs') ? Number(arg('runs')) : undefined,
    actHz: arg('hz') ? Number(arg('hz')) : undefined,
    log: (s) => console.log(s),
  });
  const wall = (performance.now() - t0) / 1000;

  const best = session.best;
  if (!best) {
    console.log(`\nno clean run in ${session.history.length} attempts (${wall.toFixed(0)} s)`);
    return 1;
  }
  const bestLap = Math.min(...best.run.laps);
  console.log(
    `\nbest: lap ${bestLap.toFixed(2)} s at ${(best.aggression * 100).toFixed(0)}% of the envelope, ` +
      `laps ${best.run.laps.map((t) => t.toFixed(2)).join(' / ')}, margin ${best.run.margin.toFixed(2)} m, ` +
      `${session.history.length} practice runs, ${wall.toFixed(0)} s`,
  );

  const out = arg('out') ?? join('measurements', 'learned', course.name.toLowerCase().replace(/\s+/g, '-'));
  mkdirSync(out, { recursive: true });
  const csv = ['t,throttle,roll,pitch,yaw'];
  for (const { t, s } of best.run.sticks) {
    csv.push(`${t.toFixed(3)},${s.throttle.toFixed(4)},${s.roll.toFixed(4)},${s.pitch.toFixed(4)},${s.yaw.toFixed(4)}`);
  }
  writeFileSync(join(out, 'sticks.csv'), csv.join('\n') + '\n');

  // Re-fly the best run with a recorder on, for replay-video.
  const samples: unknown[] = [];
  let lastFrame = -1;
  const recEnv = new FpvsimEnv({
    rates,
    course,
    obstacles,
    laps,
    massScale: arg('mass') ? Number(arg('mass')) : undefined,
    onStep: (sim, sticks) => {
      // Exactly 60 Hz, which is what the file says it is.
      const frame = Math.floor(sim.time * 60);
      if (frame === lastFrame) return;
      lastFrame = frame;
      const t = sim.telemetry;
      samples.push({
        t: sim.time,
        n: sim.pos.x,
        e: sim.pos.y,
        u: -sim.pos.z,
        qw: sim.q.w,
        qx: sim.q.x,
        qy: sim.q.y,
        qz: sim.q.z,
        speed: t.speed,
        throttle: sticks.throttle,
        roll: sticks.roll,
        pitch: sticks.pitch,
        yaw: sticks.yaw,
        batteryV: t.batteryV,
        batteryA: t.batteryA,
      });
    },
  });
  // Replaying stored sticks open loop is what the header says not to do — but
  // this sim is deterministic, so the *same* sticks from the *same* reset
  // reproduce the run exactly, which makes the video the run that was scored.
  // It is checked rather than assumed, and it would not hold anywhere else.
  recEnv.reset();
  let i = 0;
  while (i < best.run.sticks.length && !recEnv.finished && !recEnv.crashed) {
    const next = best.run.sticks[i + 1]?.t ?? best.run.sticks[i]!.t + 0.005;
    recEnv.advance(best.run.sticks[i]!.s, next - best.run.sticks[i]!.t);
    i++;
  }
  const replayLaps = recEnv.result().laps.map((l) => l.time);
  const same = replayLaps.length === best.run.laps.length && replayLaps.every((t, k) => Math.abs(t - best.run.laps[k]!) < 0.02);
  console.log(`replay of the stored sticks: ${replayLaps.map((t) => t.toFixed(2)).join(' / ')} ${same ? '(reproduces)' : '(DIVERGED — video is not the scored run)'}`);
  writeFileSync(
    join(out, 'lap.json'),
    JSON.stringify({
      course: course.name,
      generated: new Date().toISOString(),
      source: 'learn-lap',
      laps: best.run.laps,
      holeShot: best.run.holeShot,
      hz: 60,
      samples,
    }),
  );
  writeFileSync(
    join(out, 'session.json'),
    JSON.stringify(
      {
        course: course.name,
        laps,
        envelope: session.envelope,
        best: { aggression: best.aggression, laps: best.run.laps, margin: best.run.margin, plan: best.plan.report },
        history: session.history.map((h) => ({
          aggression: h.aggression,
          finished: h.run.finished,
          crashed: h.run.crashed,
          laps: h.run.laps,
          margin: h.run.margin,
          peakError: h.run.peakError,
          feedbackRms: h.run.feedbackRms,
          reached: h.run.reached,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${out}/sticks.csv, lap.json, session.json`);
  return 0;
}

process.exit(main());
