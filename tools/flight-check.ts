/**
 * Physical acceptance tests for the flight model.
 *
 * These are not unit tests. Each one asserts something that has to be true of
 * a 5" quad rather than something that has to be true of this code, which is
 * the only kind of check that catches a sign error in a mixer or a rotor model
 * that quietly makes thrust out of nothing. Per the project convention: verify,
 * do not assert. Run with
 *
 *   npm run check:flight
 */

import { FlightSim, type StickInput } from '../src/flight/sim.ts';
import { racer5 } from '../src/flight/airframe.ts';
import { defaultRates, applyRates, AXIS_ROLL } from '../src/flight/rates.ts';
import { Mixer } from '../src/flight/mixer.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} — ${detail}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
  }
}

function inRange(name: string, v: number, lo: number, hi: number, unit = ''): void {
  ok(name, v >= lo && v <= hi, `${v.toFixed(4)}${unit} (expected ${lo}..${hi}${unit})`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const sticks = (o: Partial<StickInput> = {}): StickInput => ({
  throttle: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
  ...o,
});

/** Put the sim in the air, armed, at a given altitude. */
function airborne(sim: FlightSim, altitude = 10): void {
  sim.reset();
  sim.arm(sticks());
  sim.pos.z = -altitude;
  sim.onGround = false;
}

function run(sim: FlightSim, input: StickInput, seconds: number): void {
  const steps = Math.round(seconds / sim.dt);
  for (let i = 0; i < steps; i++) sim.step(input);
}

const finite = (...v: number[]): boolean => v.every((x) => Number.isFinite(x));

// ---------------------------------------------------------------- rotor alone

section('Rotor: blade-element model in isolation');
{
  const sim = new FlightSim();
  const rotor = sim.rotors[0]!;

  // 5" tri-blade at 20 000 rpm. Manufacturer data for this class sits around
  // 8-11 N; anything outside that and the aerodynamic constants are wrong.
  const omega20k = (20000 * 2 * Math.PI) / 60;
  const staticThrust = rotor.solve(omega20k, 0, 0).thrust;
  inRange('static thrust at 20k rpm', staticThrust, 5, 14, ' N');

  const staticTorque = rotor.solve(omega20k, 0, 0).torque;
  inRange('shaft torque at 20k rpm', staticTorque, 0.02, 0.25, ' N*m');

  // Thrust must fall off as the rotor climbs into its own inflow.
  const climbThrust = rotor.solve(omega20k, 8, 0).thrust;
  ok(
    'thrust falls with climb rate',
    climbThrust < staticThrust,
    `${climbThrust.toFixed(2)} N climbing at 8 m/s vs ${staticThrust.toFixed(2)} N static`,
  );

  // ...and rise in forward flight, which is translational lift.
  const fwdThrust = rotor.solve(omega20k, 0, 15).thrust;
  ok(
    'translational lift present',
    fwdThrust > staticThrust,
    `${fwdThrust.toFixed(2)} N at 15 m/s edgewise vs ${staticThrust.toFixed(2)} N static`,
  );

  // Thrust should scale close to the square of rotor speed in hover.
  const t10k = rotor.solve(omega20k / 2, 0, 0).thrust;
  const ratio = staticThrust / t10k;
  inRange('thrust scales ~omega^2', ratio, 3.4, 4.6, 'x');

  ok('rotor at rest makes nothing', rotor.solve(0, 0, 0).thrust === 0, 'thrust is exactly 0');
  const extreme = rotor.solve(omega20k, -30, 40);
  ok(
    'no NaN in a steep descent with speed on',
    finite(extreme.thrust, extreme.torque, extreme.hDrag),
    `T=${extreme.thrust.toFixed(2)} Q=${extreme.torque.toFixed(4)} H=${extreme.hDrag.toFixed(3)}`,
  );
}

// --------------------------------------------------------------- whole quad

section('Airframe: thrust, hover, and endurance');
{
  const sim = new FlightSim();
  const af = racer5();
  const weight = af.mass * 9.80665;

  // Static full-throttle thrust, measured on a tether: velocity is held at zero
  // every step. Letting it climb away instead measures thrust at 30 m/s, where
  // rotor inflow has eaten a third of it — that is a real effect, but it is not
  // what a thrust figure means.
  airborne(sim, 1000);
  for (let i = 0; i < Math.round(2.0 / sim.dt); i++) {
    sim.step(sticks({ throttle: 1 }));
    sim.vel.x = sim.vel.y = sim.vel.z = 0;
  }
  const twr = sim.telemetry.totalThrustN / weight;
  inRange('static thrust-to-weight at full throttle', twr, 8, 15, ':1');
  inRange('full-throttle current draw', sim.telemetry.batteryA, 80, 220, ' A');
  inRange('full-throttle RPM', sim.telemetry.motorRpm[0]!, 24000, 34000, ' rpm');

  // Hover throttle: bisect on the throttle that holds altitude.
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 22; iter++) {
    const mid = (lo + hi) / 2;
    const s = new FlightSim();
    airborne(s, 100);
    run(s, sticks({ throttle: mid }), 2.5);
    // vel.z positive is downward, so a sinking quad needs more throttle.
    if (s.vel.z > 0) lo = mid;
    else hi = mid;
  }
  const hoverThrottle = (lo + hi) / 2;
  // Low, and correctly so: a 6S 5" racer at ~12:1 thrust-to-weight hovers around
  // 15% stick. A pilot coming from a 4S freestyle build finds this alarming, and
  // that is exactly the thing a trainer should reproduce rather than smooth out.
  inRange('hover throttle', hoverThrottle, 0.08, 0.30, '');

  const hs = new FlightSim();
  airborne(hs, 100);
  run(hs, sticks({ throttle: hoverThrottle }), 3);
  inRange('hover RPM', hs.telemetry.motorRpm[0]!, 8000, 22000, ' rpm');
  inRange('hover current', hs.telemetry.batteryA, 8, 60, ' A');
  ok(
    'hover holds altitude',
    Math.abs(hs.vel.z) < 0.35,
    `vertical speed ${(-hs.vel.z).toFixed(3)} m/s after 3 s`,
  );
}

// ------------------------------------------------------------- control signs

section('Control: every axis moves the way the stick says');
{
  const cases: { name: string; input: StickInput; read: (s: FlightSim) => number }[] = [
    { name: 'roll right', input: sticks({ roll: 0.5 }), read: (s) => s.telemetry.gyro.x },
    { name: 'pitch up', input: sticks({ pitch: 0.5 }), read: (s) => s.telemetry.gyro.y },
    { name: 'yaw right', input: sticks({ yaw: 0.5 }), read: (s) => s.telemetry.gyro.z },
  ];
  for (const c of cases) {
    const sim = new FlightSim();
    airborne(sim, 200);
    run(sim, sticks({ throttle: 0.35 }), 0.5);
    const withStick = { ...c.input, throttle: 0.35 };
    run(sim, withStick, 0.6);
    const rate = c.read(sim);
    const want = applyRates(defaultRates(), 0, 0.5);
    ok(
      `${c.name} produces positive rate`,
      rate > 0,
      `${rate.toFixed(1)} deg/s (setpoint ${want.toFixed(1)} deg/s)`,
    );
  }

  // Negative direction too, in case something is rectifying.
  const sim = new FlightSim();
  airborne(sim, 200);
  run(sim, sticks({ throttle: 0.35 }), 0.5);
  run(sim, sticks({ throttle: 0.35, roll: -0.5 }), 0.6);
  ok('roll left produces negative rate', sim.telemetry.gyro.x < 0, `${sim.telemetry.gyro.x.toFixed(1)} deg/s`);
}

// ------------------------------------------------------------ rate tracking

section('Control: rate tracking and step response');
{
  const sim = new FlightSim();
  airborne(sim, 300);
  run(sim, sticks({ throttle: 0.35 }), 1.0);

  const stick = 0.6;
  const target = applyRates(defaultRates(), AXIS_ROLL, stick);
  const input = sticks({ throttle: 0.35, roll: stick });

  const trace: number[] = [];
  const steps = Math.round(1.2 / sim.dt);
  for (let i = 0; i < steps; i++) {
    sim.step(input);
    trace.push(sim.telemetry.gyro.x);
  }

  const settled = trace.slice(-200).reduce((a, b) => a + b, 0) / 200;
  const err = Math.abs(settled - target) / Math.abs(target);
  ok(
    'steady-state rate tracks setpoint',
    err < 0.06,
    `${settled.toFixed(1)} vs ${target.toFixed(1)} deg/s (${(err * 100).toFixed(1)}% error)`,
  );

  const peak = Math.max(...trace);
  const overshoot = (peak - target) / target;
  inRange('step overshoot', overshoot * 100, -5, 35, '%');

  const riseIdx = trace.findIndex((v) => v >= target * 0.9);
  const riseMs = riseIdx < 0 ? Infinity : riseIdx * sim.dt * 1000;
  inRange('rise time to 90%', riseMs, 5, 150, ' ms');

  // Sustained oscillation would show as a large late-window spread.
  const tail = trace.slice(-300);
  const spread = Math.max(...tail) - Math.min(...tail);
  ok('no sustained oscillation', spread < target * 0.15, `late-window spread ${spread.toFixed(1)} deg/s`);
}

// ------------------------------------------------------------------ airmode

section('Mixer: airmode keeps authority at zero throttle');
{
  const withAir = new FlightSim({ airmode: true });
  airborne(withAir, 300);
  run(withAir, sticks({ throttle: 0, roll: 0.5 }), 0.8);

  const noAir = new FlightSim({ airmode: false });
  airborne(noAir, 300);
  run(noAir, sticks({ throttle: 0, roll: 0.5 }), 0.8);

  ok(
    'airmode rolls at zero throttle',
    Math.abs(withAir.telemetry.gyro.x) > 100,
    `${withAir.telemetry.gyro.x.toFixed(1)} deg/s`,
  );

  // The guarantee airmode actually makes is about the mixer, not the rate: the
  // full commanded differential survives to the motors instead of being clipped
  // against the bottom of the range. Testing it on the mixer directly is the
  // honest version — an earlier draft compared achieved roll rate between the
  // two and found no difference, because the PID simply winds up until the
  // clipped mixer delivers anyway. That comparison was measuring the
  // controller, not the mixer.
  const geom = racer5().mounts;
  const mixOn = new Mixer(geom, true).apply(0, 0.25, 0, 0);
  const spreadOn = Math.max(...mixOn.outputs) - Math.min(...mixOn.outputs);
  const mixOff = new Mixer(geom, false).apply(0, 0.25, 0, 0);
  const spreadOff = Math.max(...mixOff.outputs) - Math.min(...mixOff.outputs);

  ok(
    'airmode preserves the commanded differential at zero throttle',
    Math.abs(spreadOn - 0.5) < 1e-9,
    `spread ${spreadOn.toFixed(4)} for a +-0.25 roll demand`,
  );
  ok(
    'without airmode the differential is clipped away',
    spreadOff < spreadOn - 0.2,
    `spread ${spreadOff.toFixed(4)} vs ${spreadOn.toFixed(4)} — half the demand hits the floor`,
  );
}

// ------------------------------------------------------------------- motors

section('Motors: the asymmetry that makes a quad feel like a quad');
{
  const sim = new FlightSim();
  airborne(sim, 500);
  run(sim, sticks({ throttle: 0.6 }), 1.5);
  const settledRpm = sim.motors[0]!.rpm;

  // Spin-up from idle to 90% of settled.
  const up = new FlightSim();
  airborne(up, 500);
  let upSteps = 0;
  while (up.motors[0]!.rpm < settledRpm * 0.9 && upSteps < 5000) {
    up.step(sticks({ throttle: 0.6 }));
    upSteps++;
  }

  // Spin-down from settled to 110% of the idle floor.
  let downSteps = 0;
  const idleRpm = (() => {
    const s = new FlightSim();
    airborne(s, 500);
    run(s, sticks({ throttle: 0 }), 2);
    return s.motors[0]!.rpm;
  })();
  while (sim.motors[0]!.rpm > idleRpm * 1.1 && downSteps < 5000) {
    sim.step(sticks({ throttle: 0 }));
    downSteps++;
  }

  const upMs = upSteps * sim.dt * 1000;
  const downMs = downSteps * sim.dt * 1000;
  inRange('spin-up time to 90%', upMs, 5, 200, ' ms');
  ok(
    'spin-down is slower than spin-up',
    downMs > upMs,
    `up ${upMs.toFixed(0)} ms, down ${downMs.toFixed(0)} ms — nothing brakes a coasting prop`,
  );
}

// ------------------------------------------------------------------ battery

section('Battery: sag under load');
{
  const sim = new FlightSim();
  airborne(sim, 500);
  const rest = sim.battery.voltage;
  run(sim, sticks({ throttle: 1 }), 1.0);
  const loaded = sim.battery.voltage;
  ok('voltage sags under load', loaded < rest, `${rest.toFixed(2)} V rest, ${loaded.toFixed(2)} V at full throttle`);
  inRange('sag magnitude', rest - loaded, 0.3, 6.0, ' V');

  run(sim, sticks({ throttle: 0 }), 1.0);
  ok('voltage recovers when unloaded', sim.battery.voltage > loaded, `${sim.battery.voltage.toFixed(2)} V`);
  ok('charge is consumed', sim.battery.usedAh > 0, `${(sim.battery.usedAh * 1000).toFixed(1)} mAh used`);
}

// -------------------------------------------------------------- robustness

section('Robustness: it must not be possible to make it produce nonsense');
{
  const sim = new FlightSim();
  airborne(sim, 500);
  // Deliberately violent: full deflection on every axis, reversing constantly.
  let bad = 0;
  let peakRate = 0;
  for (let i = 0; i < 20000; i++) {
    const phase = i * 0.01;
    sim.step({
      throttle: 0.5 + 0.5 * Math.sin(phase * 3),
      roll: Math.sin(phase),
      pitch: Math.cos(phase * 1.7),
      yaw: Math.sin(phase * 0.3),
    });
    if (!finite(sim.pos.x, sim.pos.y, sim.pos.z, sim.vel.x, sim.omega.x, sim.q.w)) bad++;
    peakRate = Math.max(peakRate, Math.abs(sim.omega.x), Math.abs(sim.omega.y), Math.abs(sim.omega.z));
  }
  ok('20 s of full-deflection abuse stays finite', bad === 0, `${bad} non-finite steps`);
  const qn = Math.hypot(sim.q.w, sim.q.x, sim.q.y, sim.q.z);
  ok('quaternion stays normalised', Math.abs(qn - 1) < 1e-9, `|q| = ${qn.toFixed(12)}`);
  // Not "stays gentle" — 20 s of full-deflection stick reversal tumbles a real
  // quad too, and with 12:1 thrust-to-weight and the mixer saturated the model
  // is entitled to spin hard. What must not happen is a rate that runs away.
  // The bound is what the airframe can physically produce: full differential
  // thrust on the long arm against roll inertia, sustained.
  const maxTorque = 2 * 20 * 0.0778; // two motors at full, two at zero
  const maxAccel = maxTorque / racer5().inertia.x; // rad/s^2
  const bound = maxAccel * 0.5; // half a second of it, unopposed
  ok(
    'angular rate stays inside what the airframe can produce',
    peakRate < bound,
    `peak ${(peakRate * (180 / Math.PI)).toFixed(0)} deg/s against a physical ceiling of ` +
      `${(bound * (180 / Math.PI)).toFixed(0)} deg/s`,
  );

  // The property that actually matters: however badly it is provoked, centring
  // the sticks has to bring it back. A model that can be driven into a state it
  // cannot recover from would teach a reflex that does not work on a real quad.
  run(sim, sticks({ throttle: 0.16 }), 4);
  const recovered = Math.hypot(sim.omega.x, sim.omega.y, sim.omega.z) * (180 / Math.PI);
  ok(
    'recovers to controlled flight once the sticks centre',
    recovered < 30,
    `${recovered.toFixed(1)} deg/s remaining 4 s after centring`,
  );

  // Disarmed on the ground, it must simply sit there.
  const idle = new FlightSim();
  idle.reset();
  run(idle, sticks({ throttle: 0.8, roll: 1 }), 2);
  ok(
    'disarmed quad does not move',
    Math.abs(idle.pos.x) < 1e-6 && Math.abs(idle.pos.y) < 1e-6,
    `moved ${Math.hypot(idle.pos.x, idle.pos.y).toExponential(2)} m`,
  );
  ok('disarmed quad stays on the ground', idle.onGround, `altitude ${idle.telemetry.altitude.toFixed(4)} m`);
}

// ----------------------------------------------------------- determinism

section('Determinism: the same inputs must give the same flight');
{
  const fly = (): number[] => {
    const s = new FlightSim();
    airborne(s, 100);
    for (let i = 0; i < 5000; i++) {
      s.step({ throttle: 0.4, roll: Math.sin(i * 0.003), pitch: 0.1, yaw: -0.2 });
    }
    return [s.pos.x, s.pos.y, s.pos.z, s.q.w, s.q.x, s.q.y, s.q.z, s.omega.x];
  };
  const a = fly();
  const b = fly();
  const same = a.every((v, i) => v === b[i]);
  ok('two identical runs match bit for bit', same, same ? 'identical' : `a=${a[0]} b=${b[0]}`);
}

// ------------------------------------------------------------- performance

section('Performance: the step has to fit inside the 1 kHz tick');
{
  const sim = new FlightSim();
  airborne(sim, 100);
  const input = sticks({ throttle: 0.45, roll: 0.3, pitch: -0.2, yaw: 0.1 });
  for (let i = 0; i < 20000; i++) sim.step(input); // warm up the JIT

  const N = 200000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) sim.step(input);
  const t1 = process.hrtime.bigint();
  const usPerStep = Number(t1 - t0) / 1000 / N;
  const budgetPct = (usPerStep / 1000) * 100;
  console.log(
    `  step cost ${usPerStep.toFixed(2)} us — ${budgetPct.toFixed(2)}% of a 1 ms tick`,
  );
  ok('step fits the tick budget with room to spare', usPerStep < 100, `${usPerStep.toFixed(2)} us/step`);
}

// ------------------------------------------------------------------ report

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
