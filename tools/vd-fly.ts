/**
 * Fly Velocidrone by eye: horizon for attitude, the next-gate marker for
 * where to go. First goal: off the pad and through gate 1.
 *
 *   node --experimental-strip-types tools/vd-fly.ts [--hover 0.32] [--lean 8] [--out dir]
 *
 * Needs the game visible on the main display, the quad on the start pad, no
 * race running, and the ESP32 joystick free (no vd-setup helper).
 *
 * Camera geometry from the pad frame (camera tilt 15 deg): at 480x270 the
 * level horizon sits 71 px below centre, so f = 71 / tan 15 = 265 px.
 * Rates are Gilboa's (Betaflight 1.05/0.90/0.90 RC rate): near centre a unit
 * of stick is ~210 deg/s roll, ~180 pitch and yaw.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frames, FW, FH } from './vd-frames.ts';
import { look, type Seen } from './vd-vision.ts';
import { openStick, type Sticks } from './stick-port.ts';
import { toEsp } from './vd-radio.ts';
import { listen } from './vd-audio.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { trackFromSaved, type SavedVdTrack } from '../src/render/velocidrone.ts';
import type { Checkpoint } from '../src/race/course.ts';

const argv = process.argv.slice(2);
const num = (k: string, d: number): number => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
// Hover from the throttle steps: 25% stayed on the pad, 40% climbed at ~6
// m/s^2; with sqrt(thrust) linear in throttle and ~6 g at full, 1 g is ~27%.
const HOVER = num('hover', 0.25); // flight 3: still climbing at 0.22-0.26, sinking at 0.20
const LEAN = num('lean', 8);
const LIMIT = num('limit', 60);
const STOP_AFTER = num('stop-after', 0);
// Velocidrone's per-axis dead zone (DEFAULT leaves a small one): commands
// inside it are zero, and the fine corrections this pilot makes are all
// small — 0.033 of pitch held for 12 s did not move the quad at all. Jump
// non-zero commands past it. 0 once the game's dead zones are set to 0.
const DZ = num('deadzone', 0); // Gilboa zeroed axes 1-3 in the game, 2026-11-08
const dz = (v: number): number => (v === 0 ? 0 : Math.sign(v) * (DZ + Math.abs(v) * (1 - DZ)));
let stopAt = 0;
// The course as imported and corrected on the map: which checkpoints are
// poles, and on which side each is passed. The marker says where; this says
// how.
const vdPath = argv.includes('--vd') ? argv[argv.indexOf('--vd') + 1]! : 'measurements/velocidrone/macabim-2027-fril-race-2/track.json';
const course: Checkpoint[] = trackFromSaved(JSON.parse(readFileSync(vdPath, 'utf8')) as SavedVdTrack).course.checkpoints;
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : '/tmp/vd-fly';
mkdirSync(outDir, { recursive: true });

const F = 265;
const CX = FW / 2;
const CY = FH / 2;
const DEG = 180 / Math.PI;
const ROLL_RATE = 210; // deg/s per unit stick near centre
const PITCH_RATE = 180;
const YAW_RATE = 180;
const clamp = (v: number, a: number): number => Math.max(-a, Math.min(a, v));

const port = openStick(process.env.STICK_PORT);
let sticks: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
// The firmware holds the last frame and fails safe after 250 ms; keep it fed.
// A learned stick program to replay before vision takes over (Velocidrone is
// deterministic from the same start: two blind runs of one program agreed to
// well under 0.1 s of motion). Rows t,thr,rs,ps,ys at 250 Hz, t from take-off.
const prefixPath = argv.includes('--prefix') ? argv[argv.indexOf('--prefix') + 1] : undefined;
// --human <record-dir> --go <s> --until <s> [--thr-trim x]: the first seconds of
// a recorded human lap, converted to the board's sticks (vd-radio.ts) and
// replayed from the game's GO tone, which this run listens for (vd-audio.ts).
// Then the vision pilot takes over. Rows: t seconds after GO.
const humanDir = argv.includes('--human') ? argv[argv.indexOf('--human') + 1] : undefined;
const useAudio = !!humanDir || argv.includes('--audio'); // listen for GO and count gate beeps
function loadHuman(dir: string): { t: number; s: Sticks }[] {
  const go = num('go', 0);
  const until = num('until', 5);
  const trim = num('thr-trim', 0);
  const rows = readFileSync(join(dir, 'pad.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')).filter((c) => c.length === 10).map((c) => c.map(Number));
  // Chrome reports an axis as 0 until it first moves: the radio's throttle
  // was at the bottom, not mid-stick, before its first motion.
  const firstThr = rows.findIndex((r) => r[3] !== 0);
  return rows.map((r, i) => ({ t: r[0]! - go, s: toEsp(r[1]!, r[2]!, i < firstThr ? -0.9736 : r[3]!, r[4]!, trim) })).filter((r) => r.t >= -0.5 && r.t <= until);
}
const prefix = humanDir
  ? loadHuman(humanDir)
  : prefixPath
  ? readFileSync(prefixPath, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number)).map((c) => ({ t: c[0]!, s: { throttle: c[1]!, roll: c[2]!, pitch: c[3]!, yaw: c[4]! } })).filter((r) => r.t <= num('prefix-until', Infinity))
  : [];
const prefixEnd = prefix.length ? prefix[prefix.length - 1]!.t : 0;
let prefixI = 0;
const sent: string[] = ['t,thr,rs,ps,ys'];
// The flight clock is fixed to the script start, not to "10 frames read":
// determinism needs take-off at the same moment after Race Start every time.
const FLIGHT_AT = 5.33;
let goAt = 0; // audio mode: when the GO tone began, our clock
const flightStart = (): number => (useAudio ? goAt || Infinity : startWall + FLIGHT_AT);
const feed = setInterval(() => {
  const now = performance.now() / 1000;
  const tf = now - flightStart();
  if (phase === 'fly' && tf >= 0 && tf <= prefixEnd) {
    while (prefixI < prefix.length - 1 && prefix[prefixI + 1]!.t <= tf) prefixI++;
    sticks = prefix[prefixI]!.s;
  }
  port.send(sticks);
  if (phase === 'fly' && tf >= 0) sent.push(`${tf.toFixed(4)},${sticks.throttle.toFixed(4)},${sticks.roll.toFixed(4)},${sticks.pitch.toFixed(4)},${sticks.yaw.toFixed(4)}`);
}, 4);
/**
 * Is a race running? The purple button under the picture reads START or
 * ABORT, and Race Start toggles it — pressing it blindly aborted a running
 * race and the next flight began from a half-reset state.
 */
