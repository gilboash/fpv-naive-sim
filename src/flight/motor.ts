/**
 * Brushless motor and battery.
 *
 * The motor is modelled electrically rather than as a first-order lag on
 * thrust, because the lag is not symmetric and the asymmetry is most of what
 * a quad feels like. Spinning up, the ESC can apply the whole pack voltage.
 * Spinning down, nothing decelerates the prop except its own drag — there is
 * no brake — so it coasts. That difference is why a quad drops when you chop
 * throttle and why prop wash recovery feels the way it does, and a symmetric
 * time constant gets both wrong.
 *
 * Battery sag is here for the same reason: a punch-out on a tired pack does
 * not give you the thrust the tune assumed, and a pilot needs to have felt it.
 */

import { clamp } from './math.ts';

export interface MotorSpec {
  /** Motor velocity constant, rpm per volt, unloaded. */
  kv: number;
  /** Winding resistance, ohms. */
  resistance: number;
  /** Rotor plus prop inertia, kg*m^2. */
  inertia: number;
  /** Viscous friction, N*m per rad/s. */
  friction: number;
  /** Minimum commanded output while armed, 0..1. Betaflight's motor_idle. */
  idle: number;
  /**
   * Peak phase current the ESC will pass, A.
   *
   * Not cosmetic. Without it, a full-throttle command to a slow-turning motor
   * sees almost no back-EMF and the model asks for whatever current the
   * resistance allows — a recorded flight peaked at 92 A per motor, which no
   * 2207 or its ESC would survive, let alone deliver. Real ESCs limit, so this
   * one does too, and the limit binds only on transients: steady full throttle
   * settles around 44 A.
   */
  maxCurrent: number;
}

export function defaultMotor(): MotorSpec {
  return {
    kv: 1900,
    // Lumped, not the winding alone: this stands in for phase resistance plus
    // commutation and ESC losses. Using the ~0.05 ohm winding figure on its own
    // let the model pull 290 A at full throttle, which no 6S racing setup does.
    resistance: 0.13,
    inertia: 8e-6,
    friction: 2e-7,
    idle: 0.055,
    maxCurrent: 55,
  };
}

export interface BatterySpec {
  cells: number;
  /** Pack capacity, amp-hours. */
  capacityAh: number;
  /** Internal resistance of the whole pack, ohms. */
  resistance: number;
  /** Open-circuit volts per cell at full charge. */
  cellFull: number;
  /** Open-circuit volts per cell when empty. */
  cellEmpty: number;
}

export function defaultBattery(): BatterySpec {
  return {
    cells: 6,
    capacityAh: 1.3,
    resistance: 0.018,
    cellFull: 4.2,
    cellEmpty: 3.5,
  };
}

export class Battery {
  /** Charge used, amp-hours. */
  usedAh = 0;
  /** Terminal voltage under the present load. */
  voltage: number;
  /** Total current being drawn, A. */
  current = 0;

  spec: BatterySpec;

  constructor(spec: BatterySpec) {
    this.spec = spec;
    this.voltage = spec.cells * spec.cellFull;
  }

  reset(): void {
    this.usedAh = 0;
    this.current = 0;
    this.voltage = this.spec.cells * this.spec.cellFull;
  }

  get stateOfCharge(): number {
    return clamp(1 - this.usedAh / this.spec.capacityAh, 0, 1);
  }

  /** Open-circuit voltage at the present charge. */
  get openCircuit(): number {
    const s = this.spec;
    // Lithium packs hold voltage through the middle of the pack and fall off a
    // cliff at the end. A straight line would let a pilot fly a flat pack as if
    // it were fresh, which is exactly the habit a trainer should not teach.
    const soc = this.stateOfCharge;
    const shaped = soc > 0.2 ? 0.25 + 0.75 * ((soc - 0.2) / 0.8) : soc * 1.25;
    return s.cells * (s.cellEmpty + (s.cellFull - s.cellEmpty) * shaped);
  }

  /** Advance by dt at a given total draw, and return terminal voltage. */
  update(currentA: number, dt: number): number {
    this.current = currentA;
    this.usedAh += (currentA * dt) / 3600;
    this.voltage = Math.max(
      this.spec.cells * 2.8,
      this.openCircuit - currentA * this.spec.resistance,
    );
    return this.voltage;
  }
}

export class Motor {
  /** Shaft speed, rad/s. */
  omega = 0;
  /** Winding current, A. */
  current = 0;
  /** Last commanded output, 0..1. */
  command = 0;

  private ke: number;
  spec: MotorSpec;

  constructor(spec: MotorSpec) {
    this.spec = spec;
    // KV is rpm per volt unloaded; Ke is the inverse in SI, and equals Kt.
    this.ke = 60 / (2 * Math.PI * spec.kv);
  }

  reset(): void {
    this.omega = 0;
    this.current = 0;
    this.command = 0;
  }

  refreshConstants(): void {
    this.ke = 60 / (2 * Math.PI * this.spec.kv);
  }

  /**
   * @param cmd       ESC command, 0..1, before idle mapping
   * @param vBatt     pack terminal voltage
   * @param loadTorque prop torque opposing rotation, N*m
   * @param dt        step, s
   * @param armed     idle only applies while armed
   */
  update(cmd: number, vBatt: number, loadTorque: number, dt: number, armed: boolean): void {
    const s = this.spec;
    const c = armed ? s.idle + clamp(cmd, 0, 1) * (1 - s.idle) : 0;
    this.command = c;

    const vApplied = c * vBatt;
    const backEmf = this.ke * this.omega;
    this.current = (vApplied - backEmf) / s.resistance;

    // An ESC cannot regenerate into the pack. Without this the model brakes the
    // prop electrically on every throttle cut, which is the symmetric-lag error
    // this whole file exists to avoid.
    if (this.current < 0) this.current = 0;
    // ...nor can it pass unlimited current into a stalled motor.
    if (this.current > s.maxCurrent) this.current = s.maxCurrent;

    const motorTorque = this.ke * this.current;
    const drag = s.friction * this.omega;
    const net = motorTorque - loadTorque - drag;

    this.omega += (net / s.inertia) * dt;
    if (this.omega < 0) this.omega = 0;
  }

  get rpm(): number {
    return (this.omega * 60) / (2 * Math.PI);
  }
}
