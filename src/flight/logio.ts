import { decodeBlackbox } from './blackbox.ts';

/**
 * Reading flight logs, ours and Betaflight's, into one shape.
 *
 * The comparison this exists for is only as good as the unit conversion, and
 * Betaflight's logged units depend on firmware version, on how blackbox_decode
 * was invoked, and on board configuration. None of that is knowable from the
 * numbers alone. So this module does two things rather than one: it converts,
 * and it reports every assumption it made, so a comparison that comes out wrong
 * can be diagnosed instead of merely disbelieved.
 *
 * Both the binary .BBL and a `blackbox_decode` CSV are accepted. The binary
 * path is preferred: the header travels with it, so motor range, vbat scale
 * and motor poles are read rather than guessed, and the tune comes along for
 * free.
 */

export interface LogMeta {
  source: string;
  format: 'sim-json' | 'sim-csv' | 'blackbox-csv';
  samples: number;
  sampleHz: number;
  durationS: number;
  /** Everything the reader had to guess, in plain words. */
  assumptions: string[];
  /** Present for our own recordings; absent for Blackbox. */
  rates?: unknown;
  pids?: unknown;
  mass?: number | undefined;
  airframe?: string | undefined;
}

/**
 * Canonical units, matching the model: seconds, deg/s, 0..1 sticks and motors,
 * rpm, volts, amps.
 */
export interface FlightLog {
  meta: LogMeta;
  /** Canonical column name to values. Missing fields are simply absent. */
  series: Map<string, Float64Array>;
  has(name: string): boolean;
  get(name: string): Float64Array | undefined;
  require(name: string): Float64Array;
}

function makeLog(meta: LogMeta, series: Map<string, Float64Array>): FlightLog {
  return {
    meta,
    series,
    has: (n) => series.has(n),
    get: (n) => series.get(n),
    require: (n) => {
      const v = series.get(n);
      if (!v) throw new Error(`log has no field "${n}" (present: ${[...series.keys()].join(', ')})`);
      return v;
    },
  };
}

function inferHz(time: Float64Array): number {
  if (time.length < 2) return 1000;
  // Median step, not mean: a single gap should not move it.
  const steps: number[] = [];
  const stride = Math.max(1, Math.floor(time.length / 500));
  for (let i = stride; i < time.length; i += stride) {
    const dt = (time[i]! - time[i - stride]!) / stride;
    if (dt > 0) steps.push(dt);
  }
  if (steps.length === 0) return 1000;
  steps.sort((a, b) => a - b);
  return 1 / steps[Math.floor(steps.length / 2)]!;
}

// ------------------------------------------------------------- our own format

export function parseSimJSON(text: string, source: string): FlightLog {
  const doc = JSON.parse(text) as {
    meta: { columns: string[]; sampleHz: number; samples: number; durationS: number; rates?: unknown; pids?: unknown; mass?: number; airframe?: string };
    rows: number[][];
  };
  const cols = doc.meta.columns;
  const series = new Map<string, Float64Array>();
  for (let c = 0; c < cols.length; c++) {
    const arr = new Float64Array(doc.rows.length);
    for (let r = 0; r < doc.rows.length; r++) arr[r] = doc.rows[r]![c]!;
    series.set(cols[c]!, arr);
  }
  return makeLog(
    {
      source,
      format: 'sim-json',
      samples: doc.rows.length,
      sampleHz: doc.meta.sampleHz,
      durationS: doc.meta.durationS,
      assumptions: ['native format — no unit conversion applied'],
      rates: doc.meta.rates,
      pids: doc.meta.pids,
      mass: doc.meta.mass,
      airframe: doc.meta.airframe,
    },
    series,
  );
}

function parseCSVRaw(text: string): { header: string[]; cols: Float64Array[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.startsWith('#'));
  const header = lines[0]!.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const n = lines.length - 1;
  const cols = header.map(() => new Float64Array(n));
  for (let r = 0; r < n; r++) {
    const cells = lines[r + 1]!.split(',');
    for (let c = 0; c < header.length; c++) cols[c]![r] = Number(cells[c]);
  }
  return { header, cols };
}

