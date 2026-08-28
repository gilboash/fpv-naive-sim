/**
 * Turning a Blackbox header into a tune this model can fly.
 *
 * Shared by the log reader and by the UI's "load from a log" button, because
 * the mapping is fiddly enough that having two of it would guarantee they
 * drift: feedforward lives in its own `ff_weight` line rather than as a fourth
 * PID element, a filter cutoff of zero means the dynamic pair is in charge, and
 * the rate curve is named by an integer whose meaning is not obvious.
 */

import type { PidProfile } from './pid.ts';
import { defaultPids } from './pid.ts';
import type { RateProfile } from './rates.ts';
import { defaultRates } from './rates.ts';

export interface Tune {
  rates: RateProfile;
  pids: PidProfile;
  craftName: string;
  firmware: string;
}

/**
 * Betaflight's rates_type: 0 betaflight, 1 raceflight, 2 KISS, 3 actual,
 * 4 quick.
 *
 * KISS is its own curve, not a synonym for Betaflight's — an earlier version of
 * this mapped it onto Betaflight and the two only agree when expo is near zero.
 * Raceflight and Quick are not implemented and fall back to Betaflight, which is
 * flagged rather than silent.
 */
function rateTypeFrom(n: number): RateProfile['type'] {
  if (n === 3) return 'actual';
  if (n === 2) return 'kiss';
  return 'betaflight';
}

export function tuneFromHeader(H: Map<string, string>): Tune {
  const list = (k: string): number[] =>
    (H.get(k) ?? '')
      .split(',')
      .filter((x) => x.length > 0)
      .map(Number);
  const num = (k: string, fallback: number): number => {
    const v = Number(H.get(k));
    return Number.isFinite(v) ? v : fallback;
  };
  /** A static cutoff of zero means the dynamic pair is in charge. */
  const dynOrStatic = (prefix: string, fallback: number): number => {
    const stat = num(`${prefix}_static_hz`, 0);
    if (stat > 0) return stat;
    const dyn = list(`${prefix}_dyn_hz`);
    if (dyn.length === 2 && dyn[0]! > 0) return (dyn[0]! + dyn[1]!) / 2;
    return fallback;
  };

  const rc = list('rc_rates');
  const rt = list('rates');
  const ex = list('rc_expo');
  const rates: RateProfile =
    rc.length === 3 && rt.length === 3
      ? {
          type: rateTypeFrom(num('rates_type', 0)),
          rcRate: [rc[0]!, rc[1]!, rc[2]!],
          rate: [rt[0]!, rt[1]!, rt[2]!],
          expo: [ex[0] ?? 0, ex[1] ?? 0, ex[2] ?? 0],
        }
      : defaultRates();

  const roll = list('rollPID');
  const pitch = list('pitchPID');
  const yaw = list('yawPID');
  const ff = list('ff_weight');
  const dmin = list('d_min');
  const base = defaultPids();
  const pids: PidProfile =
    roll.length >= 3
      ? {
          roll: { p: roll[0]!, i: roll[1]!, d: roll[2]!, f: ff[0] ?? 0 },
          pitch: { p: pitch[0]!, i: pitch[1]!, d: pitch[2]!, f: ff[1] ?? 0 },
          yaw: { p: yaw[0]!, i: yaw[1]!, d: yaw[2]!, f: ff[2] ?? 0 },
          gyroLowpassHz: dynOrStatic('gyro_lpf1', base.gyroLowpassHz),
          dtermLowpassHz: dynOrStatic('dterm_lpf1', base.dtermLowpassHz),
          dtermLowpass2Hz: num('dterm_lpf2_static_hz', 0),
          itermRelaxHz: num('iterm_relax_cutoff', base.itermRelaxHz),
          itermLimit: base.itermLimit,
          itermWindupPercent: num('iterm_windup', 85),
          pidSumLimit: num('pidsum_limit', base.pidSumLimit),
          pidSumLimitYaw: num('pidsum_limit_yaw', base.pidSumLimitYaw),
          tpaBreakpoint: (num('tpa_breakpoint', 1350) - 1000) / 1000,
          tpaRate: num('tpa_rate', 65) / 100,
          dMin: [dmin[0] ?? 0, dmin[1] ?? 0, dmin[2] ?? 0],
          dMaxGain: num('d_max_gain', 37),
          dMaxAdvance: num('d_max_advance', 20),
          antiGravityGain: num('anti_gravity_gain', 0),
          antiGravityCutoffHz: num('anti_gravity_cutoff_hz', 5),
          antiGravityPGain: num('anti_gravity_p_gain', 100),
          feedforwardSmoothHz: list('rc_smoothing_active_cutoffs_ff_sp_thr')[0] || 125,
        }
      : base;

  return {
    rates,
    pids,
    craftName: H.get('Craft name') ?? '',
    firmware: H.get('Firmware revision') ?? '',
  };
}
