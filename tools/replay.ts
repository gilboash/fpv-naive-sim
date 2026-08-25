/**
 * Replay a flight log through the model and compare.
 *
 *   node --experimental-strip-types tools/replay.ts <log> [options]
 *
 * The log may be one of our own recordings (JSON or CSV) or a CSV produced by
 * `blackbox_decode`. Units are converted on the way in and every assumption the
 * reader had to make is printed, because a comparison whose conversion is wrong
 * looks exactly like a model that is wrong.
 *
 * Three modes, and choosing wrongly makes the answer meaningless:
 *
 *   windows  The one that validates anything. Cut the flight into short
 *            segments, start each from the state the log records at that
 *            instant, replay a few hundred milliseconds, and compare. Then
 *            aggregate. This is the default and it is the mode to use on a
 *            real log.
 *
 *   full     Reset and fly the whole logged stick sequence in one go. Useful
 *            for eyeballing gross behaviour and for nothing else — see below.
 *
 *   rates    Like full, but with translation frozen, isolating the angular
 *            dynamics from the trajectory.
 *
 * Why `full` cannot validate a model, measured rather than asserted: replaying
 * this model's own recording reproduces it exactly while disarmed and then
 * diverges within ten milliseconds of arming. The cause is not a harness bug.
 * Feeding the same flight stick values quantised to one part in ten thousand —
 * finer than any radio resolves — moves the roll rate by more than 1 deg/s
 * within 33 ms and by hundreds of deg/s within seconds. An aggressively flown
 * quad is chaotic, this model included and a real one more so, and mixer
 * saturation makes it worse by being a genuine discontinuity rather than merely
 * a steep curve.
 *
 * So trajectory agreement over a whole flight is not evidence of anything, in
 * either direction. Short windows are, because divergence has not had time to
 * grow. That is also how system identification is done on real aircraft, and
 * discovering it here rather than while staring at a real log is the reason
 * this harness was built before the log arrived.
 *
 * Options:
 *   --mode windows|full|rates   default: windows
 *   --window <seconds>          window length, default 0.25
 *   --out <file.html>           write a report with plots
 *   --motor-poles <n>           for eRPM conversion (default 14)
 *   --gyro-unit degps|raw       override the reader's inference
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLog, type FlightLog } from '../src/flight/logio.ts';
import { FlightSim, type StickInput } from '../src/flight/sim.ts';
import { fromEuler, DEG } from '../src/flight/math.ts';
import { racer5 } from '../src/flight/airframe.ts';
import type { PidProfile } from '../src/flight/pid.ts';
import type { RateProfile } from '../src/flight/rates.ts';

// ------------------------------------------------------------------ arguments

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const logPath = positional[0];
if (!logPath) {
  console.error('usage: replay.ts <log> [--mode full|rates] [--out report.html]');
  process.exit(2);
}

const text = readFileSync(logPath, 'utf8');
const log = parseLog(text, basename(logPath), {
  motorPoles: flag('motor-poles') ? Number(flag('motor-poles')) : undefined,
  gyroUnit: flag('gyro-unit') as 'degps' | 'raw' | undefined,
});

const mode = (flag('mode') ?? 'windows') as 'full' | 'rates' | 'windows';
const windowS = Number(flag('window') ?? 0.25);

// ------------------------------------------------------------------- resample

/** Value of a log series at time t, holding the previous sample. */
function sampler(time: Float64Array, values: Float64Array): (t: number) => number {
  let i = 0;
  return (t: number) => {
    while (i + 1 < time.length && time[i + 1]! <= t) i++;
    while (i > 0 && time[i]! > t) i--;
    return values[i] ?? 0;
  };
}

const time = log.require('time');
const duration = time[time.length - 1]! - time[0]!;
const t0 = time[0]!;
const rel = new Float64Array(time.length);
for (let i = 0; i < time.length; i++) rel[i] = time[i]! - t0;

// -------------------------------------------------------------- windowed mode

