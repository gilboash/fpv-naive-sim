/**
 * The 1 kHz flight model.
 *
 * Order of business in one step, which is also the order a real quad does it:
 * stick -> rate setpoint -> PID against the gyro -> mixer -> ESC -> motor
 * electrical -> rotor aerodynamics -> forces and moments -> rigid body.
 *
 * Nothing here allocates. The whole step runs inside the input tick measured in
 * M0, which leaves a budget of roughly one millisecond, and a garbage collector
 * arriving mid-flip is exactly the kind of stall that measurement was for.
 */

import type { Airframe } from './airframe.ts';
import { racer5 } from './airframe.ts';
import { PT1 } from './filter.ts';
import type { Quat, Vec3 } from './math.ts';
import {
  DEG,
  RAD,
  addScaledV,
  clamp,
  crossV,
  quat,
  rotateBodyToWorld,
  rotateWorldToBody,
  setV,
  vec3,
  integrateQ,
  lenV,
} from './math.ts';
import { Mixer } from './mixer.ts';
import { Battery, Motor } from './motor.ts';
import type { PidProfile } from './pid.ts';
import { PID_MIXER_SCALING, RateController, defaultPids } from './pid.ts';
import type { RateProfile } from './rates.ts';
import { AXIS_PITCH, AXIS_ROLL, AXIS_YAW, applyRates, defaultRates } from './rates.ts';
import { RHO_SEA_LEVEL, Rotor } from './rotor.ts';

export const G = 9.80665;
export const DEFAULT_DT = 1 / 1000;

/**
 * Gyro full-scale, deg/s. Every gyro Betaflight runs on is configured to
 * +-2000 deg/s, and past that the sensor clips: the flight controller does not
 * merely respond badly to a violent tumble, it cannot see how fast it is going.
 * Leaving this out gave the model perfect knowledge in exactly the situation
 * where a real quad has none.
 */
export const GYRO_LIMIT_DPS = 2000;

export interface StickInput {
  /** 0..1 */
  throttle: number;
  /** -1..1 */
  roll: number;
  /** -1..1 */
  pitch: number;
  /** -1..1 */
  yaw: number;
}

export interface SimOptions {
  airframe?: Airframe;
  pids?: PidProfile;
  rates?: RateProfile;
  dt?: number;
  rho?: number;
  airmode?: boolean;
  /** Height of the CG above the ground when sitting on its feet, m. */
  standHeight?: number;
}

/** Everything the renderer or a telemetry panel needs, updated in place. */
export interface Telemetry {
  /** The stick input this step ran on, held between radio reports. */
  rcThrottle: number;
  rcRoll: number;
  rcPitch: number;
  rcYaw: number;
  /** deg/s, body axes. */
  gyro: Vec3;
  /** deg/s, what the PID was asked for. */
  setpoint: Vec3;
  /** Euler attitude, degrees. */
  attitude: { roll: number; pitch: number; yaw: number };
  /** Metres above the ground plane. */
  altitude: number;
  /** m/s, magnitude. */
  speed: number;
  /** Body-frame acceleration in g, as an accelerometer would read it. */
  accel: Vec3;
  motorOutputs: number[];
  motorRpm: number[];
  motorThrust: number[];
  totalThrustN: number;
  batteryV: number;
  batteryA: number;
  batteryPct: number;
  armed: boolean;
  onGround: boolean;
  mixerSaturated: boolean;
}

export class FlightSim {
  readonly airframe: Airframe;
  readonly dt: number;
  readonly rates: RateProfile;
  readonly controller: RateController;
  readonly mixer: Mixer;
  readonly motors: Motor[] = [];
  readonly rotors: Rotor[] = [];
  readonly battery: Battery;

  /** World position, NED, metres. Altitude is -pos.z. */
  readonly pos: Vec3 = vec3();
  /** World velocity, m/s. */
  readonly vel: Vec3 = vec3();
  /** Body to world. */
  readonly q: Quat = quat();
  /** Body angular velocity, rad/s. */
  readonly omega: Vec3 = vec3();

  armed = false;
  onGround = true;
  /** Seconds of simulated time since reset. */
  time = 0;

  readonly telemetry: Telemetry;

