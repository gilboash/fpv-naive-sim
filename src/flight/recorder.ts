/**
 * Flight recorder for the model.
 *
 * The field set deliberately mirrors what Betaflight's Blackbox logs, because
 * the point of recording the model is to lay it beside a log from a real quad.
 * Anything logged here that Blackbox also logs uses the same name; the extras
 * (per-rotor thrust, velocity, altitude) are things only a simulator can know
 * and are what make a disagreement diagnosable rather than just visible.
 *
 * Units are the model's own — deg/s, newtons, metres, volts, amps — and are
 * declared in the metadata rather than left to be guessed. Blackbox's raw
 * units get converted at the boundary when a real log is read, so the native
 * side of the comparison never has to be un-mangled.
 *
 * The hot path allocates nothing: columns are one preallocated Float32Array
 * and `sample()` writes by index. It is called from inside the 1 kHz tick.
 */

import type { FlightSim } from './sim.ts';

export const COLUMNS = [
  'time',
  'rcThrottle',
  'rcRoll',
  'rcPitch',
  'rcYaw',
  'setpoint[0]',
  'setpoint[1]',
  'setpoint[2]',
  'gyroADC[0]',
  'gyroADC[1]',
  'gyroADC[2]',
  'axisP[0]',
  'axisP[1]',
  'axisP[2]',
  'axisI[0]',
  'axisI[1]',
  'axisI[2]',
  'axisD[0]',
  'axisD[1]',
  'axisD[2]',
  'axisF[0]',
  'axisF[1]',
  'axisF[2]',
  'motor[0]',
  'motor[1]',
  'motor[2]',
  'motor[3]',
  'rpm[0]',
  'rpm[1]',
  'rpm[2]',
  'rpm[3]',
  'thrust[0]',
  'thrust[1]',
  'thrust[2]',
  'thrust[3]',
  'vbat',
  'amperage',
  'roll',
  'pitch',
  'yaw',
  'velN',
  'velE',
  'velD',
  'altitude',
  'accel[0]',
  'accel[1]',
  'accel[2]',
  // Flags, 0 or 1. `armed` is here because a replay cannot reproduce a flight
  // without it and the first recording had to have it inferred from whether the
  // motors were turning. Betaflight carries the same information as flight-mode
  // flags rather than a column, and the reader converts.
  'armed',
  'onGround',
  'saturated',
] as const;

export const UNITS: Record<string, string> = {
  time: 's',
  rcThrottle: '0..1',
  rcRoll: '-1..1',
  rcPitch: '-1..1',
  rcYaw: '-1..1',
  'setpoint[]': 'deg/s',
  'gyroADC[]': 'deg/s (filtered, gyro-clipped at 2000)',
  'axisP[] axisI[] axisD[] axisF[]': 'betaflight pidSum units, /1000 to reach the mixer',
  'motor[]': '0..1 ESC command after idle mapping',
  'rpm[]': 'rpm',
  'thrust[]': 'N',
  vbat: 'V',
  amperage: 'A',
  'roll pitch yaw': 'deg',
  'velN velE velD': 'm/s, world NED',
  altitude: 'm above ground',
  'accel[]': 'g, body frame, specific force as an accelerometer reads it',
  'armed onGround saturated': '0 or 1',
};

const NCOL = COLUMNS.length;

export interface RecordingMeta {
  startedAt: string;
  durationS: number;
  sampleHz: number;
  samples: number;
  decimation: number;
  airframe: string;
  mass: number;
  rates: unknown;
  pids: unknown;
  columns: readonly string[];
  units: Record<string, string>;
}

export class FlightRecorder {
  private data: Float32Array;
  private cap: number;
  private n = 0;
  private skip = 0;

  recording = false;
  decimation = 1;
  startedAt = '';

  constructor(maxSamples: number) {
    this.cap = maxSamples;
    this.data = new Float32Array(maxSamples * NCOL);
  }