/**
 * Start the model from the state the log records at sample `i`.
 *
 * What can be restored and what cannot is the whole story of this function.
 * Body rates come from the gyro, which is filtered, so this is already
 * approximate. Motor speeds come from eRPM when the log has it, and their
 * absence is the single biggest hole a log can have: a rotor spun up is a
 * completely different aircraft from the same rotor spun down. The PID
 * integrator comes from axisI, which Blackbox does log. Velocity is not in a
 * Blackbox log at all, so it starts at zero — the model is placed in a hover,
 * which is wrong in fast forward flight and is stated here rather than hidden.
 */
function seedState(sim: FlightSim, i: number): void {
  sim.reset();
  sim.armed = true;
  sim.pos.z = -REPLAY_ALTITUDE;
  sim.onGround = false;

  const DEG_TO_RAD = Math.PI / 180;
  const g = [log.get('gyroADC[0]'), log.get('gyroADC[1]'), log.get('gyroADC[2]')];
  sim.omega.x = (g[0]?.[i] ?? 0) * DEG_TO_RAD;
  sim.omega.y = (g[1]?.[i] ?? 0) * DEG_TO_RAD;
  sim.omega.z = (g[2]?.[i] ?? 0) * DEG_TO_RAD;

  for (let m = 0; m < sim.motors.length; m++) {
    const rpm = log.get(`rpm[${m}]`)?.[i];
    if (rpm !== undefined && rpm > 0) sim.motors[m]!.omega = (rpm * 2 * Math.PI) / 60;
  }

  for (let ax = 0; ax < 3; ax++) {
    const iTerm = log.get(`axisI[${ax}]`)?.[i];
    if (iTerm !== undefined) sim.controller.axes[ax]!.integral = iTerm;
  }

  const vb = log.get('vbat')?.[i];
  if (vb !== undefined && vb > 0) sim.battery.voltage = vb;

  const spSeries = [log.get('setpoint[0]'), log.get('setpoint[1]'), log.get('setpoint[2]')];
  sim.primeControlState(
    { x: g[0]?.[i] ?? 0, y: g[1]?.[i] ?? 0, z: g[2]?.[i] ?? 0 },
    { x: spSeries[0]?.[i] ?? 0, y: spSeries[1]?.[i] ?? 0, z: spSeries[2]?.[i] ?? 0 },
  );

  const vN = log.get('velN')?.[i];
  const vE = log.get('velE')?.[i];
  const vD = log.get('velD')?.[i];
  if (vN !== undefined && vE !== undefined && vD !== undefined) {
    sim.vel.x = vN;
    sim.vel.y = vE;
    sim.vel.z = vD;
  }

  // Attitude. Not for gravity — that produces no torque — but because the
  // rotors see velocity in the body frame, and world velocity plus the wrong
  // attitude is the wrong inflow, which is the wrong thrust on every arm.
  const r = log.get('roll')?.[i];
  const p = log.get('pitch')?.[i];
  const y = log.get('yaw')?.[i];
  if (r !== undefined && p !== undefined && y !== undefined) {
    fromEuler(sim.q, r * DEG, p * DEG, y * DEG);
  }
}

/**
 * Seed a window by replaying into it with the state pinned to the log.
 *
 * A one-sample prime cannot reconstruct everything the controller remembers.
 * Stepping through one window showed the gyro matching exactly at the first
 * step while the motor output was already 13% out, because the D-term filter
 * had been zeroed and the reference had a real derivative at that instant.
 * Every one of those hidden states could be inverted analytically — the D
 * filter from axisD, the relax filter from setpoint history — but each
 * inversion is a new thing to get quietly wrong, and TPA makes one of them
 * throttle-dependent.
 *
 * So instead: start early, and during the run-in force body rates and rotor
 * speeds to the logged values after every step. The controller runs on real
 * history and charges every filter it owns from real data. At the window start
 * the pin is released and the model flies on its own.
 */