export function parseSimCSV(text: string, source: string): FlightLog {
  const { header, cols } = parseCSVRaw(text);
  const series = new Map<string, Float64Array>();
  header.forEach((h, i) => series.set(h, cols[i]!));
  const time = series.get('time') ?? new Float64Array(0);
  const hz = inferHz(time);
  return makeLog(
    {
      source,
      format: 'sim-csv',
      samples: time.length,
      sampleHz: hz,
      durationS: time.length ? time[time.length - 1]! - time[0]! : 0,
      assumptions: ['native format — no unit conversion applied'],
    },
    series,
  );
}

// -------------------------------------------------------------- Betaflight

export interface BlackboxOptions {
  /** Motor poles, for eRPM to rpm. 14 is the usual 2207. */
  motorPoles?: number | undefined;
  /** Force the gyro unit instead of inferring it. */
  gyroUnit?: 'degps' | 'raw' | undefined;
  /** Gyro full-scale in deg/s, used only when the unit is raw. */
  gyroScaleDps?: number | undefined;
}

const BB_ALIASES: Record<string, string> = {
  'time (us)': 'time',
  time: 'time',
  'gyroADC[0]': 'gyroADC[0]',
  'gyroADC[1]': 'gyroADC[1]',
  'gyroADC[2]': 'gyroADC[2]',
  'setpoint[0]': 'setpoint[0]',
  'setpoint[1]': 'setpoint[1]',
  'setpoint[2]': 'setpoint[2]',
  'axisP[0]': 'axisP[0]',
  'axisP[1]': 'axisP[1]',
  'axisP[2]': 'axisP[2]',
  'axisI[0]': 'axisI[0]',
  'axisI[1]': 'axisI[1]',
  'axisI[2]': 'axisI[2]',
  'axisD[0]': 'axisD[0]',
  'axisD[1]': 'axisD[1]',
  'axisD[2]': 'axisD[2]',
  'axisF[0]': 'axisF[0]',
  'axisF[1]': 'axisF[1]',
  'axisF[2]': 'axisF[2]',
};

/**
 * Read a CSV produced by `blackbox_decode`.
 *
 * Every scaling below is a documented guess, recorded in `meta.assumptions`.
 * The ones that bite are the gyro unit and the motor range, so both are
 * inferred from the data and can be overridden.
 */
