/**
 * Measure airframe parameters from a Blackbox log.
 *
 * Two things a log can pin down that no datasheet will, given the all-up mass:
 *
 *   Rotor thrust scale. The accelerometer reads specific force, which for a
 *   quad is very nearly the rotor thrust divided by the mass. eRPM says how
 *   fast the rotors were turning. So thrust-per-rpm-squared is measurable
 *   directly, and the blade-element model can be checked against it rather
 *   than against a manufacturer's chart for a different prop.
 *
 *   Roll and pitch inertia. Thrust differential across the arms is a torque;
 *   the gyro's derivative is the angular acceleration it produced. The slope of
 *   one against the other is the moment of inertia. This is the number nobody
 *   publishes for a specific build and that a parts-count estimate gets wrong.
 *
 * Both are regressions over real flight, so both are only as good as the
 * samples chosen — see the filters below, which are deliberately strict.
 *
 *   node --experimental-strip-types tools/identify.ts <log.BBL> --session <n>
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeBlackbox } from '../src/flight/blackbox.ts';
import { kronos } from '../src/flight/airframe.ts';
import { Rotor } from '../src/flight/rotor.ts';
import { G } from '../src/flight/sim.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: identify.ts <log.BBL> [--session n] [--mass kg]');
  process.exit(2);
}

const dec = decodeBlackbox(new Uint8Array(readFileSync(path)), Number(flag('session') ?? 0));
const H = dec.header.raw;
const col = (n: string): Float64Array | undefined => {
  const i = dec.fieldNames.indexOf(n);
  return i >= 0 ? dec.columns[i] : undefined;
};

const af = kronos();
const mass = Number(flag('mass') ?? af.mass);
const weight = mass * G;
const acc1G = Number(H.get('acc_1G') ?? 2048);
const poles = Number(H.get('motor_poles') ?? 14);

const time = col('time')!;
const N = time.length;
const acc = [col('accSmooth[0]')!, col('accSmooth[1]')!, col('accSmooth[2]')!];
// Pitch negated: Betaflight logs pitch positive nose-down. See logio.ts for how
// that was established — briefly, the eRPM-derived thrust differential
// correlates -0.50 with Betaflight's pitch while roll gives +0.49, and thrust
// has no controller in the loop to confuse the sign.
const gyro = [
  col('gyroADC[0]')!,
  Float64Array.from(col('gyroADC[1]')!, (v) => -v),
  col('gyroADC[2]')!,
];
const rpm = [0, 1, 2, 3].map((m) => {
  const e = col(`eRPM[${m}]`);
  return e ? Float64Array.from(e, (v) => (v * 100) / (poles / 2)) : undefined;
});
if (rpm.some((r) => !r)) {
  console.error('this log has no eRPM — bidirectional DShot is required for identification');
  process.exit(1);
}

console.log(`\n\x1b[1mIdentify\x1b[0m  ${basename(path)} [session ${flag('session') ?? 0}, ${dec.craftName}]`);
console.log(`  ${N.toLocaleString()} samples, mass ${mass} kg, weight ${weight.toFixed(2)} N, acc_1G ${acc1G}, ${poles} poles`);

// -------------------------------------------------------------- thrust scale

// Samples usable for fitting thrust.
//
// The first version of this wanted hover: level, still, not accelerating. On a
// racing quad flown hard that produced 35 samples out of 236,000, because it
// never hovers. So the fit runs over the whole flight instead and uses the fact
// that the accelerometer's body-z reading IS the rotor thrust divided by mass,
// whatever attitude the quad is in — the rotors are the only thing pushing
// along that axis. Only tumbling and ground samples are excluded.
//
// The throttle gate is the one that matters and it is not obvious. A quad
// sitting on the ground is also level, also still, and its accelerometer also
// reads exactly 1 g, because the ground is holding it up instead of the
// rotors. Without the gate, a third of this flight's "hover" samples were the
// quad parked at idle, which dragged the fitted rotor speed down to 3689 rpm
// and made the thrust model look 79% wrong when it was the filter that was.
// The throttle gate is the one that matters and it is not obvious. A quad
// sitting on the ground is level, still, and its accelerometer reads exactly
// 1 g, because the ground is holding it up instead of the rotors. Without the
// gate, a third of this flight's samples were the quad parked at idle, which
// dragged the fitted rotor speed to 3689 rpm and made the thrust model look
// 79% wrong when it was the filter that was.
const throttle = col('rcCommand[3]');
const hover: number[] = [];
for (let i = 1; i < N; i++) {
  if (throttle && throttle[i]! < 1150) continue;
  const rate = Math.max(Math.abs(gyro[0]![i]!), Math.abs(gyro[1]![i]!), Math.abs(gyro[2]![i]!));
  if (rate > 300) continue;
  const az = Math.abs(acc[2]![i]! / acc1G);
  if (az < 0.2 || az > 4) continue;
  hover.push(i);
}

/**
 * Thrust coefficient k in T = k*omega^2, per rotor, fitted by least squares
 * against the accelerometer over the hover samples.
 *
 * This is the measurement the rest of the tool leans on: once k is known from
 * the aircraft itself, the inertia fit below no longer inherits whatever the
 * blade-element model happens to think, and the two results become independent.
 */