function seedWithWarmup(sim: FlightSim, start: number, warmupSteps: number): void {
  const from = Math.max(0, start - warmupSteps);
  seedState(sim, from);
  if (from === start) return;

  const DEG_TO_RAD = Math.PI / 180;
  const g = [log.get('gyroADC[0]'), log.get('gyroADC[1]'), log.get('gyroADC[2]')];
  const input: StickInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

  for (let i = from; i < start; i++) {
    const t = rel[i]!;
    input.throttle = stickThrottle(t);
    input.roll = stickRoll(t);
    input.pitch = stickPitch(t);
    input.yaw = stickYaw(t);
    sim.step(input);

    // Pin to the reference so the filters charge on real history.
    sim.omega.x = (g[0]?.[i + 1] ?? 0) * DEG_TO_RAD;
    sim.omega.y = (g[1]?.[i + 1] ?? 0) * DEG_TO_RAD;
    sim.omega.z = (g[2]?.[i + 1] ?? 0) * DEG_TO_RAD;
    for (let m = 0; m < sim.motors.length; m++) {
      const rpm = log.get(`rpm[${m}]`)?.[i + 1];
      if (rpm !== undefined && rpm > 0) sim.motors[m]!.omega = (rpm * 2 * Math.PI) / 60;
    }
    for (let ax = 0; ax < 3; ax++) {
      const iTerm = log.get(`axisI[${ax}]`)?.[i + 1];
      if (iTerm !== undefined) sim.controller.axes[ax]!.integral = iTerm;
    }
  }
}

/** Below this the reference was in contact with the ground. */
const GROUND_CLEARANCE = 0.5;

interface WindowStats {
  /** Per-axis RMS error, one entry per window. */
  rms: number[][];
  /** Median |error| against milliseconds into the window, per axis. */
  growth: Float64Array[];
  windows: number;
  skippedGround: number;
  seededRpm: boolean;
  seededITerm: boolean;
  seededVel: boolean;
}

function runWindows(): WindowStats {
  const perWindow = Math.max(2, Math.round(windowS / sim.dt));
  const logHz = log.meta.sampleHz;
  const stride = Math.max(1, Math.round(perWindow * (logHz / 1000)));
  const gyroRef = [log.get('gyroADC[0]'), log.get('gyroADC[1]'), log.get('gyroADC[2]')];
  const armed = log.get('armed');
  const motor0 = log.get('motor[0]');
  const altitude = log.get('altitude');
  let skippedGround = 0;

  const warmupSteps = Math.max(0, Math.round(Number(flag('warmup') ?? 0.05) / sim.dt));
  const rms: number[][] = [[], [], []];
  // Kept per-window so the summary can be a median. A mean here is set by
  // whichever few windows went worst, which is not what "how long does a window
  // stay comparable" is asking.
  const growthSamples: number[][][] = [[], [], []];
  let windows = 0;

  const input: StickInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

  for (let start = 0; start + stride < log.meta.samples; start += stride) {
    // Only compare while the reference was actually flying.
    const isArmed = armed ? armed[start]! > 0.5 : motor0 ? motor0[start]! > 0 : true;
    if (!isArmed) continue;

    // ...and only while it was in the air. The reference's ground contact
    // multiplies body rates by 0.6 every step, which the replay cannot
    // reproduce from 50 m up and should not try to: the ground model is not
    // what is under test. Half of the first recorded flight was within half a
    // metre of the ground, and including those windows was drowning the
    // airborne result.
    if (altitude) {
      let grounded = false;
      for (let k = start; k < Math.min(log.meta.samples, start + stride); k++) {
        if (altitude[k]! < GROUND_CLEARANCE) {
          grounded = true;
          break;
        }
      }
      if (grounded) {
        skippedGround++;
        continue;
      }
    }

    seedWithWarmup(sim, start, warmupSteps);
    const tStart = rel[start]!;
    const acc = [0, 0, 0];

    for (let k = 0; k < perWindow; k++) {
      const t = tStart + k * sim.dt;
      input.throttle = stickThrottle(t);
      input.roll = stickRoll(t);
      input.pitch = stickPitch(t);
      input.yaw = stickYaw(t);
      sim.step(input);

      const model = [sim.telemetry.gyro.x, sim.telemetry.gyro.y, sim.telemetry.gyro.z];
      for (let ax = 0; ax < 3; ax++) {
        const series = gyroRef[ax];
        if (!series) continue;
        const refAt = sampleAt(series, t);
        const e = model[ax]! - refAt;
        acc[ax] += e * e;
        (growthSamples[ax]![k] ??= []).push(Math.abs(e));
      }
    }

    for (let ax = 0; ax < 3; ax++) rms[ax]!.push(Math.sqrt(acc[ax]! / perWindow));
    windows++;
  }

  const growth = [
    new Float64Array(perWindow),
    new Float64Array(perWindow),
    new Float64Array(perWindow),
  ];
  for (let ax = 0; ax < 3; ax++) {
    for (let k = 0; k < perWindow; k++) {
      const arr = growthSamples[ax]![k];
      if (!arr || arr.length === 0) continue;
      arr.sort((a, b) => a - b);
      growth[ax]![k] = arr[Math.floor(arr.length / 2)]!;
    }
  }

  return {
    rms,
    growth,
    windows,
    skippedGround,
    seededRpm: log.has('rpm[0]'),
    seededITerm: log.has('axisI[0]'),
    seededVel: log.has('velD'),
  };
}

