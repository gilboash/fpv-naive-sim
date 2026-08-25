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