export function parseBlackboxCSV(
  text: string,
  source: string,
  opts: BlackboxOptions = {},
): FlightLog {
  const { header, cols } = parseCSVRaw(text);
  const byName = new Map<string, Float64Array>();
  header.forEach((h, i) => byName.set(h.trim(), cols[i]!));
  const assumptions: string[] = [];
  const series = new Map<string, Float64Array>();

  const pick = (...names: string[]): Float64Array | undefined => {
    for (const n of names) {
      const v = byName.get(n);
      if (v) return v;
    }
    return undefined;
  };

  // ---- time: Blackbox logs microseconds
  const rawTime = pick('time (us)', 'time');
  if (!rawTime) throw new Error('no time column — is this a blackbox_decode CSV?');
  const time = new Float64Array(rawTime.length);
  const t0 = rawTime[0]!;
  for (let i = 0; i < rawTime.length; i++) time[i] = (rawTime[i]! - t0) / 1e6;
  series.set('time', time);
  assumptions.push('time column is microseconds, rebased to zero');

  // ---- gyro
  const gyroUnit =
    opts.gyroUnit ??
    (() => {
      const g = pick('gyroADC[0]');
      if (!g) return 'degps';
      let peak = 0;
      for (const v of g) peak = Math.max(peak, Math.abs(v));
      // A quad does not exceed 2000 deg/s for long; raw counts run to 32767.
      return peak > 4000 ? 'raw' : 'degps';
    })();
  const gyroScale =
    gyroUnit === 'raw' ? (opts.gyroScaleDps ?? 2000) / 32768 : 1;
  assumptions.push(
    gyroUnit === 'raw'
      ? `gyro looked like raw counts; scaled by ${(opts.gyroScaleDps ?? 2000)} deg/s full scale. Override with --gyro-unit degps if wrong.`
      : 'gyro already in deg/s (peak magnitude was plausible for a quad)',
  );

  for (let ax = 0; ax < 3; ax++) {
    const g = pick(`gyroADC[${ax}]`);
    if (!g) continue;
    const out = new Float64Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = g[i]! * gyroScale;
    series.set(`gyroADC[${ax}]`, out);
  }

  // ---- sticks: rcCommand roll/pitch/yaw are -500..500, throttle 1000..2000
  const names = ['rcRoll', 'rcPitch', 'rcYaw'];
  for (let ax = 0; ax < 3; ax++) {
    const r = pick(`rcCommand[${ax}]`);
    if (!r) continue;
    const out = new Float64Array(r.length);
    for (let i = 0; i < r.length; i++) out[i] = Math.max(-1, Math.min(1, r[i]! / 500));
    series.set(names[ax]!, out);
  }
  const thr = pick('rcCommand[3]');
  if (thr) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of thr) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    // Betaflight logs throttle as 1000..2000; some setups log 0..1000.
    const base = lo >= 900 ? 1000 : 0;
    const span = 1000;
    const out = new Float64Array(thr.length);
    for (let i = 0; i < thr.length; i++) out[i] = Math.max(0, Math.min(1, (thr[i]! - base) / span));
    series.set('rcThrottle', out);
    assumptions.push(`throttle mapped from ${base}..${base + span} (observed ${lo.toFixed(0)}..${hi.toFixed(0)})`);
  }

  // ---- motors: DShot logs 0..2047, PWM logs 1000..2000
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (let m = 0; m < 4; m++) {
      const v = pick(`motor[${m}]`);
      if (!v) continue;
      for (const x of v) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    if (Number.isFinite(lo)) {
      const pwm = lo >= 900 && hi <= 2100;
      const base = pwm ? 1000 : 0;
      const span = pwm ? 1000 : 2047;
      for (let m = 0; m < 4; m++) {
        const v = pick(`motor[${m}]`);
        if (!v) continue;
        const out = new Float64Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = Math.max(0, Math.min(1, (v[i]! - base) / span));
        series.set(`motor[${m}]`, out);
      }
      assumptions.push(
        `motor outputs treated as ${pwm ? 'PWM 1000..2000' : 'DShot 0..2047'} (observed ${lo.toFixed(0)}..${hi.toFixed(0)})`,
      );
    }
  }

  // ---- eRPM to rpm
  {
    const poles = opts.motorPoles ?? 14;
    let found = false;
    for (let m = 0; m < 4; m++) {
      const v = pick(`eRPM[${m}]`, `debug[${m}]`);
      if (!v) continue;
      found = true;
      const out = new Float64Array(v.length);
      // Blackbox logs eRPM in units of 100 erpm; mechanical rpm = erpm / (poles/2).
      for (let i = 0; i < v.length; i++) out[i] = (v[i]! * 100) / (poles / 2);
      series.set(`rpm[${m}]`, out);
    }
    if (found) {
      assumptions.push(
        `eRPM converted with ${poles} motor poles; wrong poles scale RPM linearly. Override with --motor-poles.`,
      );
    } else {
      assumptions.push('no eRPM in the log — motor and rotor models cannot be separated');
    }
  }

  // ---- battery
  const vb = pick('vbatLatest (V)', 'vbatLatest');
  if (vb) {
    let peak = 0;
    for (const v of vb) peak = Math.max(peak, v);
    const scale = peak > 100 ? 0.01 : peak > 60 ? 0.1 : 1;
    const out = new Float64Array(vb.length);
    for (let i = 0; i < vb.length; i++) out[i] = vb[i]! * scale;
    series.set('vbat', out);
    assumptions.push(`vbat scaled by ${scale} (peak raw ${peak.toFixed(0)})`);
  }
  const amp = pick('amperageLatest (A)', 'amperageLatest');
  if (amp) {
    let peak = 0;
    for (const v of amp) peak = Math.max(peak, v);
    const scale = peak > 1000 ? 0.01 : 1;
    const out = new Float64Array(amp.length);
    for (let i = 0; i < amp.length; i++) out[i] = amp[i]! * scale;
    series.set('amperage', out);
    assumptions.push(`amperage scaled by ${scale} (peak raw ${peak.toFixed(0)})`);
  }

  // ---- pass-through fields that need no conversion
  for (const [bb, canon] of Object.entries(BB_ALIASES)) {
    if (canon === 'time' || canon.startsWith('gyroADC')) continue;
    const v = byName.get(bb);
    if (v && !series.has(canon)) series.set(canon, v);
  }

  const hz = inferHz(time);
  return makeLog(
    {
      source,
      format: 'blackbox-csv',
      samples: time.length,
      sampleHz: hz,
      durationS: time.length ? time[time.length - 1]! : 0,
      assumptions,
    },
    series,
  );
}