/** Value of a series at an arbitrary time, independent of the walking samplers. */
function sampleAt(series: Float64Array, t: number): number {
  const hz = log.meta.sampleHz;
  const i = Math.max(0, Math.min(series.length - 1, Math.round(t * hz)));
  return series[i]!;
}

// ------------------------------------------------------------------- the sim

// Sensitivity knobs. Not for fitting — for asking "how wrong would this
// parameter have to be before the comparison noticed?", which is the only way
// to know whether a clean result means the model is right or merely that the
// method is blunt.
const scaleInertia = Number(flag('scale-inertia') ?? 1);
const scaleMass = Number(flag('scale-mass') ?? 1);
const airframe = racer5();
airframe.inertia.x *= scaleInertia;
airframe.inertia.y *= scaleInertia;
airframe.inertia.z *= scaleInertia;
airframe.mass *= scaleMass;

const sim = new FlightSim({
  airframe,
  ...(log.meta.rates ? { rates: log.meta.rates as RateProfile } : {}),
  ...(log.meta.pids ? { pids: log.meta.pids as PidProfile } : {}),
});
sim.reset();

const stickThrottle = sampler(rel, log.get('rcThrottle') ?? new Float64Array(rel.length));
const stickRoll = sampler(rel, log.get('rcRoll') ?? new Float64Array(rel.length));
const stickPitch = sampler(rel, log.get('rcPitch') ?? new Float64Array(rel.length));
const stickYaw = sampler(rel, log.get('rcYaw') ?? new Float64Array(rel.length));

// Arm state: explicit if the log has it, otherwise inferred from whether the
// motors were turning. The first recording predates the `armed` column and had
// to be read this way, which is why the column now exists.
let armedSampler: (t: number) => number;
if (log.has('armed')) {
  armedSampler = sampler(rel, log.require('armed'));
} else {
  const m0 = log.get('motor[0]');
  const inferred = new Float64Array(rel.length);
  if (m0) for (let i = 0; i < rel.length; i++) inferred[i] = m0[i]! > 0 ? 1 : 0;
  else inferred.fill(1);
  armedSampler = sampler(rel, inferred);
}

const REPLAY_ALTITUDE = 50;
if (mode === 'rates') {
  sim.pos.z = -REPLAY_ALTITUDE;
  sim.onGround = false;
}