  private rho: number;
  private standHeight: number;
  private gyroFilter: [PT1, PT1, PT1];

  // Scratch, reused every step. See the file header on allocation.
  private fBody = vec3();
  private mBody = vec3();
  private fWorld = vec3();
  private vBody = vec3();
  private hubVel = vec3();
  private tmp = vec3();
  private gyroDeg = vec3();
  private setpointDeg = vec3();
  private angMomentum = vec3();
  private lastAccelBody = vec3();

  constructor(opts: SimOptions = {}) {
    this.airframe = opts.airframe ?? racer5();
    this.dt = opts.dt ?? DEFAULT_DT;
    this.rates = opts.rates ?? defaultRates();
    this.rho = opts.rho ?? RHO_SEA_LEVEL;
    this.standHeight = opts.standHeight ?? 0.045;

    const pids = opts.pids ?? defaultPids();
    this.controller = new RateController(pids, this.dt);
    this.mixer = new Mixer(this.airframe.mounts, opts.airmode ?? true);
    this.battery = new Battery(this.airframe.battery);

    for (let i = 0; i < this.airframe.mounts.length; i++) {
      this.motors.push(new Motor(this.airframe.motor));
      this.rotors.push(new Rotor(this.airframe.prop, this.rho));
    }

    this.gyroFilter = [
      new PT1(pids.gyroLowpassHz, this.dt),
      new PT1(pids.gyroLowpassHz, this.dt),
      new PT1(pids.gyroLowpassHz, this.dt),
    ];

    this.telemetry = {
      rcThrottle: 0,
      rcRoll: 0,
      rcPitch: 0,
      rcYaw: 0,
      gyro: vec3(),
      setpoint: vec3(),
      attitude: { roll: 0, pitch: 0, yaw: 0 },
      altitude: 0,
      speed: 0,
      accel: vec3(),
      motorOutputs: new Array<number>(this.motors.length).fill(0),
      motorRpm: new Array<number>(this.motors.length).fill(0),
      motorThrust: new Array<number>(this.motors.length).fill(0),
      totalThrustN: 0,
      batteryV: this.battery.voltage,
      batteryA: 0,
      batteryPct: 100,
      armed: false,
      onGround: true,
      mixerSaturated: false,
    };

    this.reset();
  }

  /** Put it back on the ground, level, facing north, with a full pack. */
  reset(yawDeg = 0): void {
    setV(this.pos, 0, 0, -this.standHeight);
    setV(this.vel, 0, 0, 0);
    setV(this.omega, 0, 0, 0);
    const half = yawDeg * DEG * 0.5;
    this.q.w = Math.cos(half);
    this.q.x = 0;
    this.q.y = 0;
    this.q.z = Math.sin(half);
    this.armed = false;
    this.onGround = true;
    this.time = 0;
    this.battery.reset();
    this.controller.reset();
    for (const m of this.motors) m.reset();
    for (const f of this.gyroFilter) f.reset(0);
    setV(this.lastAccelBody, 0, 0, 0);
  }

  /** Arming refuses at anything but idle throttle, exactly as a real FC does. */
  arm(input: StickInput): boolean {
    if (input.throttle > 0.05) return false;
    this.armed = true;
    this.controller.reset();
    return true;
  }

  disarm(): void {
    this.armed = false;
    for (const m of this.motors) m.command = 0;
  }

