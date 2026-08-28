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
import { kronos, racer5 } from '../src/flight/airframe.ts';
import { defaultRates, applyRates, AXIS_ROLL, RATE_FIELDS, type RateProfile } from '../src/flight/rates.ts';
import { defaultPids } from '../src/flight/pid.ts';
import { Mixer } from '../src/flight/mixer.ts';
import type { Obstacle } from '../src/flight/collision.ts';
import { fromEuler, rotateBodyToWorld, DEG as DEG_TO_RAD } from '../src/flight/math.ts';

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
  // Pack current, not motor current: the ESC is a switching converter. Peak
  // pack draw in the real log is 278 A on a lighter quad.
  inRange('full-throttle current draw', sim.telemetry.batteryA, 60, 300, ' A');
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
  // Bounded by measurement, not by taste. A real 470 g 6S quad draws a median
  // 6.4 A at hover (p10 3.0, p90 10.5) in NACRONOS session 14; this airframe is
  // 650 g, so roughly 10 A. The model sits near the bottom of that range
  // because its prop torque coefficient is about 1.7x low against the same log
  // — a known open gap, listed in the README, not a licence to widen this.
  inRange('hover current', hs.telemetry.batteryA, 2, 20, ' A');
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

// ------------------------------------------------------------- current limit

section('Motors: the ESC will not pass unlimited current');
{
  // Worst case for current is full throttle applied to a motor that is barely
  // turning: no back-EMF opposes it. This is the transient a recorded flight
  // caught at 92 A per motor.
  const sim = new FlightSim();
  airborne(sim, 500);
  let peak = 0;
  for (let i = 0; i < 2000; i++) {
    sim.step(sticks({ throttle: 1 }));
    sim.vel.x = sim.vel.y = sim.vel.z = 0;
    for (const m of sim.motors) peak = Math.max(peak, m.current);
  }
  const limit = racer5().motor.maxCurrent;
  ok(
    'per-motor current never exceeds the ESC limit',
    peak <= limit + 1e-6,
    `peak ${peak.toFixed(1)} A against a ${limit} A limit`,
  );

  // The limit must bind on transients only. If it were clipping steady state
  // the quad would quietly lose top-end thrust.
  const settled = sim.motors[0]!.current;
  ok(
    'steady full throttle sits below the limit',
    settled < limit * 0.95,
    `${settled.toFixed(1)} A settled — the limit is a transient guard, not a power cap`,
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

// -------------------------------------------------- mid-flight state seeding

section('Replay: a model can be restarted from a logged state');
{
  // The replay harness depends on this and nothing else tested it. Fly one sim,
  // copy its state into a second, and the second must continue the flight
  // rather than lurch. Getting this wrong is invisible in the model and shows
  // up only as a comparison that says the model is wrong when it is not.
  const a = new FlightSim();
  airborne(a, 100);
  const input = sticks({ throttle: 0.4, roll: 0.6, pitch: -0.3, yaw: 0.2 });
  run(a, input, 1.5);

  const b = new FlightSim();
  b.reset();
  b.armed = true;
  b.pos.z = a.pos.z;
  b.onGround = false;
  b.vel.x = a.vel.x;
  b.vel.y = a.vel.y;
  b.vel.z = a.vel.z;
  b.omega.x = a.omega.x;
  b.omega.y = a.omega.y;
  b.omega.z = a.omega.z;
  b.q.w = a.q.w;
  b.q.x = a.q.x;
  b.q.y = a.q.y;
  b.q.z = a.q.z;
  for (let i = 0; i < a.motors.length; i++) b.motors[i]!.omega = a.motors[i]!.omega;
  for (let ax = 0; ax < 3; ax++) b.controller.axes[ax]!.integral = a.controller.axes[ax]!.integral;
  b.battery.voltage = a.battery.voltage;
  b.primeControlState(a.telemetry.gyro, a.telemetry.setpoint);

  // One step each. With the state copied and the filters primed they should
  // agree closely; without primeControlState the D-term alone throws it out.
  a.step(input);
  b.step(input);
  const dGyro = Math.abs(a.telemetry.gyro.x - b.telemetry.gyro.x);
  const dMotor = Math.abs((a.telemetry.motorOutputs[0] ?? 0) - (b.telemetry.motorOutputs[0] ?? 0));
  ok('seeded model matches on the next gyro sample', dGyro < 0.5, `${dGyro.toFixed(4)} deg/s apart`);
  ok('seeded model commands the same motor output', dMotor < 0.05, `${dMotor.toFixed(4)} apart on motor 1`);
}

// --------------------------------------------------------------- rate curves

section('Rates: three curves, and the units a pilot actually sees');
{
  // KISS is not Betaflight's curve. They agree only when expo is near zero,
  // which is true of the quad this was first checked against and is not true in
  // general — with expo 40 they are 8% apart at half stick.
  const bf: RateProfile = { type: 'betaflight', rcRate: [105,105,105], rate: [59,59,59], expo: [40,40,40] };
  const kiss: RateProfile = { ...bf, type: 'kiss' };
  const half = Math.abs(applyRates(kiss, AXIS_ROLL, 0.5) - applyRates(bf, AXIS_ROLL, 0.5));
  ok(
    'KISS and Betaflight differ once expo is real',
    half > 5,
    `${applyRates(bf, AXIS_ROLL, 0.5).toFixed(1)} vs ${applyRates(kiss, AXIS_ROLL, 0.5).toFixed(1)} deg/s at half stick`,
  );
  const zeroExpo: RateProfile = { ...bf, expo: [0,0,0] };
  const zeroKiss: RateProfile = { ...zeroExpo, type: 'kiss' };
  ok(
    'and coincide when it is not',
    Math.abs(applyRates(zeroExpo, AXIS_ROLL, 0.5) - applyRates(zeroKiss, AXIS_ROLL, 0.5)) < 0.5,
    'expo 0: the two agree, which is why the difference went unnoticed',
  );
  ok(
    'both reach the same rate at full stick',
    Math.abs(applyRates(bf, AXIS_ROLL, 1) - applyRates(kiss, AXIS_ROLL, 1)) < 0.5,
    `${applyRates(bf, AXIS_ROLL, 1).toFixed(1)} deg/s`,
  );

  // Display units must round-trip: what a configurator shows, converted in and
  // back out, has to be the same number.
  let worst = 0;
  for (const type of ['actual', 'betaflight', 'kiss'] as const) {
    RATE_FIELDS[type].forEach((spec, f) => {
      for (const shown of [0.5, 1.05, 20, 200, 800]) {
        const stored = shown / spec.scale;
        worst = Math.max(worst, Math.abs(stored * spec.scale - shown));
      }
      void f;
    });
  }
  ok('configurator units round-trip exactly', worst < 1e-9, `worst error ${worst.toExponential(1)}`);

  // The real quad's numbers, as they read on screen.
  const nac: RateProfile = { type: 'kiss', rcRate: [105,95,87], rate: [59,59,58], expo: [1,1,10] };
  const f = RATE_FIELDS.kiss;
  ok(
    'a real tune displays the way its configurator does',
    Math.abs(nac.rcRate[0] * f[0]!.scale - 1.05) < 1e-9 &&
      Math.abs(nac.rate[0] * f[1]!.scale - 0.59) < 1e-9,
    `RC rate ${(nac.rcRate[0] * f[0]!.scale).toFixed(2)}, rate ${(nac.rate[0] * f[1]!.scale).toFixed(2)}, ` +
      `full stick ${applyRates(nac, AXIS_ROLL, 1).toFixed(0)} deg/s`,
  );
}

// ------------------------------------------------------------- applying a tune

section('Tune: changing rates and PIDs must actually change the flying');
{
  // A tune the model accepts but does not fly is worse than no tune UI at all,
  // because it looks like it worked.
  const gentle: RateProfile = {
    type: 'betaflight',
    rcRate: [105, 95, 87],
    rate: [59, 59, 58],
    expo: [1, 1, 10],
  };
  ok(
    'the two curves disagree where it matters',
    Math.abs(applyRates(gentle, AXIS_ROLL, 1)) < 600 &&
      Math.abs(applyRates(defaultRates(), AXIS_ROLL, 1)) > 750,
    `full stick: ${applyRates(gentle, AXIS_ROLL, 1).toFixed(0)} vs ` +
      `${applyRates(defaultRates(), AXIS_ROLL, 1).toFixed(0)} deg/s`,
  );

  const flyFullStick = (rates: RateProfile): number => {
    const sim = new FlightSim({ airframe: kronos() });
    sim.applyTune(rates, defaultPids());
    sim.reset(0);
    sim.arm(sticks());
    sim.pos.z = -200;
    sim.onGround = false;
    run(sim, sticks({ throttle: 0.3, roll: 1 }), 1.2);
    return sim.telemetry.gyro.x;
  };
  const fast = flyFullStick(defaultRates());
  const slow = flyFullStick(gentle);
  ok(
    'applyTune changes the rate the quad actually achieves',
    fast > slow + 150,
    `${fast.toFixed(0)} deg/s on the default curve vs ${slow.toFixed(0)} on the gentler one`,
  );
  ok(
    'each tracks its own setpoint',
    Math.abs(slow - applyRates(gentle, AXIS_ROLL, 1)) < 60,
    `achieved ${slow.toFixed(0)} against a ${applyRates(gentle, AXIS_ROLL, 1).toFixed(0)} deg/s setpoint`,
  );
}

// --------------------------------------------------- settling at low throttle

section('Control: releasing the stick must settle, at any throttle');
{
  // From a pilot report, not from theory: "put in a little roll or pitch
  // without throttle and let it go, and the quad shakes as if trying to
  // stabilise itself back". In acro nothing should return it anywhere — the
  // rate should simply go to zero and stay there.
  //
  // The cause was that the simulator flew the uncalibrated airframe, whose
  // motor time constant was four times the measured one. Low throttle is where
  // that hurts most, because it is where the demanded rotor speed change is
  // largest. No test covered it, so this is that test.
  const settleAt = (throttle: number): { ms: number; crossings: number } => {
    const sim = new FlightSim({ airframe: kronos() });
    sim.reset(0);
    sim.arm(sticks());
    sim.pos.z = -80;
    sim.onGround = false;
    const hold = sticks({ throttle });
    run(sim, hold, 1.5);
    run(sim, sticks({ throttle, roll: 0.25 }), 0.25);
    const trace: number[] = [];
    for (let i = 0; i < 1200; i++) {
      sim.step(hold);
      trace.push(sim.telemetry.gyro.x);
    }
    let ms = trace.length;
    for (let i = trace.length - 1; i >= 0; i--) {
      if (Math.abs(trace[i]!) > 15) {
        ms = i + 1;
        break;
      }
    }
    const crossings = trace
      .slice(0, 600)
      .reduce((n, v, i, a) => (i > 0 && v > 0 !== a[i - 1]! > 0 ? n + 1 : n), 0);
    return { ms, crossings };
  };

  for (const throttle of [0, 0.05, 0.16, 0.4]) {
    const { ms, crossings } = settleAt(throttle);
    ok(
      `settles after release at ${(throttle * 100).toFixed(0)}% throttle`,
      ms < 250,
      `${ms} ms to stay inside 15 deg/s, ${crossings} zero crossings`,
    );
  }

  // And the thing the pilot actually described: with the sticks centred it must
  // hold whatever attitude it has, not seek level.
  const sim = new FlightSim({ airframe: kronos() });
  sim.reset(0);
  sim.arm(sticks());
  sim.pos.z = -60;
  sim.onGround = false;
  fromEuler(sim.q, 40 * DEG_TO_RAD, 0, 0);
  // One step first: telemetry is only refreshed inside step(), so reading it
  // straight after setting the quaternion returns the previous state.
  sim.step(sticks({ throttle: 0 }));
  const before = sim.telemetry.attitude.roll;
  run(sim, sticks({ throttle: 0 }), 2.5);
  const after = sim.telemetry.attitude.roll;
  ok(
    'holds attitude with the sticks centred — this is acro, not angle mode',
    Math.abs(after - before) < 2,
    `roll ${before.toFixed(1)}° -> ${after.toFixed(1)}° over 2.5 s at zero throttle`,
  );
}

// ----------------------------------------------------------------- collision

section('Collision: the ground and the things standing on it');
{
  const mk = (): FlightSim => new FlightSim({ airframe: kronos() });

  // Resting is the hardest case for penalty contact: too soft and it sinks,
  // too stiff and it buzzes.
  const resting = mk();
  resting.reset(0);
  run(resting, sticks(), 5);
  ok(
    'sits still on the ground without sinking or buzzing',
    Math.abs(resting.telemetry.altitude - 0.045) < 0.005 &&
      Math.hypot(resting.omega.x, resting.omega.y, resting.omega.z) < 0.01,
    `altitude ${resting.telemetry.altitude.toFixed(4)} m, ` +
      `rates ${Math.hypot(resting.omega.x, resting.omega.y, resting.omega.z).toFixed(5)} rad/s`,
  );

  // Set down at an angle it must fall flat, which a position clamp could not do.
  const tipped = mk();
  tipped.reset(0);
  fromEuler(tipped.q, 45 * DEG_TO_RAD, 0, 0);
  tipped.pos.z = -0.3;
  tipped.onGround = false;
  run(tipped, sticks(), 4);
  ok(
    'dropped at 45 degrees, it falls flat',
    Math.abs(tipped.telemetry.attitude.roll) < 8,
    `settled at ${tipped.telemetry.attitude.roll.toFixed(1)}°`,
  );

  const gentle = mk();
  gentle.reset(0);
  gentle.arm(sticks());
  gentle.pos.z = -2;
  gentle.onGround = false;
  run(gentle, sticks({ throttle: 0.14 }), 3);
  ok('a gentle landing is not a crash', !gentle.crashed, `on the ground, still intact`);

  const hard = mk();
  hard.reset(0);
  hard.arm(sticks());
  hard.pos.z = -30;
  hard.onGround = false;
  run(hard, sticks(), 5);
  ok(
    'a 30 m drop is, and it disarms',
    hard.crashed && !hard.armed,
    `crashed at ${hard.crashSpeed.toFixed(1)} m/s`,
  );

  // Scenery.
  const post = mk();
  post.reset(0);
  post.arm(sticks());
  post.obstacles = [{ kind: 'cylinder', north: 10, east: 0, radius: 0.2, height: 5 }];
  post.pos.z = -2;
  post.onGround = false;
  post.vel.x = 12;
  run(post, sticks({ throttle: 0.16 }), 3);
  ok(
    'flying into a pylon crashes, and stops at its face',
    post.crashed && Math.abs(post.pos.x - 9.8) < 0.5,
    `stopped at ${post.pos.x.toFixed(2)} m north against a face at 9.8`,
  );

  const clear = mk();
  clear.reset(0);
  clear.arm(sticks());
  clear.obstacles = [{ kind: 'cylinder', north: 10, east: 6, radius: 0.2, height: 5 }];
  clear.pos.z = -2;
  clear.onGround = false;
  clear.vel.x = 12;
  run(clear, sticks({ throttle: 0.16 }), 2);
  ok(
    'and passing beside one does not',
    !clear.crashed && clear.pos.x > 15,
    `travelled ${clear.pos.x.toFixed(1)} m north, clear`,
  );

  // Under a gate bar is flying; through the bar is not.
  const bar: Obstacle = {
    kind: 'box',
    minNorth: 9.8, maxNorth: 10.2, minEast: -2, maxEast: 2, minUp: 2.5, maxUp: 2.8,
  };
  const under = mk();
  under.reset(0);
  under.arm(sticks());
  under.obstacles = [bar];
  under.pos.z = -1.4;
  under.onGround = false;
  under.vel.x = 12;
  run(under, sticks({ throttle: 0.16 }), 2);
  ok('flying under a gate bar is clear', !under.crashed, `passed at ${under.pos.x.toFixed(1)} m`);

  const into = mk();
  into.reset(0);
  into.arm(sticks());
  into.obstacles = [bar];
  // Aimed at the middle of the bar and started close to it. Over a longer run
  // the quad sinks a few centimetres — thrust falls as it accelerates into its
  // own inflow — and slips under a bar only 300 mm tall, which is the model
  // being right and the test being careless.
  into.pos.x = 8;
  into.pos.z = -(2.65 + 0.045);
  into.onGround = false;
  into.vel.x = 12;
  run(into, sticks({ throttle: 0.16 }), 0.4);
  ok('flying into it is not', into.crashed, `crashed at ${into.crashSpeed.toFixed(1)} m/s`);

  // A crashed quad must not simply re-arm where it lies: without this it would
  // fly on with the crash flag still set and the banner still up.
  ok(
    'a crashed quad refuses to arm',
    hard.arm(sticks()) === false && !hard.armed,
    'arming refused until it is reset',
  );

  ok(
    'the model remembers it was flying when it crashed',
    hard.armedAtCrash === true,
    'so a reset can hand back an armed quad rather than making the pilot re-arm',
  );

  // Crashing while already disarmed must not hand back an armed quad.
  const droppedIdle = mk();
  droppedIdle.reset(0);
  droppedIdle.pos.z = -30;
  droppedIdle.onGround = false;
  run(droppedIdle, sticks(), 5);
  ok(
    'but not when it was already disarmed',
    droppedIdle.crashed && droppedIdle.armedAtCrash === false,
    `crashed at ${droppedIdle.crashSpeed.toFixed(1)} m/s while disarmed`,
  );

  // Reset has to clear the wreck, and then arming works again.
  hard.reset(0);
  ok('reset clears the crash', !hard.crashed && hard.crashSpeed === 0, 'back to intact');
  ok('and arming works again afterwards', hard.arm(sticks()) === true, 'armed');
}

// ------------------------------------------------------------- camera basis

section('Renderer: the camera basis must stay orthonormal');
{
  // Not a rendering test — a maths one. A basis that is not orthonormal still
  // draws a picture, just a sheared one, and the error is easy to look at and
  // not notice.
  const check = (tiltDeg: number, rollDeg: number, pitchDeg: number): void => {
    const t = tiltDeg * DEG_TO_RAD;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const fwdB = { x: ct, y: 0, z: -st };
    const upB = { x: -st, y: 0, z: -ct };
    const rightB = { x: 0, y: 1, z: 0 };

    const q = { w: 1, x: 0, y: 0, z: 0 };
    fromEuler(q, rollDeg * DEG_TO_RAD, pitchDeg * DEG_TO_RAD, 0);
    const f = rotateBodyToWorld({ x: 0, y: 0, z: 0 }, q, fwdB);
    const u = rotateBodyToWorld({ x: 0, y: 0, z: 0 }, q, upB);
    const r = rotateBodyToWorld({ x: 0, y: 0, z: 0 }, q, rightB);

    const dot = (a: typeof f, b: typeof f): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const len = (a: typeof f): number => Math.hypot(a.x, a.y, a.z);
    const worst = Math.max(
      Math.abs(dot(f, u)),
      Math.abs(dot(f, r)),
      Math.abs(dot(u, r)),
      Math.abs(len(f) - 1),
      Math.abs(len(u) - 1),
      Math.abs(len(r) - 1),
    );
    ok(
      `camera basis orthonormal at tilt ${tiltDeg}, roll ${rollDeg}, pitch ${pitchDeg}`,
      worst < 1e-9,
      `worst deviation ${worst.toExponential(2)}`,
    );
  };
  check(0, 0, 0);
  check(25, 0, 0);
  check(40, 35, -20);
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