if (mode === 'windows') {
  const w = runWindows();
  const bold0 = (x: string) => `\x1b[1m${x}\x1b[0m`;
  console.log(`\n${bold0('Replay')}  ${log.meta.source}`);
  console.log(
    `  format ${log.meta.format}, ${log.meta.samples.toLocaleString()} samples at ` +
      `${log.meta.sampleHz.toFixed(0)} Hz, ${duration.toFixed(2)} s`,
  );
  console.log(
    `  mode windows, ${w.windows} windows of ${(windowS * 1000).toFixed(0)} ms, ` +
      `${(Number(flag('warmup') ?? 0.05) * 1000).toFixed(0)} ms run-in`,
  );

  console.log(`\n  ${bold0('Reader assumptions')}`);
  for (const a of log.meta.assumptions) console.log(`    - ${a}`);

  if (w.skippedGround > 0) {
    console.log(`  skipped ${w.skippedGround} windows where the reference was on the ground`);
  }
  if (scaleInertia !== 1 || scaleMass !== 1) {
    console.log(`  model perturbed: inertia x${scaleInertia}, mass x${scaleMass}`);
  }
  console.log(`\n  ${bold0('Window seeding')}`);
  console.log(`    body rates from gyro (filtered, so already approximate)`);
  console.log(
    `    motor speeds  ${w.seededRpm ? 'from logged RPM' : 'NOT AVAILABLE — motors start from rest, which is a different aircraft'}`,
  );
  console.log(`    PID integrator ${w.seededITerm ? 'from axisI' : 'zeroed (log has no axisI)'}`);
  console.log(
    `    velocity      ${w.seededVel ? 'from log' : 'zeroed — the model starts each window in a hover, wrong in fast forward flight'}`,
  );

  const pct = (arr: number[], p: number): number => {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  };

  console.log(`\n  ${bold0('Per-window RMS gyro error, deg/s')}`);
  console.log(`    ${'axis'.padEnd(8)}${'median'.padStart(9)}${'p90'.padStart(9)}${'worst'.padStart(9)}`);
  const names = ['roll', 'pitch', 'yaw'];
  for (let ax = 0; ax < 3; ax++) {
    const a = w.rms[ax]!;
    if (a.length === 0) continue;
    console.log(
      `    ${names[ax]!.padEnd(8)}${pct(a, 0.5).toFixed(1).padStart(9)}${pct(a, 0.9).toFixed(1).padStart(9)}${Math.max(...a).toFixed(1).padStart(9)}`,
    );
  }

  console.log(`\n  ${bold0('How fast a window stops being comparable')}`);
  console.log(`    median |error| in deg/s at each point into the window:`);
  const marks = [10, 25, 50, 100, 150, 200, 250].filter((ms) => ms / 1000 < windowS);
  let line = '      ';
  for (const ms of marks) line += `${ms}ms`.padStart(10);
  console.log(line);
  for (let ax = 0; ax < 3; ax++) {
    let row = `    ${names[ax]!.padEnd(6)}`;
    for (const ms of marks) row += (w.growth[ax]![Math.round(ms / 1000 / sim.dt)] ?? 0).toFixed(1).padStart(10);
    console.log(row);
  }
  if (log.meta.format !== 'blackbox-csv') {
    console.log(
      `\n  This is our own recording, so these errors are the floor the harness can` +
        `\n  reach against a perfectly-known model — everything above it on a real log` +
        `\n  is either a modelling difference or a seeding gap, not chaos.`,
    );
  }
  const outFile = flag('out');
  if (outFile) {
    const names2 = ['roll', 'pitch', 'yaw'];
    const perWindow = w.growth[0]!.length;
    const curve = (ax: number): string => {
      const g = w.growth[ax]!;
      const W = 880;
      const H = 170;
      let hi = 0;
      for (const v of g) hi = Math.max(hi, v);
      hi = Math.max(hi, 1) * 1.15;
      const pts = Array.from(g, (v, k) => `${((k / (perWindow - 1)) * W).toFixed(1)} ${(H - (v / hi) * H).toFixed(1)}`);
      return `<section><h3>${names2[ax]} <span class="meta">median |error| against time into window · peak ${hi.toFixed(0)} deg/s</span></h3>
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="M${pts.join('L')}" class="model"/></svg>
<div class="scale"><span>0 ms</span><span>${(windowS * 1000).toFixed(0)} ms</span></div></section>`;
    };
    const rows2 = names2
      .map((n, ax) => {
        const a = w.rms[ax]!;
        if (!a.length) return '';
        const srt = [...a].sort((x, y) => x - y);
        const q = (p: number) => srt[Math.min(srt.length - 1, Math.floor(srt.length * p))]!.toFixed(1);
        return `<tr><td>${n}</td><td>${q(0.5)}</td><td>${q(0.9)}</td><td>${Math.max(...a).toFixed(1)}</td></tr>`;
      })
      .join('');
    writeFileSync(
      outFile,
      `<title>fpvsim replay — ${log.meta.source}</title>
<style>
 :root{color-scheme:dark}body{background:#0d1117;color:#dbe3ee;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:18px;margin:0 0 4px}h3{font-size:13px;margin:18px 0 4px;font-weight:600}
 .meta,.sub{color:#7d8899;font-size:12px;font-weight:400}ul{color:#9aa5b4;font-size:12px;padding-left:18px}
 svg{width:100%;height:170px;background:#11161f;border:1px solid #2a3140;border-radius:4px;display:block}
 path{fill:none;vector-effect:non-scaling-stroke}.model{stroke:#4a9eff;stroke-width:1.5}
 .scale{display:flex;justify-content:space-between;color:#5c6675;font-size:11px}
 table{border-collapse:collapse;font-size:12px;margin:8px 0 20px}td,th{padding:3px 14px 3px 0;text-align:right}
 th:first-child,td:first-child{text-align:left}th{color:#7d8899}
</style>
<h1>Replay — ${log.meta.source}</h1>
<div class="sub">${log.meta.format} · ${w.windows} windows of ${(windowS * 1000).toFixed(0)} ms · ${log.meta.samples.toLocaleString()} samples at ${log.meta.sampleHz.toFixed(0)} Hz${w.skippedGround ? ` · ${w.skippedGround} ground windows skipped` : ''}</div>
<h3>Per-window RMS gyro error (deg/s)</h3>
<table><tr><th>axis</th><th>median</th><th>p90</th><th>worst</th></tr>${rows2}</table>
<h3>Reader assumptions</h3><ul>${log.meta.assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>
${[0, 1, 2].map(curve).join('\n')}`,
    );
    console.log(`\n  report written to ${outFile}`);
  }
  process.exit(0);
}

