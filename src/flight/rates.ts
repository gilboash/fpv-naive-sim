/**
 * Stick position to angular-rate setpoint, in Betaflight's own curves.
 *
 * These are ported from Betaflight's src/main/fc/rc.c rather than approximated,
 * so a pilot can type the numbers off their own radio and get their own feel.
 * That is the whole point of a trainer: the muscle memory has to transfer.
 */

import { clamp } from './math.ts';

export type RateType = 'actual' | 'betaflight' | 'kiss';

/**
 * Rates in Betaflight's internal storage units, which are not the units a
 * configurator shows. The UI converts; nothing else should.
 *
 *   actual      rcRate x10 = centre sensitivity deg/s, rate x10 = max deg/s
 *   betaflight  rcRate/100 = RC rate, rate/100 = super rate
 *   kiss        rcRate/100 = RC rate, rate/100 = rate, expo/100 = RC curve
 *
 * In all three, expo/100 is the 0..1 figure on screen.
 */
export interface RateProfile {
  type: RateType;
  /** Per axis: roll, pitch, yaw. */
  rcRate: [number, number, number];
  /** Super rate, max rate, or KISS rate, depending on type. */
  rate: [number, number, number];
  /** Expo or RC curve, 0..100. */
  expo: [number, number, number];
}

export const AXIS_ROLL = 0;
export const AXIS_PITCH = 1;
export const AXIS_YAW = 2;

/**
 * Betaflight's default Actual Rates for a 5" — 200 deg/s around centre rising
 * to 800 deg/s at the stops. Fast enough to be a racing quad, not so fast that
 * a new pilot cannot find centre.
 */
export function defaultRates(): RateProfile {
  return {
    type: 'actual',
    rcRate: [20, 20, 20],
    rate: [80, 80, 80],
    expo: [54, 54, 54],
  };
}

const RC_RATE_INCREMENTAL = 14.54;

function applyActual(rcRate: number, rate: number, expoPct: number, cmd: number): number {
  const absCmd = Math.abs(cmd);
  const expof = expoPct / 100;
  const shaped = absCmd * (Math.pow(cmd, 5) * expof + cmd * (1 - expof));
  const centreSensitivity = rcRate * 10;
  const stickMovement = Math.max(0, rate * 10 - centreSensitivity);
  return cmd * centreSensitivity + stickMovement * shaped;
}

function applyBetaflight(rcRateIn: number, rate: number, expoPct: number, cmd: number): number {
  const absCmd = Math.abs(cmd);
  let c = cmd;
  if (expoPct) {
    const expof = expoPct / 100;
    c = c * Math.pow(absCmd, 3) * expof + c * (1 - expof);
  }
  let rcRate = rcRateIn / 100;
  if (rcRate > 2.0) rcRate += RC_RATE_INCREMENTAL * (rcRate - 2.0);
  let angleRate = 200 * rcRate * c;
  if (rate) {
    const superFactor = 1 / clamp(1 - absCmd * (rate / 100), 0.01, 1.0);
    angleRate *= superFactor;
  }
  return angleRate;
}

/**
 * KISS rates.
 *
 * Not the same curve as Betaflight's, which an earlier version of this file
 * claimed. They agree only when expo is near zero — which is exactly the case
 * on the quad it was checked against, expo 1 out of 100. With a real expo of 40
 * they are 8% apart at half stick, which is the difference between a pilot's
 * muscle memory transferring and not.
 *
 * Two differences: KISS shapes with cmd^3 where Betaflight uses cmd*|cmd|^3,
 * and KISS has no incremental boost above an RC rate of 2.
 */
function applyKiss(rcRate: number, rate: number, curvePct: number, cmd: number): number {
  const absCmd = Math.abs(cmd);
  const curve = curvePct / 100;
  const shaped = Math.pow(cmd, 3) * curve + cmd * (1 - curve);
  const useRates = 1 / clamp(1 - absCmd * (rate / 100), 0.01, 1.0);
  return 2000 * useRates * shaped * (rcRate / 1000);
}

/** Stick command in [-1,1] to setpoint in deg/s. */
export function applyRates(p: RateProfile, axis: number, cmd: number): number {
  const c = clamp(cmd, -1, 1);
  const rc = p.rcRate[axis]!;
  const rt = p.rate[axis]!;
  const ex = p.expo[axis]!;
  if (p.type === 'actual') return applyActual(rc, rt, ex, c);
  if (p.type === 'kiss') return applyKiss(rc, rt, ex, c);
  return applyBetaflight(rc, rt, ex, c);
}

/**
 * How a configurator shows each field, per rate type: label, and the factor to
 * multiply the stored value by for display.
 */
export const RATE_FIELDS: Record<
  RateType,
  { label: string; scale: number; unit: string; step: number }[]
> = {
  actual: [
    { label: 'Centre sens.', scale: 10, unit: '°/s', step: 10 },
    { label: 'Max rate', scale: 10, unit: '°/s', step: 10 },
    { label: 'Expo', scale: 0.01, unit: '', step: 0.01 },
  ],
  betaflight: [
    { label: 'RC rate', scale: 0.01, unit: '', step: 0.01 },
    { label: 'Super rate', scale: 0.01, unit: '', step: 0.01 },
    { label: 'RC expo', scale: 0.01, unit: '', step: 0.01 },
  ],
  kiss: [
    { label: 'RC rate', scale: 0.01, unit: '', step: 0.01 },
    { label: 'Rate', scale: 0.01, unit: '', step: 0.01 },
    { label: 'RC curve', scale: 0.01, unit: '', step: 0.01 },
  ],
};

/** Rate at full stick, for display and for sanity checks. */
export function maxRate(p: RateProfile, axis: number): number {
  return applyRates(p, axis, 1);
}
