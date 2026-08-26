/**
 * The airframe: what the quad is, as opposed to what it does.
 *
 * Motor positions are in the body frame (x forward, y right, z down), so the
 * rotor discs sit slightly *above* the centre of gravity and therefore have a
 * negative z. That offset is not decoration: it is the lever arm that turns
 * disc drag into a pitching moment, and it is why a real quad wants to pitch
 * back as it accelerates.
 */

import type { BatterySpec, MotorSpec } from './motor.ts';
import { defaultBattery, defaultMotor } from './motor.ts';
import type { PropSpec } from './rotor.ts';
import { defaultProp } from './rotor.ts';
import type { Vec3 } from './math.ts';

export interface MotorMount {
  /** Position of the rotor hub in the body frame, m. */
  pos: Vec3;
  /**
   * +1 if the rotor turns counter-clockwise seen from above, which is the
   * direction whose reaction torque yaws the airframe nose-right.
   */
  spin: 1 | -1;
}

export interface Airframe {
  name: string;
  /** All-up mass including battery, kg. */
  mass: number;
  /** Diagonal of the inertia tensor about the CG, kg*m^2. */
  inertia: Vec3;
  /** Effective drag area per body axis, m^2. */
  dragArea: Vec3;
  mounts: MotorMount[];
  motor: MotorSpec;
  prop: PropSpec;
  battery: BatterySpec;
}

/**
 * Gilboa's NACRONOS: Kronos Legacy frame, 250 g dry plus a 220 g 6S 1480 mAh
 * 160C pack, Gemfan 51377 props, 2107 motors at 2080 KV.
 *
 * A real build rather than a representative one, and the airframe the Blackbox
 * comparison runs against. Lighter and much higher-revving than the generic
 * racer below: a 3.7" pitch on 2080 KV trades pitch speed for response, and at
 * 470 g all-up it accelerates harder than its thrust-to-weight alone suggests.
 *
 * Inertia and the rotor's aerodynamic scale are not guesses here — both were
 * measured from the logs, see tools/identify.ts and the README.
 */
