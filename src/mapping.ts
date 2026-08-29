/**
 * Channel mapping: physical gamepad axis -> flight channel, with invert,
 * endpoints, centre and deadband. Persisted per device id.
 *
 * No physics here. This module's only job is raw axis value in, normalised
 * command out, deterministically.
 */

/**
 * Storage version. Bumped to 2 when the model adopted Betaflight's pitch
 * convention (positive is nose-down). See migrate(): the stored values did not
 * need changing, and the bump is there so the question is answered in code
 * rather than left to be re-derived.
 */
const STORAGE_VERSION = 3;

/**
 * Actions a pilot can bind to a switch, so the whole session runs from the
 * radio without touching the keyboard.
 */
export const AUX_ACTIONS = ['arm', 'reset'] as const;
export type AuxAction = (typeof AUX_ACTIONS)[number];

export const AUX_INFO: Record<AuxAction, { label: string; hint: string }> = {
  arm: {
    label: 'Arm',
    hint: 'Held on to fly, exactly as a flight controller does — flick it off in the air and you disarm in the air.',
  },
  reset: {
    label: 'Reset',
    hint: 'Momentary: respawns on the rising edge, so holding it does not respawn over and over.',
  },
};

/**
 * A switch, not a stick. Aux bindings are a different shape from AxisMap —
 * there is nothing to calibrate, no centre and no deadband — so they get their
 * own type rather than being forced through the proportional path.
 *
 * Both sources exist because radios disagree. EdgeTX in USB Joystick mode puts
 * switches on the spare *axes* (a TX16S reports 8, four of which are AETR), so
 * an axis reading -1/0/+1 is the common case; buttons are the fallback for
 * everything else.
 */
export interface AuxBinding {
  source: 'none' | 'axis' | 'button';
  index: number;
  /** Above this the switch counts as on. Axes only; buttons use 0.5. */
  threshold: number;
  invert: boolean;
}

export function defaultAux(): AuxBinding {
  return { source: 'none', index: -1, threshold: 0.5, invert: false };
}

/** Is this binding currently on? */
export function auxActive(
  b: AuxBinding,
  axes: readonly number[],
  buttons: readonly number[],
): boolean {
  if (b.source === 'none' || b.index < 0) return false;
  const raw = b.source === 'axis' ? axes[b.index] : buttons[b.index];
  if (raw === undefined || !Number.isFinite(raw)) return false;
  const on = raw > (b.source === 'button' ? 0.5 : b.threshold);
  return b.invert ? !on : on;
}

export const CHANNELS = ['throttle', 'roll', 'pitch', 'yaw'] as const;
export type Channel = (typeof CHANNELS)[number];

/** What "positive" means, and what the pilot is told to do when detecting. */
export const CHANNEL_INFO: Record<Channel, { label: string; positive: string; unipolar: boolean }> = {
  throttle: { label: 'Throttle', positive: 'throttle stick fully UP', unipolar: true },
  roll: { label: 'Roll', positive: 'roll stick fully RIGHT', unipolar: false },
  pitch: { label: 'Pitch', positive: 'pitch stick fully BACK (nose up)', unipolar: false },
  yaw: { label: 'Yaw', positive: 'yaw stick fully RIGHT', unipolar: false },
};

export interface AxisMap {
  /** Index into Gamepad.axes, or -1 when unassigned. */
  axis: number;
  invert: boolean;
  /** Raw endpoints captured during calibration. */
  min: number;
  max: number;
  /** Raw centre captured with sticks released. Ignored for throttle. */
  center: number;
  /** Deadband in normalised units, applied around centre. */
  deadband: number;
}

export type StickMode = 1 | 2 | 3 | 4;

export interface Mapping {
  /** See STORAGE_VERSION. Old values are migrated on load, not rejected. */
  version: number;
  deviceId: string;
  mode: StickMode;
  channels: Record<Channel, AxisMap>;
  aux: Record<AuxAction, AuxBinding>;
}

export function defaultAxisMap(): AxisMap {
  return { axis: -1, invert: false, min: -1, max: 1, center: 0, deadband: 0.02 };
}

/**
 * Preset axis order per stick mode, for radios that emit raw stick positions.
 *
 * Note: EdgeTX/OpenTX in USB Joystick mode normally applies the mode inside
 * the radio and emits channels in AETR order, so mode here is usually a
 * no-op. It exists for radios and mappings that do not.
 *
 * Physical axes assumed: 0 = left X, 1 = left Y, 2 = right X, 3 = right Y.
 */
/**
 * Pitch is inverted, like throttle, and for the same reason.
 *
 * A stick axis reads **negative** when pushed away from the pilot. Forward
 * stick must give a *positive* pitch command, because positive pitch is
 * nose-down. Negative axis to positive command is an inversion.
 *
 * I talked myself out of this once by reasoning that "stick away is negative
 * and nose-down is positive, so they already agree" — which has the arithmetic
 * exactly backwards and produced a default that flew you backwards. The check
 * that settles it is not a chain of reasoning: drive an axis to -1 through
 * computeCommands and fly the result, which tools/flight-check.ts now does.
 *
 * The presets are a guess in general: EdgeTX applies the stick mode in the
 * radio and emits AETR, so the axis numbers are frequently wrong too, and
 * Detect is the authoritative thing because it reads the direction the pilot
 * actually moved rather than assuming one.
 */