const steps = Math.floor(duration / sim.dt);
const modelTime = new Float64Array(steps);
const modelGyro = [new Float64Array(steps), new Float64Array(steps), new Float64Array(steps)];
const modelMotor = [0, 1, 2, 3].map(() => new Float64Array(steps));
const input: StickInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

let wasArmed = false;
for (let s = 0; s < steps; s++) {
  const t = s * sim.dt;
  input.throttle = stickThrottle(t);
  input.roll = stickRoll(t);
  input.pitch = stickPitch(t);
  input.yaw = stickYaw(t);

  const wantArmed = armedSampler(t) > 0.5;
  if (wantArmed && !wasArmed) {
    // Arm refuses above idle throttle, so force it: the reference quad was
    // armed at this instant whatever its stick happened to read.
    sim.armed = true;
    sim.controller.reset();
  } else if (!wantArmed && wasArmed) {
    sim.disarm();
  }
  wasArmed = wantArmed;

  sim.step(input);

  if (mode === 'rates') {
    // Freeze translation. Angular state is left entirely alone.
    sim.vel.x = sim.vel.y = sim.vel.z = 0;
    sim.pos.z = -REPLAY_ALTITUDE;
    sim.onGround = false;
  }

  modelTime[s] = t;
  for (let a = 0; a < 3; a++) modelGyro[a]![s] = a === 0 ? sim.telemetry.gyro.x : a === 1 ? sim.telemetry.gyro.y : sim.telemetry.gyro.z;
  for (let m = 0; m < 4; m++) modelMotor[m]![s] = sim.telemetry.motorOutputs[m] ?? 0;
}

// ------------------------------------------------------------------- compare

interface AxisReport {
  name: string;
  rms: number;
  maxErr: number;
  correlation: number;
  refPeak: number;
  modelPeak: number;
  refSeries: Float64Array;
  modelSeries: Float64Array;
}