export function kronos(): Airframe {
  // 205 mm motor-to-motor diagonal, measured on the frame. A symmetric X, so
  // the offset is the same on both axes: (205/2)/sqrt(2). The earlier 77.8 mm
  // assumed a 220 mm frame.
  const a = 0.0725;
  const zDisc = -0.021;
  const base = racer5();
  return {
    ...base,
    name: 'Kronos Legacy, 6S',
    mass: 0.47,
    // Measured from the logs by tools/identify.ts, not estimated: thrust
    // differential across the arms against the gyro's derivative. Roll came out
    // at 1.639e-3 on the corrected 205 mm arm. Pitch fits at 7.8e-4, less than
    // half of roll, which a symmetric X frame should not give. A stretched
    // frame would have explained it; the frame is not stretched. So it remains
    // unexplained, it is the weaker fit (half the samples, much smaller thrust
    // differentials), and it sits alongside pitch being the worst axis in the
    // replay comparison — the two are probably the same unknown.
    //
    // Yaw is Ixx + Iyy by the perpendicular axis theorem, the quad being near
    // enough planar.
    inertia: { x: 0.00164, y: 0.00078, z: 0.00242 },
    dragArea: { x: 0.0048, y: 0.0056, z: 0.011 },
    mounts: [
      { pos: { x: -a, y: a, z: zDisc }, spin: -1 },
      { pos: { x: a, y: a, z: zDisc }, spin: 1 },
      { pos: { x: -a, y: -a, z: zDisc }, spin: 1 },
      { pos: { x: a, y: -a, z: zDisc }, spin: -1 },
    ],
    motor: {
      ...defaultMotor(),
      kv: 2080,
      // Set from the measured rotor response, not guessed. The mechanical time
      // constant of this motor model is J*R/ke^2, and the logs put the real one
      // at 11.5 ms (p10-p90 8-28). An estimated 0.16 ohm with 6.5e-6 kg*m^2
      // gave 49 ms — four times too slow, which is most of why the model
      // responded too softly and about 10 ms late on every axis.
      //
      // The high resistance had been standing in for current limiting. Now that
      // maxCurrent does that job explicitly, and does it the way an ESC does,
      // the resistance can be what a 2107 winding actually is.
      resistance: 0.045,
      inertia: 5.5e-6,
      // 278 A peak pack draw in the log is ~70 A per motor. The earlier 50 A
      // was a guess, and it was current-limiting the model below the rotor
      // speed the aircraft actually reaches.
      maxCurrent: 70,
      ironLoss: 2.4e-9,
    },
    prop: {
      ...defaultProp(),
      // Gemfan 51377: 5.1" diameter, 3.7" pitch, 3 blades.
      radius: 0.0648,
      pitch: 0.094,
      blades: 3,
      chord: 0.0122,
      // Calibrated against the measured thrust coefficient, 1.148e-6
      // N/(rad/s)^2 per rotor. The blade-element model already had the shape
      // right — its error was a flat 14% across 6 000 to 26 000 rpm, so it
      // reproduces the omega-squared law and only the aerodynamic scale was
      // wrong. A lift slope of 5.7/rad is thin-aerofoil theory; a real prop
      // section at Reynolds ~40 000 does not achieve it, and neither does its
      // profile drag stay at 0.02.
      clAlpha: 3.7,
      cd0: 0.035,
      // Fitted, and the only fitted constant in the aerodynamics. At 2.4 the
      // model reproduces four independent things measured from the flight at
      // once — hover rotor speed 9 428 against 9 568, hover pack current 6.2 A
      // against 6.4, full-throttle 28 046 rpm against 28 286, and peak pack
      // current 280 A against 278.
      //
      // What this does NOT do is separate propeller drag from motor loss. The
      // data constrains their sum and nothing more, so the model is right about
      // system behaviour and unreliable about which component the loss belongs
      // to. A thrust-stand run on this prop, or motor efficiency data, would
      // split them; until then this number carries both.
      profileLoss: 2.4,
    },
    battery: {
      cells: 6,
      capacityAh: 1.48,
      // 160C on 1480 mAh is a very stiff pack.
      resistance: 0.011,
      cellFull: 4.2,
      cellEmpty: 3.5,
    },
  };
}

/**
 * A 5" racing quad on 6S: roughly a 220 mm frame, 2207 motors, 5.1x4.3x3
 * props, 1300 mAh. The numbers are a representative build rather than any
 * specific one, and every one of them is a parameter for a reason — the point
 * of the model is that changing them changes the feel correctly.
 */
export function racer5(): Airframe {
  const a = 0.0778; // motor offset on each axis; ~220 mm motor-to-motor diagonal
  const zDisc = -0.021; // rotor plane sits above the CG

  return {
    name: '5" racer, 6S',
    mass: 0.65,
    // Published system-identification figures for 5" racers in this mass class
    // cluster around 0.0035 in roll and pitch. An earlier parts-count estimate
    // here gave 0.0022, which was below every measurement I could find and gave
    // the model roll acceleration no real quad has.
    inertia: { x: 0.0035, y: 0.0038, z: 0.006 },
    dragArea: { x: 0.0055, y: 0.0065, z: 0.013 },
    mounts: [
      { pos: { x: -a, y: a, z: zDisc }, spin: -1 }, // rear right, CW
      { pos: { x: a, y: a, z: zDisc }, spin: 1 }, // front right, CCW
      { pos: { x: -a, y: -a, z: zDisc }, spin: 1 }, // rear left, CCW
      { pos: { x: a, y: -a, z: zDisc }, spin: -1 }, // front left, CW
    ],
    motor: defaultMotor(),
    prop: defaultProp(),
    battery: defaultBattery(),
  };
}