  /**
   * One fixed step.
   *
   * `input` is held between radio reports by the caller. The M0 measurement
   * found the transmitter reporting at ~200 Hz, so four steps in five see the
   * same stick values, and the model must be indifferent to that.
   */
  step(input: StickInput): void {
    const dt = this.dt;
    const af = this.airframe;

    // ---- gyro, filtered as the flight controller sees it
    const gyro = this.gyroDeg;
    const lim = GYRO_LIMIT_DPS;
    gyro.x = this.gyroFilter[0].apply(clamp(this.omega.x * RAD, -lim, lim));
    gyro.y = this.gyroFilter[1].apply(clamp(this.omega.y * RAD, -lim, lim));
    gyro.z = this.gyroFilter[2].apply(clamp(this.omega.z * RAD, -lim, lim));

    // ---- rate setpoints
    const sp = this.setpointDeg;
    sp.x = applyRates(this.rates, AXIS_ROLL, input.roll);
    sp.y = applyRates(this.rates, AXIS_PITCH, input.pitch);
    sp.z = applyRates(this.rates, AXIS_YAW, input.yaw);

    const thr = clamp(input.throttle, 0, 1);

    // ---- rate controller
    let mixRoll = 0;
    let mixPitch = 0;
    let mixYaw = 0;
    if (this.armed) {
      mixRoll = this.controller.update(AXIS_ROLL, sp.x, gyro.x, thr) / PID_MIXER_SCALING;
      mixPitch = this.controller.update(AXIS_PITCH, sp.y, gyro.y, thr) / PID_MIXER_SCALING;
      mixYaw = this.controller.update(AXIS_YAW, sp.z, gyro.z, thr) / PID_MIXER_SCALING;
    }

    const mix = this.mixer.apply(this.armed ? thr : 0, mixRoll, mixPitch, mixYaw);

    // ---- airspeed in the body frame
    rotateWorldToBody(this.vBody, this.q, this.vel);

    // ---- rotors and motors
    setV(this.fBody, 0, 0, 0);
    setV(this.mBody, 0, 0, 0);
    setV(this.angMomentum, 0, 0, 0);

    let totalCurrent = 0;
    let totalThrust = 0;
    const vBatt = this.battery.voltage;

    for (let i = 0; i < this.motors.length; i++) {
      const mount = af.mounts[i]!;
      const motor = this.motors[i]!;
      const rotor = this.rotors[i]!;

      // Velocity of this hub through the air = body velocity + omega x r.
      crossV(this.tmp, this.omega, mount.pos);
      this.hubVel.x = this.vBody.x + this.tmp.x;
      this.hubVel.y = this.vBody.y + this.tmp.y;
      this.hubVel.z = this.vBody.z + this.tmp.z;

      // Thrust points along body -z, so climbing means -z velocity.
      const vAxial = -this.hubVel.z;
      const vInPlane = Math.hypot(this.hubVel.x, this.hubVel.y);

      const r = rotor.solve(motor.omega, vAxial, vInPlane);
      motor.update(mix.outputs[i]!, vBatt, r.torque, dt, this.armed);
      totalCurrent += motor.current;
      totalThrust += r.thrust;

      this.telemetry.motorThrust[i] = r.thrust;

      // Thrust force, body frame, and its moment about the CG.
      this.fBody.z -= r.thrust;
      this.mBody.x += -mount.pos.y * r.thrust;
      this.mBody.y += mount.pos.x * r.thrust;

      // Reaction to shaft torque. A CCW rotor (spin +1) yaws the frame nose-right.
      this.mBody.z += mount.spin * r.torque;

      // Disc drag, opposing in-plane motion, applied at the disc.
      if (vInPlane > 1e-4 && r.hDrag > 0) {
        const ux = this.hubVel.x / vInPlane;
        const uy = this.hubVel.y / vInPlane;
        const hx = -ux * r.hDrag;
        const hy = -uy * r.hDrag;
        this.fBody.x += hx;
        this.fBody.y += hy;
        // r x F with F in the xy plane and r having a z component.
        this.mBody.x += -mount.pos.z * hy;
        this.mBody.y += mount.pos.z * hx;
        this.mBody.z += mount.pos.x * hy - mount.pos.y * hx;
      }

      // Rotor angular momentum, for the gyroscopic term. A CCW rotor spins
      // about -z.
      this.angMomentum.z += -mount.spin * af.motor.inertia * motor.omega;
    }

    this.battery.update(totalCurrent, dt);

    // ---- airframe drag, per body axis
    const halfRho = 0.5 * this.rho;
    this.fBody.x -= halfRho * af.dragArea.x * this.vBody.x * Math.abs(this.vBody.x);
    this.fBody.y -= halfRho * af.dragArea.y * this.vBody.y * Math.abs(this.vBody.y);
    this.fBody.z -= halfRho * af.dragArea.z * this.vBody.z * Math.abs(this.vBody.z);

    // ---- gyroscopic precession from the spinning rotors
    crossV(this.tmp, this.omega, this.angMomentum);
    this.mBody.x -= this.tmp.x;
    this.mBody.y -= this.tmp.y;
    this.mBody.z -= this.tmp.z;

    // ---- linear dynamics, in the world frame
    rotateBodyToWorld(this.fWorld, this.q, this.fBody);
    const invM = 1 / af.mass;
    const ax = this.fWorld.x * invM;
    const ay = this.fWorld.y * invM;
    const az = this.fWorld.z * invM + G;

    // Record the specific force, which is what an accelerometer measures: the
    // same sum without gravity, in the body frame.
    setV(this.tmp, this.fWorld.x * invM, this.fWorld.y * invM, this.fWorld.z * invM);
    rotateWorldToBody(this.lastAccelBody, this.q, this.tmp);

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;

    // ---- angular dynamics: I*wdot = M - w x (I*w)
    const I = af.inertia;
    setV(this.tmp, I.x * this.omega.x, I.y * this.omega.y, I.z * this.omega.z);
    const gx = this.omega.y * this.tmp.z - this.omega.z * this.tmp.y;
    const gy = this.omega.z * this.tmp.x - this.omega.x * this.tmp.z;
    const gz = this.omega.x * this.tmp.y - this.omega.y * this.tmp.x;
    this.omega.x += ((this.mBody.x - gx) / I.x) * dt;
    this.omega.y += ((this.mBody.y - gy) / I.y) * dt;
    this.omega.z += ((this.mBody.z - gz) / I.z) * dt;

    integrateQ(this.q, this.omega, dt);

    addScaledV(this.pos, this.pos, this.vel, dt);

    this.groundContact();

    this.time += dt;
    this.updateTelemetry(mix.outputs, mix.saturated, totalThrust, input);
  }

