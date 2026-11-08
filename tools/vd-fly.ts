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

const argv = process.argv.slice(2);
const num = (k: string, d: number): number => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
// Hover from the throttle steps: 25% stayed on the pad, 40% climbed at ~6
// m/s^2; with sqrt(thrust) linear in throttle and ~6 g at full, 1 g is ~27%.
const HOVER = num('hover', 0.22); // flight 3: still climbing at 0.22-0.26, sinking at 0.20
const LEAN = num('lean', 8);
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
const feed = setInterval(() => port.send(sticks), 4);

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
  console.log(`end: ${why}`);
  sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  setTimeout(() => {
    sticks = { ...sticks, buttons: 1 }; // Reset
    setTimeout(() => {
      sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
      setTimeout(() => {
        stop();
        clearInterval(feed);
        writeFileSync(join(outDir, 'fly.csv'), log.join('\n') + '\n');
        port.close();
        console.log(`log: ${join(outDir, 'fly.csv')}, video: ${join(outDir, 'fly.mp4')}`);
        setTimeout(() => process.exit(0), 800);
      }, 400);
    }, 600);
  }, 300);
}

function control(s: Seen, t: number): void {
  const haveHorizon = Number.isFinite(s.horizonY) && s.horizonCover > 0.3;
  noHorizon = haveHorizon ? 0 : noHorizon + 1;
  if (noHorizon > 4) return finish('horizon lost');
  if (!haveHorizon) return; // hold the last sticks for a frame or two

  // Attitude from the horizon.
  const roll = -Math.atan(s.horizonSlope) * DEG; // right wing down positive
  const pitch = (Math.atan((y0 - CY) / F) - Math.atan((s.horizonY - CY) / F)) * DEG; // nose down positive

  const tf = t - t0;
  // Lean in gently once airborne and level.
  // No lean while the gate is lost below us: sort out height first.
  const below = s.gate?.edge === 'bottom' || (!s.gate && !!last && last.y > FH * 0.8);
  const leanTarget = tf < 1.2 || below ? 0 : Math.min(LEAN, (tf - 1.2) * 6);
  // Bank towards the marker: yaw alone points the nose at the gate but does
  // not move the quad sideways, and flight 4 clipped the arch's left leg
  // with the marker drifting right faster than the nose followed.
  let rollTarget = 0;
  const pitchRate = 5 * (leanTarget - pitch);

  // Gate: heading and height.
  let yawRate = 0;
  let el = lastEl;
  if (s.gate && s.gate.edge) {
    // An edge arrow: turn towards it, nudge height, nothing more.
    if (s.gate.edge === 'left') yawRate = -40;
    else if (s.gate.edge === 'right') yawRate = 40;
    // Below the picture means we are well above it: descend firmly.
    el = s.gate.edge === 'bottom' ? -0.15 : s.gate.edge === 'top' ? 0.12 : 0;
  } else if (s.gate) {
    gateSeen = true;
    lostGateAt = 0;
    if (s.gate.w > FW * 0.25) gateBig = t;
    const bearing = Math.atan((s.gate.x - CX) / F) * DEG;
    yawRate = 2.5 * bearing;
    if (tf > 1.2) rollTarget = clamp(1.2 * bearing, 12);
    const hAtGate = s.horizonY + s.horizonSlope * (s.gate.x - CX);
    el = Math.atan((hAtGate - s.gate.y) / F); // rad, positive = gate above our eye line
  } else if (gateSeen) {
    if (!lostGateAt) lostGateAt = t;
    // Lost, not through: keep going towards where it was last seen.
    if (last && !gateBig) {
      if (last.y > FH * 0.8) el = -0.12;
      else if (last.y < FH * 0.2) el = 0.1;
      if (last.x < FW * 0.2) yawRate = -40;
      else if (last.x > FW * 0.8) yawRate = 40;
    }
  }
  if (s.gate && !s.gate.edge) last = { x: s.gate.x, y: s.gate.y };
  const rollRate = 5 * (rollTarget - roll);
  const dEl = (el - lastEl) * 30;
  lastEl = el;
  const tilt = Math.cos(roll / DEG) * Math.cos(pitch / DEG);
  let thr = HOVER / Math.max(0.6, tilt) + 0.5 * el + 0.15 * dEl;
  // Off the pad with a fixed, gentle climb; height feedback only once flying.
  if (tf < 0.35) thr = HOVER + 0.05;
  thr = Math.max(HOVER - 0.08, Math.min(HOVER + 0.15, thr));

  sticks = {
    throttle: thr,
    roll: clamp(rollRate / ROLL_RATE, 0.35),
    pitch: clamp(pitchRate / PITCH_RATE, 0.35),
    yaw: clamp(yawRate / YAW_RATE, 0.3),
  };
  log.push(
    [tf.toFixed(3), phase, s.horizonY.toFixed(1), s.horizonSlope.toFixed(4), s.horizonCover.toFixed(2),
      s.gate?.x.toFixed(1) ?? '', s.gate?.y.toFixed(1) ?? '', s.gate?.w ?? '', s.gate?.h ?? '',
      roll.toFixed(1), pitch.toFixed(1), el.toFixed(3), thr.toFixed(3),
      sticks.roll.toFixed(3), sticks.pitch.toFixed(3), sticks.yaw.toFixed(3)].join(','),
  );

  if (lostGateAt && gateBig && t - lostGateAt > 0.4) {
    // Marker gone: through the gate (it moves to the next one) or lost it.
    if (gateBig && lostGateAt - gateBig < 1.0) console.log(`through gate 1 at ${(lostGateAt - t0).toFixed(2)} s?`);
    phase = 'through';
    endAt = endAt || t + 1.0;
  }
  if (endAt && t > endAt) return finish(gateBig ? 'marker passed' : 'marker lost');
  if (tf > 12) return finish('timeout');
}

const start = performance.now();
const stop = frames(
  (f, t) => {
    if (phase === 'done') return;
    const s = look(f, FW, FH);
    const since = (t - start) / 1000;
    if (phase === 'reset') {
      // Reset to the pad first, then settle.
      if (since < 0.1) sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0, buttons: 1 };
      else sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
      if (since > 1.8) phase = 'level';
      return;
    }
    if (phase === 'level') {
      if (Number.isFinite(s.horizonY)) y0s.push(s.horizonY);
      if (y0s.length >= 10) {
        y0s.sort((a, b) => a - b);
        y0 = y0s[5]!;
        console.log(`level horizon at y=${y0}, gate ${s.gate ? `${s.gate.x.toFixed(0)},${s.gate.y.toFixed(0)}` : 'not seen'}`);
        phase = 'fly';
        t0 = t / 1000;
      }
      return;
    }
    control(s, t / 1000);
  },
  { record: join(outDir, 'fly.mp4') },
);
process.on('SIGINT', () => finish('interrupted'));