function raceRunning(): boolean {
  const win = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import("CoreGraphics"); const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)); let id = "";
    for (let i = 0; i < arr.count; i++) { const w = arr.objectAtIndex(i);
      if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) === "velocidrone" && ObjC.unwrap(w.objectForKey("kCGWindowName")) === "velocidrone") id = ObjC.unwrap(w.objectForKey("kCGWindowNumber")); }
    id`]).toString().trim();
  execFileSync('screencapture', ['-x', '-o', '-r', `-l${win}`, '-t', 'png', join(tmpdir(), 'vd-fly-btn.png')]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(tmpdir(), 'vd-fly-btn.png'), '-vf', 'crop=iw*0.094:ih*0.04:iw*0.453:ih*0.873,negate', join(tmpdir(), 'vd-fly-btn-c.png')]);
  const txt = execFileSync('tesseract', [join(tmpdir(), 'vd-fly-btn-c.png'), '-', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().toUpperCase();
  console.log(`race button reads "${txt.trim()}"`);
  return txt.includes('ABORT') || txt.includes('BORT');
}
const raceWasRunning = raceRunning();
// The clock starts after the check (which takes ~1 s), together with the
// frame clock the reset sequence runs on.
const startWall = performance.now() / 1000;
const beeps: number[] = [];
const ears = useAudio
  ? listen(() => performance.now() / 1000, {
      go: (at) => {
        goAt = at;
        console.log(`GO heard at ${(at - startWall).toFixed(2)} s`);
      },
      beep: (at) => beeps.push(at),
    })
  : null;

const log: string[] = ['t,phase,hY,slope,cover,gx,gy,gw,gh,roll,pitch,el,thr,rs,ps,ys'];
let phase: 'reset' | 'level' | 'fly' | 'through' | 'done' = 'reset';
let t0 = 0;
let y0 = 0;
const y0s: number[] = [];
let lastEl = 0;
let noHorizon = 0;
let gateSeen = false;
let gateBig = 0;
let lostGateAt = 0;
let endAt = 0;
let last: { x: number; y: number } | null = null;

function finish(why: string): void {
  if (phase === 'done') return;
  phase = 'done';
  console.log(`end: ${why}; hover learned ${hoverLearned.toFixed(3)}, airborne ${airborne}`);
  sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  setTimeout(() => {
    sticks = { ...sticks, buttons: 1 }; // Reset
    setTimeout(() => {
      sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
      setTimeout(() => {
        stop();
        clearInterval(feed);
        writeFileSync(join(outDir, 'fly.csv'), log.join('\n') + '\n');
        writeFileSync(join(outDir, 'sticks.csv'), sent.join('\n') + '\n');
        if (ears) {
          ears.stop();
          writeFileSync(join(outDir, 'events.json'), JSON.stringify({ goAt: goAt - startWall, events: ears.events.map(([a, l]) => [+(a - goAt).toFixed(3), +l.toFixed(2)]) }));
        }
        port.close();
        console.log(`log: ${join(outDir, 'fly.csv')}, video: ${join(outDir, 'fly.mp4')}`);
        setTimeout(() => process.exit(0), 800);
      }, 400);
    }, 600);
  }, 300);
}

// ---- course following: approach a marker, notice the pass, turn to the next.
let mode: 'approach' | 'turn' = 'approach';
let modeSince = 0;
let passed = 0;
let prev: { x: number; y: number; h: number; t: number } | null = null;
let aligned = 0;
let turnSign = 1;
let passStreak = 0;
let lastT = 0;
let estRoll = 0;
let estPitch = 0;
let cmdRollRate = 0;
let cmdPitchRate = 0;
let airborne = false;
let takeoffThr = HOVER - 0.02;
let hoverLearned = HOVER;
let startMarkerY: number | null = null;
let elF = 0;
let losPrev: { x: number; y: number; t: number } | null = null;
let losRate = 0;
let losRateX = 0;
let held: { g: NonNullable<Seen['gate']>; t: number } | null = null;

/** Which way to turn after checkpoint k (0-based): +1 right, -1 left, from the
 *  direction it is flown to the bearing of the next one. */
function turnFromMap(k: number): number {
  const a = course[k % course.length]!;
  const b = course[(k + 1) % course.length]!;
  let d = (Math.atan2(b.east - a.east, b.north - a.north) - Math.atan2(a.dirE, a.dirN)) * DEG;
  d = ((d + 540) % 360) - 180;
  return d >= 0 ? 1 : -1;
}

function control(s: Seen, t: number): void {
  const haveHorizon = Number.isFinite(s.horizonY) && s.horizonCover > 0.3;
  noHorizon = haveHorizon ? 0 : noHorizon + 1;
  // Without a horizon, attitude is the last one seen plus what the sticks
  // have asked for since — rate mode does what it is told. A brake once
  // pointed the up-tilted camera at the sky, and aborting on the spot threw
  // away a run that had just gone through gate 1.
  const dt = lastT ? Math.min(0.1, t - lastT) : 1 / 30;
  lastT = t;
  if (noHorizon > 45) return finish('horizon lost');
  // Attitude: what the sticks have done, corrected slowly by the horizon.
  // Rate mode holds whatever attitude it was left at, so the commanded rates
  // integrated are a good short-term estimate; the grass edge is broken by
  // trees and the fence and jumps by degrees frame to frame, and chasing it
  // put real roll — and sideways drift — into a quad that needed none.
  let roll = estRoll + cmdRollRate * dt;
  let pitch = estPitch + cmdPitchRate * dt;
  if (haveHorizon) {
    const mRoll = -Math.atan(s.horizonSlope) * DEG; // right wing down positive
    const mPitch = (Math.atan((y0 - CY) / F) - Math.atan((s.horizonY - CY) / F)) * DEG; // nose down positive
    // Ignore wild readings; pull gently towards sane ones.
    if (Math.abs(mRoll - roll) < 15) roll += (mRoll - roll) * Math.min(1, dt / 1.5);
    if (Math.abs(mPitch - pitch) < 15) pitch += (mPitch - pitch) * Math.min(1, dt / 0.8);
  }
  estRoll = roll;
  estPitch = pitch;
  const tf = t - t0;
  // Every checkpoint is a beep: count them, and turn the way the map says.
  while (beeps.length) {
    const b = beeps.shift()!;
    if (b < goAt) continue;
    passed++;
    console.log(`passed checkpoint ${passed} (beep) at ${(b - t0).toFixed(2)} s${tf <= prefixEnd ? ' (during replay)' : ''}`);
    if (STOP_AFTER && passed >= STOP_AFTER && !stopAt) stopAt = t + 0.5;
    mode = 'turn';
    modeSince = t;
    aligned = 0;
    turnSign = turnFromMap(passed - 1);
    prev = null;
    held = null;
    passStreak = 0;
  }
  // The marker blinks (it is animated); hold the last sighting through a gap
  // rather than dropping the lean every other frame, which made flight
  // "course1" creep at 2.5 deg.
  let marker = s.gate && !s.gate.edge ? s.gate : null;
  if (marker) held = { g: marker, t };
  else if (!s.gate && held && t - held.t < 0.4) marker = held.g;
  const arrow = s.gate && s.gate.edge ? s.gate.edge : '';

  // Pass: a marker that was close (tall) and central is suddenly gone, an
  // arrow, or somewhere else entirely — Velocidrone moved it to the next
  // checkpoint. (Its width barely grows; flight 5 went through at h = 39,
  // w = 18, so the old width test never fired.)
  // Pass: a marker that was close (tall) and central has been replaced, for
  // two frames running, by nothing, an arrow, a far-away marker or a much
  // smaller one — Velocidrone moved it to the next checkpoint. Real passes
  // came at h = 39-45 px; a stale held sighting at h = 20 once fooled a
  // looser test, so only fresh sightings feed it.
  const fresh = s.gate && !s.gate.edge ? s.gate : null;
  if (!useAudio && mode === 'approach' && prev && prev.h >= 34 && Math.abs(prev.x - CX) < FW * 0.3) {
    const away = fresh ? Math.hypot(fresh.x - prev.x, fresh.y - prev.y) > 70 || fresh.h < prev.h * 0.5 : true;
    passStreak = away ? passStreak + 1 : 0;
    if (passStreak >= 2 && t - prev.t < 0.6) {
      passed++;
      console.log(`passed checkpoint ${passed} at ${tf.toFixed(2)} s${tf <= prefixEnd ? ' (during replay)' : ''}`);
      if (STOP_AFTER && passed >= STOP_AFTER && !stopAt) stopAt = t + 0.5;
      mode = 'turn';
      modeSince = t;
      aligned = 0;
      turnSign = arrow === 'left' ? -1 : 1;
      prev = null;
      held = null;
      passStreak = 0;
      marker = fresh;
    }
  }
  if (fresh && (!prev || passStreak === 0)) prev = { x: fresh.x, y: fresh.y, h: fresh.h, t };

  let leanTarget = 0;
  let rollTarget = 0;
  let yawRate = 0;
  let el = 0;
  const pole = course[passed % course.length]?.kind === 'flag';
  // A pole's marker sits low; it is not a height to fly at, and a bottom arrow
  // for it does not mean we are too high.
  const below = !pole && (arrow === 'bottom' || (!s.gate && !!last && last.y > FH * 0.8));

  const cp = course[passed % course.length];
  if (marker) {
    // A pole is passed beside, not through: aim off the marker to the side
    // the map says, by an amount that grows as it gets nearer (marker height
    // is ~1/distance). side +1 = pole on the pilot's left.
    let aimX = CX;
    if (cp?.kind === 'flag') aimX = CX - cp.side * Math.min(2.2 * marker.h, 140);
    const bearing = Math.atan((marker.x - aimX) / F) * DEG;
    // Elevation against the true level line from the attitude estimate, not
    // against the grass edge: the edge is a few tens of metres away and drops
    // in the picture as the quad climbs, which turned the height loop into a
    // bounce (throttle 16-39%, and over the top of gate 1).
    const levelY = CY + F * Math.tan(Math.atan((y0 - CY) / F) - pitch / DEG);
    const hAtGate = levelY - Math.tan(roll / DEG) * (marker.x - CX);
    // Height target: hold the marker where it sat on the one approach that
    // went through (flight 5, lean ~7 deg): y ~ 150 at 480x270. The level-line
    // geometry depends on a focal length that is only estimated, and every
    // run steered by it went over the top of gate 1. Marker lower than that =
    // we are high.
    const AIM_Y = num('aim-y', 150);
    const raw = pole ? 0 : Math.atan((AIM_Y - marker.y) / F);
    void hAtGate;
    el = elF += (raw - elF) * 0.3;
    // Line of sight: flying straight into a gate, it stands still in the
    // picture (Gilboa: put it on the line and throttle into it). Drifting
    // down means we will pass over it, up means under — independent of any
    // estimate of where level is.
    if (losPrev && t - losPrev.t < 0.2 && marker === s.gate) {
      const r = -Math.atan((marker.y - losPrev.y) / F) / (t - losPrev.t); // rad/s, + = rising
      losRate += (r - losRate) * 0.35;
      const b = Math.atan((marker.x - losPrev.x) / F) / (t - losPrev.t);
      losRateX += (b - losRateX) * 0.35;
    }
    if (marker === s.gate) losPrev = { x: marker.x, y: marker.y, t };
    last = { x: marker.x, y: marker.y };
    if (mode === 'turn') {
      yawRate = 2.0 * bearing;
      aligned = Math.abs(bearing) < 8 ? aligned + 1 : 0;
      if (aligned >= 4 && t - modeSince > 0.8) {
        mode = 'approach';
        modeSince = t;
        console.log(`  next marker acquired at ${tf.toFixed(2)} s`);
      }
    } else {
      // Approach square: hold the heading (the turn phase pointed us at it)
      // and slide sideways to centre the marker, as a pilot lines up a gate.
      // Yaw-and-bank swung in on a curve and hit the arch's leg banked 15 deg.
      // Fly straight: no roll, a gentle yaw trim, pitch does the travelling;
      // the trim also damps the marker's sideways drift.
      yawRate = 1.0 * bearing + 20 * losRateX;
      rollTarget = 0;
    }
  } else if (arrow) {
    // An edge arrow says which way, not where.
    if (arrow === 'left') { yawRate = -50; turnSign = -1; }
    else if (arrow === 'right') { yawRate = 50; turnSign = 1; }
    el = pole ? 0 : arrow === 'bottom' ? -0.15 : arrow === 'top' ? 0.12 : 0;
  } else if (mode === 'turn') {
    // Nothing on screen yet: keep turning the way we were going.
    yawRate = 45 * turnSign;
  } else if (last) {
    if (last.y > FH * 0.8) el = -0.12;
    else if (last.y < FH * 0.2) el = 0.1;
    if (last.x < FW * 0.2) yawRate = -40;
    else if (last.x > FW * 0.8) yawRate = 40;
  }

  if (mode === 'approach') {
    // Pitch your way to the gate: once airborne, lean and keep leaning. The
    // marker trims heading and height on the way; waiting to see it first
    // (it is not drawn for the first seconds of a race) or stopping when it
    // slipped low kept the quad hovering in place for 18 s.
    const close = !!marker && marker.h > 24;
    leanTarget = !airborne ? 12 : close ? Math.min(LEAN, 5) : LEAN;
  } else {
    // Brake out of the pass, then turn on the spot.
    leanTarget = t - modeSince < 0.7 ? -3 : 0;
  }

  const pitchRate = 5 * (leanTarget - pitch);
  // Leave roll alone unless it is really off: centred sticks go straight.
  const rollErr = rollTarget - roll;
  const rollRate = Math.abs(rollErr) < 3 ? 0 : 3 * (rollErr - Math.sign(rollErr) * 3);
  cmdRollRate = clamp(rollRate / ROLL_RATE, 0.35) * ROLL_RATE;
  cmdPitchRate = clamp(pitchRate / PITCH_RATE, 0.35) * PITCH_RATE;
  if (tf <= prefixEnd && prefix.length) {
    // The replay is flying, not us: our estimates follow what it does.
    cmdRollRate = sticks.roll * ROLL_RATE;
    cmdPitchRate = sticks.pitch * PITCH_RATE;
    airborne = true;
  }
  const dEl = (el - lastEl) * 30;
  lastEl = el;
  const tilt = Math.cos(roll / DEG) * Math.cos(pitch / DEG);
  // Hover is learned, not assumed: the battery sags over a session and a
  // fixed 22% sat on the pad for a whole run. Off the ground, a slow integral
  // of the height error finds the real hover throttle.
  if (airborne) hoverLearned = Math.max(0.15, Math.min(0.45, hoverLearned + 0.04 * el * dt));
  // Mostly line-of-sight rate (keep the gate still in the picture), a little
  // elevation to finish at gate height.
  let thr = hoverLearned / Math.max(0.6, tilt) + 0.12 * el + (marker && !pole ? 0.35 * losRate : 0.08 * dEl);
  if (!airborne) {
    // Launch the way a racer does (Gilboa): pitch forward first, then
    // throttle, so the thrust goes into speed towards the gate instead of a
    // straight-up climb — the ramp-until-rising take-off lifted late at 35%
    // and overshot gate height every time.
    thr = tf < 0.25 ? 0.3 : hoverLearned / Math.max(0.8, tilt) + 0.03;
    if (tf > 1.0) {
      airborne = true;
      console.log(`launched; pitch ${pitch.toFixed(1)} deg`);
    }
  }
  thr = airborne ? Math.max(hoverLearned - 0.13, Math.min(hoverLearned + 0.15, thr)) : thr;

  // During the replay the feed owns the sticks; a stray control output sent
  // between two of its ticks would break the 1:1 repeat.
  if (!(prefix.length && tf <= prefixEnd)) sticks = {
    throttle: thr,
    roll: dz(clamp(rollRate / ROLL_RATE, 0.35)),
    pitch: dz(clamp(pitchRate / PITCH_RATE, 0.35)),
    yaw: dz(clamp(yawRate / YAW_RATE, 0.3)),
  };
  log.push(
    [tf.toFixed(3), `${mode}${passed}`, s.horizonY.toFixed(1), s.horizonSlope.toFixed(4), s.horizonCover.toFixed(2),
      s.gate?.x.toFixed(1) ?? '', s.gate?.y.toFixed(1) ?? '', s.gate?.w ?? '', s.gate?.h ?? '',
      roll.toFixed(1), pitch.toFixed(1), el.toFixed(3), thr.toFixed(3),
      sticks.roll.toFixed(3), sticks.pitch.toFixed(3), sticks.yaw.toFixed(3)].join(','),
  );
  if (stopAt && t > stopAt) return finish(`stopped after ${passed} passed`);
  if (tf > LIMIT) return finish(`time limit, ${passed} passed`);
}

const start = performance.now();
const stop = frames(
  (f, t) => {
    if (phase === 'done') return;
    const s = look(f, FW, FH);
    const since = (t - start) / 1000;
    if (phase === 'reset') {
      // Reset to the pad first, then settle.
      // Reset to the pad, then — checkpoints only advance in a race — press
      // Race Start and hold the throttle at zero through the ~2.2 s
      // countdown. (Throttle up during it kept the quad on the pad for 10 s
      // in the Talper replay.)
      const z = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
      if (useAudio) {
        // vd-play's start: a throttle nudge first (the game reads an axis only
        // once it moves), Reset, Recharge, Race Start; GO is heard, not timed.
        if (since > 0.1 && since < 0.2) sticks = { ...z, throttle: 0.1 };
        else if (since > 0.3 && since < 0.45) sticks = { ...z, buttons: 1 };
        else if (since > 0.9 && since < 1.2) sticks = { ...z, buttons: 4 };
        else if (raceWasRunning && since > 1.6 && since < 1.9) sticks = { ...z, buttons: 2 };
        else if (since > 2.6 && since < 3.0) {
          sticks = { ...z, buttons: 2 };
          ears?.arm();
        } else sticks = z;
        if (since > 4.0) phase = 'level';
        return;
      }
      if (since < 0.15) sticks = { ...z, buttons: 1 };
      else if (since > 0.6 && since < 0.9) sticks = { ...z, buttons: 4 }; // button 3: Recharge Battery
      else if (raceWasRunning && since > 1.0 && since < 1.3) sticks = { ...z, buttons: 2 }; // abort the running race
      else if (since > 1.5 && since < 1.9) sticks = { ...z, buttons: 2 }; // start a fresh one
      else sticks = z;
      if (since > 4.3) phase = 'level';
      return;
    }
    if (phase === 'level' && useAudio && !goAt && since > 14) {
      console.log(`no GO heard; sounds: ${ears!.events.map(([a, l]) => `${(a - startWall).toFixed(2)}(${l.toFixed(2)})`).join(' ')}`);
      return finish('no GO heard');
    }
    if (phase === 'level') {
      if (Number.isFinite(s.horizonY)) y0s.push(s.horizonY);
      if (useAudio ? goAt > 0 : t / 1000 >= startWall + FLIGHT_AT) {
        y0s.sort((a, b) => a - b);
        // The camera geometry is fixed: a level horizon far from 206 is a
        // transition frame, not a calibration.
        const m = y0s.length ? y0s[Math.floor(y0s.length / 2)]! : 206;
        y0 = Math.abs(m - 206) < 10 ? m : 206;
        console.log(`level horizon at y=${y0}, gate ${s.gate ? `${s.gate.x.toFixed(0)},${s.gate.y.toFixed(0)}` : 'not seen'}${prefix.length ? `, replaying ${prefixEnd.toFixed(2)} s first` : ''}`);
        phase = 'fly';
        t0 = useAudio ? goAt : startWall + FLIGHT_AT;
      }
      return;
    }
    control(s, t / 1000);
  },
  { record: join(outDir, 'fly.mp4') },
);
process.on('SIGINT', () => finish('interrupted'));