  /**
   * Ground plane at z = 0, and no more than that.
   *
   * This is a hard floor with friction, not a contact model: no per-arm
   * collision, no tumbling, no prop strikes. M1 is the flight model, and the
   * ground exists here only so that "sitting still before takeoff" and "you
   * have landed" are representable. Crashes are a later milestone's problem.
   */
  private groundContact(): void {
    const floor = -this.standHeight;
    if (this.pos.z < floor) {
      this.onGround = false;
      return;
    }
    this.onGround = true;
    this.pos.z = floor;
    if (this.vel.z > 0) this.vel.z = 0;

    // Ground friction, strong enough that it does not slide away on its own.
    const k = 0.85;
    this.vel.x *= k;
    this.vel.y *= k;
    this.omega.x *= 0.6;
    this.omega.y *= 0.6;
    this.omega.z *= 0.6;
  }

  private updateTelemetry(
    outputs: number[],
    saturated: boolean,
    totalThrust: number,
    input: StickInput,
  ): void {
    const t = this.telemetry;
    t.rcThrottle = input.throttle;
    t.rcRoll = input.roll;
    t.rcPitch = input.pitch;
    t.rcYaw = input.yaw;
    t.gyro.x = this.gyroDeg.x;
    t.gyro.y = this.gyroDeg.y;
    t.gyro.z = this.gyroDeg.z;
    t.setpoint.x = this.setpointDeg.x;
    t.setpoint.y = this.setpointDeg.y;
    t.setpoint.z = this.setpointDeg.z;

    const q = this.q;
    const sinp = clamp(2 * (q.w * q.y - q.z * q.x), -1, 1);
    t.attitude.roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) * RAD;
    t.attitude.pitch = Math.asin(sinp) * RAD;
    t.attitude.yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * RAD;

    t.altitude = -this.pos.z;
    t.speed = lenV(this.vel);
    t.accel.x = this.lastAccelBody.x / G;
    t.accel.y = this.lastAccelBody.y / G;
    t.accel.z = this.lastAccelBody.z / G;

    for (let i = 0; i < outputs.length; i++) {
      t.motorOutputs[i] = outputs[i]!;
      t.motorRpm[i] = this.motors[i]!.rpm;
    }
    t.totalThrustN = totalThrust;
    t.batteryV = this.battery.voltage;
    t.batteryA = this.battery.current;
    t.batteryPct = this.battery.stateOfCharge * 100;
    t.armed = this.armed;
    t.onGround = this.onGround;
    t.mixerSaturated = saturated;
  }
}