function compare(name: string, refName: string, modelSeries: Float64Array): AxisReport | null {
  const refRaw = log.get(refName);
  if (!refRaw) return null;
  const ref = sampler(rel, refRaw);
  const refOnGrid = new Float64Array(steps);
  for (let s = 0; s < steps; s++) refOnGrid[s] = ref(s * sim.dt);

  let se = 0;
  let maxErr = 0;
  let sumA = 0;
  let sumB = 0;
  for (let s = 0; s < steps; s++) {
    const e = modelSeries[s]! - refOnGrid[s]!;
    se += e * e;
    maxErr = Math.max(maxErr, Math.abs(e));
    sumA += refOnGrid[s]!;
    sumB += modelSeries[s]!;
  }
  const mA = sumA / steps;
  const mB = sumB / steps;
  let cov = 0;
  let vA = 0;
  let vB = 0;
  for (let s = 0; s < steps; s++) {
    const da = refOnGrid[s]! - mA;
    const db = modelSeries[s]! - mB;
    cov += da * db;
    vA += da * da;
    vB += db * db;
  }
  const corr = vA > 0 && vB > 0 ? cov / Math.sqrt(vA * vB) : 0;

  let refPeak = 0;
  let modelPeak = 0;
  for (let s = 0; s < steps; s++) {
    refPeak = Math.max(refPeak, Math.abs(refOnGrid[s]!));
    modelPeak = Math.max(modelPeak, Math.abs(modelSeries[s]!));
  }

  return {
    name,
    rms: Math.sqrt(se / steps),
    maxErr,
    correlation: corr,
    refPeak,
    modelPeak,
    refSeries: refOnGrid,
    modelSeries,
  };
}

const axes = [
  compare('roll', 'gyroADC[0]', modelGyro[0]!),
  compare('pitch', 'gyroADC[1]', modelGyro[1]!),
  compare('yaw', 'gyroADC[2]', modelGyro[2]!),
].filter((a): a is AxisReport => a !== null);

const motors = [0, 1, 2, 3]
  .map((m) => compare(`motor ${m + 1}`, `motor[${m}]`, modelMotor[m]!))
  .filter((a): a is AxisReport => a !== null);

// -------------------------------------------------------------------- output

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
console.log(`\n${bold('Replay')}  ${log.meta.source}`);
console.log(
  `  format ${log.meta.format}, ${log.meta.samples.toLocaleString()} samples at ` +
    `${log.meta.sampleHz.toFixed(0)} Hz, ${duration.toFixed(2)} s`,
);
console.log(`  mode ${mode}, model stepped ${steps.toLocaleString()} times at ${(1 / sim.dt).toFixed(0)} Hz`);
console.log(`\n  ${bold('Reader assumptions')}`);
for (const a of log.meta.assumptions) console.log(`    - ${a}`);

const fmt = (n: number, w = 8, d = 1) => n.toFixed(d).padStart(w);
console.log(`\n  ${bold('Gyro, model against reference')}`);
console.log(`    ${'axis'.padEnd(8)}${'RMS'.padStart(9)}${'max err'.padStart(10)}${'corr'.padStart(8)}${'ref peak'.padStart(10)}${'model peak'.padStart(12)}`);
for (const a of axes) {
  console.log(
    `    ${a.name.padEnd(8)}${fmt(a.rms, 9)}${fmt(a.maxErr, 10)}${fmt(a.correlation, 8, 4)}${fmt(a.refPeak, 10)}${fmt(a.modelPeak, 12)}`,
  );
}
console.log('    (RMS and max err in deg/s; corr 1.0 is a perfect match)');

if (motors.length) {
  console.log(`\n  ${bold('Motor outputs, 0..1')}`);
  for (const m of motors) {
    console.log(`    ${m.name.padEnd(8)}${fmt(m.rms, 9, 4)}${fmt(m.maxErr, 10, 4)}${fmt(m.correlation, 8, 4)}`);
  }
}

const worstCorr = axes.length ? Math.min(...axes.map((a) => a.correlation)) : 0;
const worstRms = axes.length ? Math.max(...axes.map((a) => a.rms)) : 0;
console.log(
  `\n  ${bold('Verdict')}  worst-axis correlation ${worstCorr.toFixed(4)}, worst RMS ${worstRms.toFixed(1)} deg/s`,
);
if (log.meta.format !== 'blackbox-csv') {
  console.log(
    worstRms < 1e-6
      ? '  Replaying our own recording reproduces it exactly, so the harness itself is sound.'
      : '  This is our own recording: anything but an exact match is a harness bug, not a model finding.',
  );
}