const MODE_PRESETS: Record<StickMode, Record<Channel, { axis: number; invert: boolean }>> = {
  // Mode 1: right = throttle/roll, left = pitch/yaw
  1: { throttle: { axis: 3, invert: true }, roll: { axis: 2, invert: false }, pitch: { axis: 1, invert: true }, yaw: { axis: 0, invert: false } },
  // Mode 2: left = throttle/yaw, right = pitch/roll  (the common one)
  2: { throttle: { axis: 1, invert: true }, roll: { axis: 2, invert: false }, pitch: { axis: 3, invert: true }, yaw: { axis: 0, invert: false } },
  // Mode 3: right = throttle/yaw, left = pitch/roll
  3: { throttle: { axis: 3, invert: true }, roll: { axis: 0, invert: false }, pitch: { axis: 1, invert: true }, yaw: { axis: 2, invert: false } },
  // Mode 4: left = throttle/roll, right = pitch/yaw
  4: { throttle: { axis: 1, invert: true }, roll: { axis: 0, invert: false }, pitch: { axis: 3, invert: true }, yaw: { axis: 2, invert: false } },
};

export function applyModePreset(mapping: Mapping, mode: StickMode): void {
  mapping.mode = mode;
  const preset = MODE_PRESETS[mode];
  for (const ch of CHANNELS) {
    const p = preset[ch];
    const m = mapping.channels[ch];
    m.axis = p.axis;
    m.invert = p.invert;
  }
}

export function newMapping(deviceId: string, mode: StickMode = 2): Mapping {
  const mapping: Mapping = {
    version: STORAGE_VERSION,
    deviceId,
    mode,
    channels: {
      throttle: defaultAxisMap(),
      roll: defaultAxisMap(),
      pitch: defaultAxisMap(),
      yaw: defaultAxisMap(),
    },
    aux: { arm: defaultAux(), reset: defaultAux() },
  };
  applyModePreset(mapping, mode);
  return mapping;
}

/**
 * Raw axis value -> command.
 * Throttle returns 0..1. Roll/pitch/yaw return -1..1.
 * Returns 0 (or 0 throttle) for an unassigned axis rather than guessing.
 */
export function normalise(map: AxisMap, raw: number | undefined, unipolar: boolean): number {
  if (map.axis < 0 || raw === undefined || !Number.isFinite(raw)) return 0;

  const lo = Math.min(map.min, map.max);
  const hi = Math.max(map.min, map.max);
  const span = hi - lo;
  if (span < 1e-6) return 0;

  const clamped = Math.min(hi, Math.max(lo, raw));

  if (unipolar) {
    let v = (clamped - lo) / span; // 0..1
    if (map.invert) v = 1 - v;
    if (v < map.deadband) v = 0;
    return v;
  }

  // Bipolar: split the travel either side of the captured centre so an
  // off-centre trim does not make one direction reach 1.0 before the other.
  const center = Math.min(hi, Math.max(lo, map.center));
  let v: number;
  if (clamped >= center) {
    const up = hi - center;
    v = up < 1e-6 ? 0 : (clamped - center) / up;
  } else {
    const down = center - lo;
    v = down < 1e-6 ? 0 : (clamped - center) / down;
  }
  if (map.invert) v = -v;

  const db = map.deadband;
  if (Math.abs(v) <= db) return 0;
  // Rescale so the command is continuous at the deadband edge.
  v = (v - Math.sign(v) * db) / (1 - db);
  return Math.min(1, Math.max(-1, v));
}

export interface Commands {
  throttle: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export function computeCommands(mapping: Mapping, axes: readonly number[]): Commands {
  const out = {} as Commands;
  for (const ch of CHANNELS) {
    out[ch] = normalise(mapping.channels[ch], axes[mapping.channels[ch].axis], CHANNEL_INFO[ch].unipolar);
  }
  return out;
}

// ---------------------------------------------------------------- persistence

const STORAGE_KEY = 'fpvsim.mappings.v1';

type Store = Record<string, Mapping>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Store;
  } catch {
    return {};
  }
}


function migrate(stored: Mapping & { version: number }): Mapping | null {
  if (stored.version === STORAGE_VERSION) return stored;
  if (stored.version === 2 || stored.version === 1) {
    // v3 added aux bindings. Absent means unbound, which is the same as a fresh
    // mapping, so an existing pilot keeps their four calibrated channels and
    // simply has nothing on their switches until they bind one.
    if (!stored.aux) {
      stored.aux = { arm: defaultAux(), reset: defaultAux() };
    }
    for (const a of AUX_ACTIONS) {
      stored.aux[a] = { ...defaultAux(), ...stored.aux[a] };
    }
  }
  if (stored.version === 1) {
    // No change to the stored values. Version 2 flipped the model's pitch
    // convention *and* the direction of the fix, and the two cancel: a pilot
    // who ticked invert by hand under v1 was compensating for the model, and
    // the same tick is now what the preset would have given them anyway. The
    // bump exists to record that this was considered rather than missed.
    stored.version = STORAGE_VERSION;
    return stored;
  }
  if (stored.version === 2) {
    stored.version = STORAGE_VERSION;
    return stored;
  }
  return null;
}

export function loadMapping(deviceId: string): Mapping | null {
  const raw = readStore()[deviceId];
  if (!raw) return null;
  const stored = migrate(raw as Mapping & { version: number });
  if (!stored) return null;
  // Fill any gaps rather than trusting the stored shape blindly.
  const mapping = newMapping(deviceId, stored.mode ?? 2);
  for (const ch of CHANNELS) {
    const s = stored.channels?.[ch];
    if (s) mapping.channels[ch] = { ...defaultAxisMap(), ...s };
  }
  for (const a of AUX_ACTIONS) {
    const s = stored.aux?.[a];
    if (s) mapping.aux[a] = { ...defaultAux(), ...s };
  }
  return mapping;
}

export function saveMapping(mapping: Mapping): void {
  try {
    const store = readStore();
    store[mapping.deviceId] = mapping;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota — the UI keeps working, just unpersisted */
  }
}

export function clearMapping(deviceId: string): void {
  try {
    const store = readStore();
    delete store[deviceId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}
