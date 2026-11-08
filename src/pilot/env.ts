/**
 * The boundary between the pilot and whatever it is flying.
 *
 * The pilot sees state and sends sticks; it never touches the rigid body, the
 * motors or the mass. That is the whole point of the interface: the same pilot
 * is meant to fly Velocidrone one day, and a pilot that reaches into FlightSim
 * would have learned a model it will not have there. A Velocidrone environment
 * replaces this file and nothing else.
 */

import { FlightSim, type StickInput } from '../flight/sim.ts';
import { kronos } from '../flight/airframe.ts';
import type { RateProfile } from '../flight/rates.ts';
import type { Obstacle } from '../flight/collision.ts';
import type { Course } from '../race/course.ts';
import { Race, type RaceResult } from '../race/race.ts';

/** What the pilot can observe. NED world, FRD body — the physics' frames. */
export interface Observation {
  t: number;
  pos: [number, number, number];
  vel: [number, number, number];
  q: { w: number; x: number; y: number; z: number };
  /** Body rates, FRD, rad/s. */
  omega: [number, number, number];
}

export function observation(): Observation {
  return { t: 0, pos: [0, 0, 0], vel: [0, 0, 0], q: { w: 1, x: 0, y: 0, z: 0 }, omega: [0, 0, 0] };
}

export interface PilotEnv {
  /** Back to the start line, on the ground, disarmed then armed. */
  reset(): void;
  observe(out: Observation): Observation;
  /** Hold these sticks for dt seconds. */
  advance(sticks: StickInput, dt: number): void;
  readonly crashed: boolean;
  readonly finished: boolean;
  /** Seconds since reset. */
  readonly time: number;
}

export interface FpvsimEnvOptions {
  rates: RateProfile;
  course: Course;
  obstacles: readonly Obstacle[];
  laps: number;
  /** Observation delay, s. Rehearses a slower state source than the sim's own. */
  latency?: number;
  /** Position noise, metres (1 sigma), and velocity noise, m/s. */
  posNoise?: number;
  velNoise?: number;
  /**
   * Scale the all-up mass, to rehearse a quad that is not the one the pilot
   * measured. The pilot never reads the mass, so this is a pure surprise.
   */
  massScale?: number;
  /** Called after every physics step, for recording. */
  onStep?: (sim: FlightSim, sticks: StickInput) => void;
}

/** The headless fpvsim, behind the interface. */
export class FpvsimEnv implements PilotEnv {
  readonly sim: FlightSim;
  readonly race: Race;
  private opts: FpvsimEnvOptions;
  private history: Observation[] = [];
  private seed = 1;

  constructor(opts: FpvsimEnvOptions) {
    this.opts = opts;
    const airframe = kronos();
    if (opts.massScale !== undefined) airframe.mass *= opts.massScale;
    this.sim = new FlightSim({ airframe });
    for (let i = 0; i < 3; i++) {
      this.sim.rates.rcRate[i] = opts.rates.rcRate[i]!;
      this.sim.rates.rate[i] = opts.rates.rate[i]!;
      this.sim.rates.expo[i] = opts.rates.expo[i]!;
    }
    this.sim.rates.type = opts.rates.type;
    this.sim.obstacles = opts.obstacles;
    this.race = new Race(opts.course);
    this.reset();
  }

  reset(): void {
    const s = this.opts.course.start;
    this.sim.reset(s.yawDeg);
    this.sim.pos.x = s.north;
    this.sim.pos.y = s.east;
    this.sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    this.race.reset();
    this.race.laps = this.opts.laps;
    this.race.start(0);
    this.race.setDt(this.sim.dt);
    this.race.step(this.sim.pos.x, this.sim.pos.y, -this.sim.pos.z, this.sim.dt);
    this.history.length = 0;
    this.seed = 1;
  }

  get crashed(): boolean {
    return this.sim.crashed;
  }

  get finished(): boolean {
    return this.race.state === 'finished';
  }

  get time(): number {
    return this.sim.time;
  }

  result(): RaceResult {
    return this.race.result();
  }

  advance(sticks: StickInput, dt: number): void {
    const steps = Math.max(1, Math.round(dt / this.sim.dt));
    for (let i = 0; i < steps; i++) {
      this.sim.step(sticks);
      this.race.setDt(this.sim.dt);
      this.race.step(this.sim.pos.x, this.sim.pos.y, -this.sim.pos.z, this.sim.dt);
      this.opts.onStep?.(this.sim, sticks);
    }
    const latency = this.opts.latency ?? 0;
    if (latency > 0) {
      this.history.push(this.snapshot(observation()));
      while (this.history.length > 1 && this.history[1]!.t <= this.sim.time - latency) this.history.shift();
    }
  }

  observe(out: Observation): Observation {
    const latency = this.opts.latency ?? 0;
    if (latency > 0 && this.history.length > 0) {
      const h = this.history[0]!;
      out.t = this.sim.time; // the pilot knows what time it is, not what time the state is from
      out.pos[0] = h.pos[0]; out.pos[1] = h.pos[1]; out.pos[2] = h.pos[2];
      out.vel[0] = h.vel[0]; out.vel[1] = h.vel[1]; out.vel[2] = h.vel[2];
      out.q.w = h.q.w; out.q.x = h.q.x; out.q.y = h.q.y; out.q.z = h.q.z;
      out.omega[0] = h.omega[0]; out.omega[1] = h.omega[1]; out.omega[2] = h.omega[2];
    } else {
      this.snapshot(out);
    }
    const pn = this.opts.posNoise ?? 0;
    const vn = this.opts.velNoise ?? 0;
    if (pn > 0 || vn > 0) {
      for (let i = 0; i < 3; i++) {
        out.pos[i] = out.pos[i]! + pn * this.gauss();
        out.vel[i] = out.vel[i]! + vn * this.gauss();
      }
    }
    return out;
  }

  private snapshot(out: Observation): Observation {
    const s = this.sim;
    out.t = s.time;
    out.pos[0] = s.pos.x; out.pos[1] = s.pos.y; out.pos[2] = s.pos.z;
    out.vel[0] = s.vel.x; out.vel[1] = s.vel.y; out.vel[2] = s.vel.z;
    out.q.w = s.q.w; out.q.x = s.q.x; out.q.y = s.q.y; out.q.z = s.q.z;
    out.omega[0] = s.omega.x; out.omega[1] = s.omega.y; out.omega[2] = s.omega.z;
    return out;
  }

  /** Deterministic, so a noisy run is reproducible. */
  private gauss(): number {
    const u = () => {
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      return (this.seed + 1) / 0x80000001;
    };
    return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  }
}