// ------------------------------------------------------------------ HTML plot

const outPath = flag('out');
if (outPath) {
  const decimate = (a: Float64Array, n = 1400): number[] => {
    const stride = Math.max(1, Math.floor(a.length / n));
    const out: number[] = [];
    for (let i = 0; i < a.length; i += stride) out.push(a[i]!);
    return out;
  };

  const plot = (r: AxisReport, unit: string): string => {
    const ref = decimate(r.refSeries);
    const mod = decimate(r.modelSeries);
    const n = ref.length;
    const W = 900;
    const H = 200;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of [...ref, ...mod]) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!(hi > lo)) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x = (i: number) => (i / (n - 1)) * W;
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    const path = (s: number[]) => s.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    const zero = lo <= 0 && hi >= 0 ? `<line x1="0" y1="${y(0).toFixed(1)}" x2="${W}" y2="${y(0).toFixed(1)}" class="zero"/>` : '';
    return `<section>
  <h3>${r.name} <span class="meta">RMS ${r.rms.toFixed(r.rms < 1 ? 4 : 1)} ${unit} · corr ${r.correlation.toFixed(4)} · peak ref ${r.refPeak.toFixed(1)} vs model ${r.modelPeak.toFixed(1)}</span></h3>
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${zero}
    <path d="${path(ref)}" class="ref"/>
    <path d="${path(mod)}" class="model"/>
  </svg>
  <div class="scale"><span>${hi.toFixed(0)}</span><span>${lo.toFixed(0)}</span></div>
</section>`;
  };

  const html = `<title>fpvsim replay — ${log.meta.source}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#dbe3ee; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h3 { font-size:13px; margin:18px 0 4px; font-weight:600; }
  .meta { color:#7d8899; font-weight:400; font-size:12px; }
  .sub { color:#7d8899; font-size:12px; margin-bottom:16px; }
  ul { color:#9aa5b4; font-size:12px; padding-left:18px; }
  svg { width:100%; height:200px; background:#11161f; border:1px solid #2a3140; border-radius:4px; display:block; }
  path { fill:none; vector-effect:non-scaling-stroke; }
  .ref { stroke:#f4b400; stroke-width:1.4; }
  .model { stroke:#4a9eff; stroke-width:1.2; }
  .zero { stroke:#2a3140; stroke-width:1; vector-effect:non-scaling-stroke; }
  .scale { display:flex; justify-content:space-between; color:#5c6675; font-size:11px; }
  .key { margin:12px 0; font-size:12px; }
  .key b { font-weight:600; }
  .ref-k { color:#f4b400; } .model-k { color:#4a9eff; }
  table { border-collapse:collapse; font-size:12px; margin:8px 0 20px; }
  td,th { padding:3px 12px 3px 0; text-align:right; } th:first-child, td:first-child { text-align:left; }
  th { color:#7d8899; font-weight:600; }
</style>
<h1>Replay — ${log.meta.source}</h1>
<div class="sub">${log.meta.format} · ${log.meta.samples.toLocaleString()} samples at ${log.meta.sampleHz.toFixed(0)} Hz · ${duration.toFixed(2)} s · mode <b>${mode}</b></div>
<div class="key"><b class="ref-k">— reference</b> &nbsp; <b class="model-k">— model</b></div>
<table>
<tr><th>axis</th><th>RMS (deg/s)</th><th>max err</th><th>corr</th><th>ref peak</th><th>model peak</th></tr>
${axes.map((a) => `<tr><td>${a.name}</td><td>${a.rms.toFixed(2)}</td><td>${a.maxErr.toFixed(1)}</td><td>${a.correlation.toFixed(4)}</td><td>${a.refPeak.toFixed(0)}</td><td>${a.modelPeak.toFixed(0)}</td></tr>`).join('\n')}
</table>
<h3 style="margin-top:0">Reader assumptions</h3>
<ul>${log.meta.assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>
${axes.map((a) => plot(a, 'deg/s')).join('\n')}
${motors.map((m) => plot(m, '')).join('\n')}
`;
  writeFileSync(outPath, html);
  console.log(`\n  report written to ${outPath}`);
}