// ------------------------------------------------------- Betaflight binary

/**
 * Read a .BBL directly, no external decoder.
 *
 * Scaling here is taken from the log's own header wherever the header knows
 * it — motor range, vbat scale, motor poles — rather than inferred from the
 * numbers, which is the one advantage the binary format has over a decoded CSV.
 * Where the header does not say, the assumption is recorded as usual.
 */
export function parseBlackboxBinary(
  buf: Uint8Array,
  source: string,
  session: number,
  opts: BlackboxOptions = {},
): FlightLog {
  const dec = decodeBlackbox(buf, session);
  const H = dec.header.raw;
  const assumptions: string[] = [];
  const series = new Map<string, Float64Array>();
  const raw = (n: string): Float64Array | undefined => {
    const i = dec.fieldNames.indexOf(n);
    return i >= 0 ? dec.columns[i] : undefined;
  };
  const map = (from: Float64Array, f: (v: number) => number): Float64Array => {
    const out = new Float64Array(from.length);
    for (let i = 0; i < from.length; i++) out[i] = f(from[i]!);
    return out;
  };

  const time = raw('time');
  if (!time) throw new Error('decoded log has no time field');
  const t0 = time[0]!;
  series.set('time', map(time, (v) => (v - t0) / 1e6));

  // Gyro is already deg/s in the frame data: on these logs the peak gyro tracks
  // the peak setpoint, which it could not do in any other unit.
  //
  // Pitch is negated. Betaflight's QUADX mixer gives the REAR motors a pitch
  // coefficient of +1, so a positive pitch command raises the rear and drops the
  // nose: Betaflight's pitch is positive nose-DOWN, where this model's is
  // positive nose-up throughout.
  //
  // Confirmed from the logs rather than from the source, because a PID in the
  // loop makes the motor *commands* an unreliable witness: correlating the
  // command differential against pitch acceleration says one thing and the
  // eRPM-derived thrust differential says the opposite. Rotor speed to thrust to
  // torque has no controller in it, so it is the chain to trust, and it gives
  // r = -0.50 against Betaflight's pitch — a clean inversion, at zero lag,
  // while roll on the same flight gives +0.49.
  const PITCH_IS_NOSE_DOWN = -1;
  for (let ax = 0; ax < 3; ax++) {
    const flip = ax === 1 ? PITCH_IS_NOSE_DOWN : 1;
    const g = raw(`gyroADC[${ax}]`);
    if (g) series.set(`gyroADC[${ax}]`, flip === 1 ? g : map(g, (v) => v * flip));
    const sp = raw(`setpoint[${ax}]`);
    if (sp) series.set(`setpoint[${ax}]`, flip === 1 ? sp : map(sp, (v) => v * flip));
    for (const term of ['P', 'I', 'D', 'F']) {
      const v = raw(`axis${term}[${ax}]`);
      if (v) series.set(`axis${term}[${ax}]`, v);
    }
  }
  assumptions.push('gyroADC and setpoint taken as deg/s (peak gyro tracks peak setpoint, confirming it)');
  assumptions.push('pitch negated: Betaflight logs pitch positive nose-down, this model uses nose-up');

  const rcNames = ['rcRoll', 'rcPitch', 'rcYaw'];
  for (let ax = 0; ax < 3; ax++) {
    const r = raw(`rcCommand[${ax}]`);
    // Pitch stick negated for the same reason as the gyro above, so that
    // replaying the logged stick produces the logged rotation.
    const flip = ax === 1 ? PITCH_IS_NOSE_DOWN : 1;
    if (r) series.set(rcNames[ax]!, map(r, (v) => Math.max(-1, Math.min(1, (v * flip) / 500))));
  }
  const thr = raw('rcCommand[3]');
  if (thr) {
    series.set('rcThrottle', map(thr, (v) => Math.max(0, Math.min(1, (v - 1000) / 1000))));
    assumptions.push('throttle mapped from rcCommand[3] over 1000..2000');
  }

  // Motor range comes from the header rather than from the observed values.
  const motorOutput = (H.get('motorOutput') ?? '0,2047').split(',').map(Number);
  const mLo = motorOutput[0] ?? 0;
  const mHi = motorOutput[1] ?? 2047;
  let anyMotor = false;
  for (let m = 0; m < 4; m++) {
    const v = raw(`motor[${m}]`);
    if (!v) continue;
    anyMotor = true;
    series.set(`motor[${m}]`, map(v, (x) => Math.max(0, Math.min(1, (x - mLo) / (mHi - mLo)))));
  }
  if (anyMotor) assumptions.push(`motor outputs normalised over the header's range ${mLo}..${mHi}`);

  const poles = opts.motorPoles ?? Number(H.get('motor_poles') ?? 14);
  let anyRpm = false;
  for (let m = 0; m < 4; m++) {
    const v = raw(`eRPM[${m}]`);
    if (!v) continue;
    anyRpm = true;
    series.set(`rpm[${m}]`, map(v, (x) => (x * 100) / (poles / 2)));
  }
  assumptions.push(
    anyRpm
      ? `eRPM converted with ${poles} motor poles, from the header`
      : 'no eRPM in this log — the motor and rotor models cannot be separated',
  );

  const vb = raw('vbatLatest');
  if (vb) {
    series.set('vbat', map(vb, (v) => v * 0.01));
    assumptions.push('vbatLatest scaled by 0.01 to volts');
  }
  const amp = raw('amperageLatest');
  if (amp) {
    series.set('amperage', map(amp, (v) => v * 0.01));
    assumptions.push('amperageLatest scaled by 0.01 to amps — verify against a known hover draw');
  }

  if (dec.desyncs > 0) assumptions.push(`decoder lost sync ${dec.desyncs} times`);

  const timeS = series.get('time')!;
  const duration = timeS.length ? timeS[timeS.length - 1]! : 0;

  // The tune travels with the log, so the model can be run on the real gains
  // rather than on defaults.
  const list = (k: string): number[] => (H.get(k) ?? '').split(',').map(Number);
  /**
   * Betaflight's filter cutoffs come in pairs: a static value, and a dynamic
   * range used when the static one is zero. Midpoint of the range is the
   * honest single number to give a model that has no dynamic filter.
   */
  const dynOrStatic = (prefix: string, fallback: number): number => {
    const stat = Number(H.get(`${prefix}_static_hz`) ?? 0);
    if (stat > 0) return stat;
    const dyn = list(`${prefix}_dyn_hz`);
    if (dyn.length === 2 && dyn[0]! > 0) return (dyn[0]! + dyn[1]!) / 2;
    return fallback;
  };
  const rc = list('rc_rates');
  const rt = list('rates');
  const ex = list('rc_expo');
  const rollPID = list('rollPID');
  const pitchPID = list('pitchPID');
  const yawPID = list('yawPID');
  const ff = list('ff_weight');

  return makeLog(
    {
      source: `${source} [session ${session}, ${dec.craftName}]`,
      format: 'blackbox-csv',
      samples: timeS.length,
      sampleHz: timeS.length > 1 ? (timeS.length - 1) / duration : 1000,
      durationS: duration,
      assumptions,
      rates:
        rc.length === 3
          ? {
              // rates_type 2 is KISS, which is algebraically the same curve as
              // Betaflight's for ordinary expo values — checked against the
              // logged setpoint, which the Actual curve misses by 372 deg/s.
              type: 'betaflight',
              rcRate: [rc[0]!, rc[1]!, rc[2]!],
              rate: [rt[0]!, rt[1]!, rt[2]!],
              expo: [ex[0]!, ex[1]!, ex[2]!],
            }
          : undefined,
      pids:
        rollPID.length === 3
          ? {
              // Feedforward comes from ff_weight, which is a separate header
              // line rather than a fourth element of rollPID. Reading it as
              // zero left the model waiting for error to build before it did
              // anything, which showed up in the comparison as a response that
              // was both too soft and about 13 ms too late — on every axis, on
              // every flight.
              roll: { p: rollPID[0]!, i: rollPID[1]!, d: rollPID[2]!, f: ff[0] ?? 0 },
              pitch: { p: pitchPID[0]!, i: pitchPID[1]!, d: pitchPID[2]!, f: ff[1] ?? 0 },
              yaw: { p: yawPID[0]!, i: yawPID[1]!, d: yawPID[2]!, f: ff[2] ?? 0 },
              // A static cutoff of 0 does not mean "no filter", it means the
              // dynamic one is in charge; the real cutoff then lives in the
              // `_dyn_hz` pair and slides between them with throttle. Reading
              // the static field alone and falling back to a default had this
              // model filtering the gyro at 250 Hz while the aircraft was
              // running 500-1000 Hz — two to four times the phase lag, on the
              // signal the D-term differentiates.
              gyroLowpassHz: dynOrStatic('gyro_lpf1', 250),
              dtermLowpassHz: dynOrStatic('dterm_lpf1', 117),
              dtermLowpass2Hz: Number(H.get('dterm_lpf2_static_hz') ?? 0) || 0,
              itermRelaxHz: Number(H.get('iterm_relax_cutoff') ?? 15) || 15,
              feedforwardSmoothHz:
                list('rc_smoothing_active_cutoffs_ff_sp_thr')[0] || 125,
              itermLimit: 400,
              pidSumLimit: Number(H.get('pidsum_limit') ?? 500) || 500,
              pidSumLimitYaw: Number(H.get('pidsum_limit_yaw') ?? 400) || 400,
              tpaBreakpoint: (Number(H.get('tpa_breakpoint') ?? 1350) - 1000) / 1000,
              tpaRate: Number(H.get('tpa_rate') ?? 65) / 100,
              dMin: [list('d_min')[0] ?? 0, list('d_min')[1] ?? 0, list('d_min')[2] ?? 0],
              dMaxGain: Number(H.get('d_max_gain') ?? 37),
              dMaxAdvance: Number(H.get('d_max_advance') ?? 20),
              antiGravityGain: Number(H.get('anti_gravity_gain') ?? 0),
              antiGravityCutoffHz: Number(H.get('anti_gravity_cutoff_hz') ?? 5),
              antiGravityPGain: Number(H.get('anti_gravity_p_gain') ?? 100),
            }
          : undefined,
    },
    series,
  );
}

export function parseLog(text: string, source: string, opts: BlackboxOptions = {}): FlightLog {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) return parseSimJSON(text, source);
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (/rcCommand\[|loopIteration|time \(us\)/.test(firstLine)) {
    return parseBlackboxCSV(text, source, opts);
  }
  return parseSimCSV(text, source);
}
