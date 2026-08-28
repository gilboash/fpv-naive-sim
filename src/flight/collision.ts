/**
 * Contact: the ground, and the things on it.
 *
 * Replaces a hard floor that clamped the centre of gravity and multiplied body
 * rates by 0.6 every step. That was honest as a placeholder and useless as
 * physics — a quad hit the ground at 27 m/s in a recorded flight and simply
 * carried on, and half of that flight was spent inside half a metre of a
 * surface it could not touch.
 *
 * The model is penalty contact at four points, one under each arm. A point
 * below a surface gets a spring-damper push along the surface normal and
 * Coulomb friction across it. That is enough to rest, slide, tip, bounce and
 * tumble without any of those being written as special cases, which is the
 * reason to do it this way rather than with a clamp per situation.
 *
 * Obstacles are in NED, like the rest of the physics. The renderer converts at
 * its own boundary and the track defines both from the same numbers, so a gate
 * cannot be drawn in one place and collided with in another.
 */

import type { Vec3 } from './math.ts';

export interface Cylinder {
  kind: 'cylinder';
  north: number;
  east: number;
  radius: number;
  /** Metres above the ground. */
  height: number;
}

export interface Box {
  kind: 'box';
  minNorth: number;
  maxNorth: number;
  minEast: number;
  maxEast: number;
  /** Heights above the ground; min is the lower edge. */
  minUp: number;
  maxUp: number;
}

export type Obstacle = Cylinder | Box;

export interface ContactParams {
  /** Penalty stiffness, N/m. */
  stiffness: number;
  /** Penalty damping, N*s/m. */
  damping: number;
  /** Coulomb coefficient. */
  friction: number;
  /**
   * Normal closing speed above which the hit counts as a crash, m/s. Real
   * quads survive a gentle touch and shatter props on anything committed.
   */
  crashSpeed: number;
}

export function defaultContact(): ContactParams {
  return { stiffness: 6000, damping: 60, friction: 0.8, crashSpeed: 4.5 };
}

export interface ContactResult {
  /** Accumulated world-frame force, N. */
  force: Vec3;
  /** Accumulated body-frame moment, N*m. */
  moment: Vec3;
  touching: boolean;
  /** Worst normal closing speed seen this step, m/s. */
  impactSpeed: number;
  /** True if something other than the ground was hit. */
  hitObstacle: boolean;
}

/**
 * One contact point against one surface.
 *
 * `depth` is how far the point is inside the surface, `nx,ny,nz` the outward
 * normal in NED. Everything else is the same for the ground and for a gate
 * post, which is why they share this.
 */
function respond(
  out: ContactResult,
  p: ContactParams,
  depth: number,
  nN: number,
  nE: number,
  nD: number,
  velN: number,
  velE: number,
  velD: number,
  armN: number,
  armE: number,
  armD: number,
  q: { w: number; x: number; y: number; z: number },
): void {
  // Closing speed along the normal: negative means moving into the surface.
  const vn = velN * nN + velE * nE + velD * nD;
  let fn = p.stiffness * depth - p.damping * vn;
  if (fn < 0) fn = 0;
  if (fn === 0) return;

  if (-vn > out.impactSpeed) out.impactSpeed = -vn;
  out.touching = true;

  // Tangential velocity, and friction opposing it. Capped by Coulomb so the
  // quad slides rather than being welded down, and damped so a resting quad
  // does not buzz along the ground.
  const tN = velN - vn * nN;
  const tE = velE - vn * nE;
  const tD = velD - vn * nD;
  const tMag = Math.hypot(tN, tE, tD);
  let fN = fn * nN;
  let fE = fn * nE;
  let fD = fn * nD;
  if (tMag > 1e-6) {
    const ft = Math.min(p.friction * fn, tMag * p.damping);
    fN -= (tN / tMag) * ft;
    fE -= (tE / tMag) * ft;
    fD -= (tD / tMag) * ft;
  }

  out.force.x += fN;
  out.force.y += fE;
  out.force.z += fD;

  // Moment needs the force in the body frame, against the body-frame arm.
  const bx = -q.x;
  const by = -q.y;
  const bz = -q.z;
  const tx = 2 * (by * fD - bz * fE);
  const ty = 2 * (bz * fN - bx * fD);
  const tz = 2 * (bx * fE - by * fN);
  const fbN = fN + q.w * tx + (by * tz - bz * ty);
  const fbE = fE + q.w * ty + (bz * tx - bx * tz);
  const fbD = fD + q.w * tz + (bx * ty - by * tx);

  out.moment.x += armE * fbD - armD * fbE;
  out.moment.y += armD * fbN - armN * fbD;
  out.moment.z += armN * fbE - armE * fbN;
}

/**
 * Test one world-space point against the ground and every obstacle.
 *
 * @param world   point position in NED
 * @param vel     point velocity in NED
 * @param arm     the same point in the body frame, for the moment arm
 */
export function contactPoint(
  out: ContactResult,
  p: ContactParams,
  obstacles: readonly Obstacle[],
  world: Vec3,
  vel: Vec3,
  arm: Vec3,
  q: { w: number; x: number; y: number; z: number },
): void {
  // Ground: the plane down = 0, outward normal pointing up, which is -down.
  if (world.z > 0) {
    respond(out, p, world.z, 0, 0, -1, vel.x, vel.y, vel.z, arm.x, arm.y, arm.z, q);
  }

  for (const o of obstacles) {
    if (o.kind === 'cylinder') {
      const up = -world.z;
      if (up < 0 || up > o.height) continue;
      const dN = world.x - o.north;
      const dE = world.y - o.east;
      const dist = Math.hypot(dN, dE);
      if (dist >= o.radius) continue;
      const depth = o.radius - dist;
      // Degenerate on the axis: push north rather than divide by zero.
      const nN = dist > 1e-6 ? dN / dist : 1;
      const nE = dist > 1e-6 ? dE / dist : 0;
      respond(out, p, depth, nN, nE, 0, vel.x, vel.y, vel.z, arm.x, arm.y, arm.z, q);
      out.hitObstacle = true;
    } else {
      const up = -world.z;
      if (
        world.x < o.minNorth ||
        world.x > o.maxNorth ||
        world.y < o.minEast ||
        world.y > o.maxEast ||
        up < o.minUp ||
        up > o.maxUp
      ) {
        continue;
      }
      // Push out along whichever face is nearest.
      const cands: [number, number, number, number][] = [
        [world.x - o.minNorth, -1, 0, 0],
        [o.maxNorth - world.x, 1, 0, 0],
        [world.y - o.minEast, 0, -1, 0],
        [o.maxEast - world.y, 0, 1, 0],
        [up - o.minUp, 0, 0, 1],
        [o.maxUp - up, 0, 0, -1],
      ];
      let best = cands[0]!;
      for (const c of cands) if (c[0]! < best[0]!) best = c;
      // The last component is "up"; NED down is its negation.
      respond(
        out,
        p,
        best[0]!,
        best[1]!,
        best[2]!,
        -best[3]!,
        vel.x,
        vel.y,
        vel.z,
        arm.x,
        arm.y,
        arm.z,
        q,
      );
      out.hitObstacle = true;
    }
  }
}