let kMeasured = 0;
{
  let sxy = 0;
  let sxx = 0;
  let sumRpm = 0;
  for (const i of hover) {
    let sumSq = 0;
    let r = 0;
    for (let m = 0; m < 4; m++) {
      const w = (rpm[m]![i]! * 2 * Math.PI) / 60;
      sumSq += w * w;
      r += rpm[m]![i]!;
    }
    sumRpm += r / 4;
    // Specific force along body -z is the rotors pushing; convert to newtons.
    const measured = Math.abs(acc[2]![i]! / acc1G) * mass * G;
    sxy += sumSq * measured;
    sxx += sumSq * sumSq;
  }

  if (hover.length < 200) {
    console.log(`\n  Not enough hover-like samples (${hover.length}) to fit thrust.`);
  } else {
    kMeasured = sxy / sxx;
    // How well the linear relation actually holds, so the number comes with a
    // measure of whether T = k*omega^2 was a fair description of this flight.
    let ssTot = 0;
    let ssRes = 0;
    let meanY = 0;
    for (const i of hover) meanY += Math.abs(acc[2]![i]! / acc1G) * mass * G;
    meanY /= hover.length;
    for (const i of hover) {
      let sumSq = 0;
      for (let m = 0; m < 4; m++) {
        const w = (rpm[m]![i]! * 2 * Math.PI) / 60;
        sumSq += w * w;
      }
      const y = Math.abs(acc[2]![i]! / acc1G) * mass * G;
      ssRes += (y - kMeasured * sumSq) ** 2;
      ssTot += (y - meanY) ** 2;
    }
    const r2 = 1 - ssRes / ssTot;
    const meanRpm = sumRpm / hover.length;
    const omega = (meanRpm * 2 * Math.PI) / 60;
    const rotor = new Rotor(af.prop);
    const modelled = rotor.solve(omega, 0, 0).thrust;
    const measuredPerRotor = kMeasured * omega * omega;

    console.log(`\n  \x1b[1mRotor thrust\x1b[0m  (${hover.length.toLocaleString()} hover samples)`);
    console.log(`    mean rotor speed          ${meanRpm.toFixed(0)} rpm`);
    console.log(`    measured k                ${kMeasured.toExponential(3)} N/(rad/s)^2`);
    console.log(`    thrust per rotor at that speed`);
    console.log(`      from the aircraft       ${measuredPerRotor.toFixed(3)} N  (x4 = ${(measuredPerRotor * 4).toFixed(2)} N against ${weight.toFixed(2)} N of weight)`);
    console.log(`      from the model          ${modelled.toFixed(3)} N`);
    console.log(`    the blade-element model is ${((modelled / measuredPerRotor - 1) * 100).toFixed(0)}% high`);
    console.log(`    fit quality R^2           ${r2.toFixed(3)}  (how well T = k*omega^2 held over the flight)`);
    // What rotor speed the aircraft would need to hold itself up.
    const hoverOmega = Math.sqrt(weight / 4 / kMeasured);
    console.log(`    implied hover speed       ${((hoverOmega * 60) / (2 * Math.PI)).toFixed(0)} rpm per rotor`);
  }
}

// ------------------------------------------------------------------ inertia

// Torque from thrust differential against measured angular acceleration.
// Restricted to samples where the quad is rotating hard, so the signal is well
// above the noise in a differentiated gyro.
// Thrust from the measured coefficient, not from the model, so the inertia fit
// is independent of the rotor model's accuracy.
const thrustOf = (i: number, m: number): number => {
  const w = (rpm[m]![i]! * 2 * Math.PI) / 60;
  return kMeasured * w * w;
};

function fitAxis(axis: 0 | 1, label: string): void {
  const arm = axis === 0 ? af.mounts.map((mt) => -mt.pos.y) : af.mounts.map((mt) => mt.pos.x);
  // Central difference over 4 ms; a 1-sample difference on a 2 kHz log is noise.
  const span = Math.max(1, Math.round(0.004 / ((time[1]! - time[0]!) / 1e6)));
  let sxy = 0;
  let sxx = 0;
  let used = 0;
  let peakAlpha = 0;

  for (let i = span; i < N - span; i++) {
    const dt = (time[i + span]! - time[i - span]!) / 1e6;
    if (dt <= 0) continue;
    const alpha = (((gyro[axis]![i + span]! - gyro[axis]![i - span]!) * Math.PI) / 180) / dt;
    if (throttle && throttle[i]! < 1150) continue;
    if (Math.abs(alpha) < 60) continue; // rad/s^2; below this it is mostly noise

    let torque = 0;
    for (let m = 0; m < 4; m++) torque += arm[m]! * thrustOf(i, m);

    sxy += alpha * torque;
    sxx += alpha * alpha;
    used++;
    peakAlpha = Math.max(peakAlpha, Math.abs(alpha));
  }

  if (kMeasured === 0) {
    console.log(`\n  ${label}: no thrust coefficient, so no inertia fit.`);
    return;
  }
  if (used < 500) {
    console.log(`\n  ${label}: only ${used} usable samples — not fitting.`);
    return;
  }
  const I = sxy / sxx;
  const current = axis === 0 ? af.inertia.x : af.inertia.y;
  console.log(`\n  \x1b[1m${label} inertia\x1b[0m  (${used.toLocaleString()} samples, peak ${peakAlpha.toFixed(0)} rad/s^2)`);
  console.log(`    fitted   ${I.toExponential(3)} kg*m^2   (using the measured thrust coefficient)`);
  console.log(`    in model ${current.toExponential(3)} kg*m^2   (${((current / I - 1) * 100).toFixed(0)}% off)`);
}

fitAxis(0, 'Roll');
fitAxis(1, 'Pitch');

console.log(
  `\n  Caveats: the inertia fit uses the measured thrust coefficient, so it does not\n` +
    `  inherit the rotor model's error — but it does assume thrust is still k*omega^2\n` +
    `  during a hard flick, when inflow is not what it was in hover. Aerodynamic\n` +
    `  damping and gyroscopic coupling are not in the torque term either. Treat the\n` +
    `  fitted numbers as good to a few tens of percent, not better.\n`,
);