  /** @param decimation 1 = every step (1 kHz), 2 = 500 Hz, and so on. */
  start(decimation = 1): void {
    this.n = 0;
    this.skip = 0;
    this.decimation = Math.max(1, Math.round(decimation));
    this.startedAt = new Date().toISOString();
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  get sampleCount(): number {
    return this.n;
  }

  get full(): boolean {
    return this.n >= this.cap;
  }

  /** Called from the tick, immediately after the physics step. */
  sample(sim: FlightSim): void {
    if (!this.recording) return;
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    this.skip = this.decimation - 1;
    if (this.n >= this.cap) {
      this.recording = false;
      return;
    }

    const d = this.data;
    let k = this.n * NCOL;
    const t = sim.telemetry;
    const a = sim.controller.axes;

    d[k++] = sim.time;
    d[k++] = t.rcThrottle;
    d[k++] = t.rcRoll;
    d[k++] = t.rcPitch;
    d[k++] = t.rcYaw;
    d[k++] = t.setpoint.x;
    d[k++] = t.setpoint.y;
    d[k++] = t.setpoint.z;
    d[k++] = t.gyro.x;
    d[k++] = t.gyro.y;
    d[k++] = t.gyro.z;
    for (let i = 0; i < 3; i++) d[k++] = a[i]!.pOut;
    for (let i = 0; i < 3; i++) d[k++] = a[i]!.iOut;
    for (let i = 0; i < 3; i++) d[k++] = a[i]!.dOut;
    for (let i = 0; i < 3; i++) d[k++] = a[i]!.fOut;
    for (let i = 0; i < 4; i++) d[k++] = t.motorOutputs[i]!;
    for (let i = 0; i < 4; i++) d[k++] = t.motorRpm[i]!;
    for (let i = 0; i < 4; i++) d[k++] = t.motorThrust[i]!;
    d[k++] = t.batteryV;
    d[k++] = t.batteryA;
    d[k++] = t.attitude.roll;
    d[k++] = t.attitude.pitch;
    d[k++] = t.attitude.yaw;
    d[k++] = sim.vel.x;
    d[k++] = sim.vel.y;
    d[k++] = sim.vel.z;
    d[k++] = t.altitude;
    d[k++] = t.accel.x;
    d[k++] = t.accel.y;
    d[k++] = t.accel.z;
    d[k++] = t.armed ? 1 : 0;
    d[k++] = t.onGround ? 1 : 0;
    d[k++] = t.mixerSaturated ? 1 : 0;

    this.n++;
  }

  meta(sim: FlightSim): RecordingMeta {
    const hz = 1000 / (sim.dt * 1000 * this.decimation);
    return {
      startedAt: this.startedAt,
      durationS: this.n > 0 ? this.n / hz : 0,
      sampleHz: hz,
      samples: this.n,
      decimation: this.decimation,
      airframe: sim.airframe.name,
      mass: sim.airframe.mass,
      rates: sim.rates,
      pids: sim.controller.profile,
      columns: COLUMNS,
      units: UNITS,
    };
  }

  /** Rounded to 4 decimals: past that it is float32 noise, and it doubles the file. */
  private round(v: number): number {
    return Math.round(v * 1e4) / 1e4;
  }

  toJSON(sim: FlightSim): string {
    const rows: number[][] = new Array(this.n);
    for (let r = 0; r < this.n; r++) {
      const row = new Array<number>(NCOL);
      const base = r * NCOL;
      for (let c = 0; c < NCOL; c++) row[c] = this.round(this.data[base + c]!);
      rows[r] = row;
    }
    return JSON.stringify({ meta: this.meta(sim), rows });
  }

  toCSV(): string {
    const parts: string[] = [COLUMNS.join(',')];
    const row = new Array<string>(NCOL);
    for (let r = 0; r < this.n; r++) {
      const base = r * NCOL;
      for (let c = 0; c < NCOL; c++) row[c] = String(this.round(this.data[base + c]!));
      parts.push(row.join(','));
    }
    return parts.join('\n');
  }
}
