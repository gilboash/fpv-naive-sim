/**
 * Blade-element rotor with momentum-theory inflow.
 *
 * A thrust constant (T = k*rpm^2) would be a page shorter and would fly, but it
 * cannot produce the behaviours a pilot actually trains against: thrust falling
 * away in a fast descent, translational lift as the quad accelerates out of its
 * own downwash, or the drag the discs themselves contribute at speed. Those are
 * the moments where a real quad surprises you, so they have to be in the model.
 *
 * The blade is cut into elements; each gets its inflow from the closed-form
 * blade-element/momentum solution with a Prandtl tip loss, and its forces from
 * full trigonometry rather than the small-angle form — the small-angle version
 * quietly stops being true exactly where this gets interesting, at high inflow
 * and low rotor speed.
 *
 * Known limits, stated rather than hidden:
 *   - No azimuthal integration, so no flapping and no roll-off in fast forward
 *     flight. In-plane flow is handled by a Glauert factor and an H-force.
 *   - Vortex ring state is not modelled. The momentum relation is wrong in a
 *     steep powered descent and this model will be optimistic there.
 */

export interface PropSpec {
  /** Tip radius, m. */
  radius: number;
  /** Root cutout, m. Inboard of this the blade is structure, not aerofoil. */
  hubRadius: number;
  blades: number;
  /** Mean chord, m. */
  chord: number;
  /** Geometric pitch, m of advance per revolution. */
  pitch: number;
  /** Lift-curve slope, per radian. */
  clAlpha: number;
  /** Profile drag at zero incidence. */
  cd0: number;
  /** Induced-drag factor on the aerofoil polar. */
  cdAlpha: number;
  /** Stall onset, radians. */
  stallAngle: number;
  /** Number of blade elements. */
  elements: number;
  /** In-plane drag coefficient of the spinning disc. */
  hForce: number;
}

/** A 5.1x4.3 three-blade, the standard 5" racing prop. */
export function defaultProp(): PropSpec {
  return {
    radius: 0.0648,
    hubRadius: 0.011,
    blades: 3,
    chord: 0.0125,
    pitch: 0.109,
    clAlpha: 5.7,
    cd0: 0.02,
    cdAlpha: 1.2,
    stallAngle: 0.24,
    elements: 10,
    hForce: 0.008,
  };
}

export const RHO_SEA_LEVEL = 1.225;

export interface RotorOutput {
  /** Axial thrust, N, positive along the rotor axis (up, out of the disc). */
  thrust: number;
  /** Shaft torque required to hold this state, N·m. Always >= 0. */
  torque: number;
  /** In-plane drag force, N, opposing the in-plane velocity. */
  hDrag: number;
}

/** Precomputed per-element geometry, so the hot path does no trigonometry setup. */
interface Element {
  r: number;
  dr: number;
  rBar: number;
  theta: number;
  sigma: number;
}

export class Rotor {
  private els: Element[] = [];
  readonly out: RotorOutput = { thrust: 0, torque: 0, hDrag: 0 };

  spec: PropSpec;
  rho: number;

  constructor(spec: PropSpec, rho = RHO_SEA_LEVEL) {
    this.spec = spec;
    this.rho = rho;
    this.rebuild();
  }

  rebuild(): void {
    const s = this.spec;
    this.els = [];
    const span = s.radius - s.hubRadius;
    const dr = span / s.elements;
    for (let i = 0; i < s.elements; i++) {
      const r = s.hubRadius + dr * (i + 0.5);
      // Geometric twist follows constant-pitch helix, which is what a moulded
      // prop actually is: theta = atan(pitch / (2*pi*r)).
      const theta = Math.atan2(s.pitch, 2 * Math.PI * r);
      this.els.push({
        r,
        dr,
        rBar: r / s.radius,
        theta,
        sigma: (s.blades * s.chord) / (Math.PI * s.radius),
      });
    }
  }

  /**
   * @param omega    rotor speed, rad/s, >= 0
   * @param vAxial   velocity along the rotor axis, m/s. Positive = climbing,
   *                 i.e. air arriving from the direction the rotor pushes into.
   * @param vInPlane in-plane speed magnitude, m/s
   */
  solve(omega: number, vAxial: number, vInPlane: number): RotorOutput {
    const out = this.out;
    out.thrust = 0;
    out.torque = 0;
    out.hDrag = 0;

    const s = this.spec;
    if (!(omega > 1)) return out;

    const R = s.radius;
    const tipSpeed = omega * R;
    const lambdaC = vAxial / tipSpeed;

    // Glauert forward-flight factor. As the rotor translates it meets undisturbed
    // air rather than its own wake, so less induced velocity is needed for the
    // same thrust — this is translational lift, and on a quad you feel it as the
    // machine floating up as it accelerates.
    const mu = vInPlane / tipSpeed;
    const glauert = 1 / Math.sqrt(1 + 4 * mu * mu);

    for (const el of this.els) {
      // Two passes: the Prandtl tip loss needs an inflow to be computed from,
      // and the inflow needs the tip loss. One correction is plenty.
      let F = 1;
      let lambda = 0;
      for (let pass = 0; pass < 2; pass++) {
        const k = (el.sigma * s.clAlpha) / (16 * F);
        const term = k - lambdaC / 2;
        const disc = term * term + (el.sigma * s.clAlpha * el.theta * el.rBar) / (8 * F);
        lambda = disc > 0 ? Math.sqrt(disc) - term : 0;
        lambda *= glauert;
        if (pass === 0) {
          const f = (s.blades / 2) * ((1 - el.rBar) / Math.max(1e-4, Math.abs(lambda)));
          // Clamped: at the very tip f -> 0 and the exact expression divides by
          // a vanishing inflow, which is a NaN waiting for the first hover.
          F = Math.max(0.15, (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-f))));
        }
      }

      const uP = lambda * tipSpeed;
      const uT = omega * el.r;
      const w2 = uT * uT + uP * uP;
      if (w2 < 1e-9) continue;

      const phi = Math.atan2(uP, uT);
      let alpha = el.theta - phi;
      // Past stall the aerofoil does not keep making lift. Flat-plate behaviour
      // beyond the break is crude but it is bounded, and an unbounded Cl here
      // shows up as a quad that accelerates forever in a hard descent.
      if (alpha > s.stallAngle) alpha = s.stallAngle - (alpha - s.stallAngle) * 0.5;
      else if (alpha < -s.stallAngle) alpha = -s.stallAngle - (alpha + s.stallAngle) * 0.5;

      const cl = s.clAlpha * alpha;
      const cd = s.cd0 + s.cdAlpha * alpha * alpha;

      const q = 0.5 * this.rho * w2 * s.chord * el.dr;
      const dL = q * cl;
      const dD = q * cd;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      out.thrust += s.blades * (dL * cosPhi - dD * sinPhi);
      out.torque += s.blades * (dL * sinPhi + dD * cosPhi) * el.r;
    }

    // Torque is what the shaft must supply. It can only be positive: a prop that
    // would drive its motor is a windmill, and these never are.
    if (out.torque < 0) out.torque = 0;

    // In-plane drag on the disc, roughly linear in advance ratio.
    out.hDrag = s.hForce * this.rho * Math.PI * R * R * tipSpeed * vInPlane;

    return out;
  }
}
